/**
 * Storage - persistence, in two halves.
 *
 * 1. Progress (roster, teams, settings) in localStorage under `youBall_progress`,
 *    same shape and corrupt-data-starts-fresh behaviour as the other games.
 * 2. Uploaded part images in IndexedDB (`youBall_assets` / `parts`), keyed
 *    `${characterId}:${slot}`. Images live in IndexedDB rather than localStorage
 *    because localStorage is ~5-10MB and base64 inflates a blob by a third - a
 *    few photo parts per character would blow through it.
 *
 * Nothing here ever makes a network call. Real children's faces are involved;
 * the images stay on the device.
 *
 * IndexedDB is unavailable on a `file://` origin in Chrome. When the store
 * cannot open, every part read resolves to null and the game falls back to the
 * built-in illustrated parts rather than throwing. Serve over http for uploads.
 */
const Storage = (() => {
  const PROGRESS_KEY = 'youBall_progress';
  const DB_NAME = 'youBall_assets';
  const DB_VERSION = 1;
  const STORE = 'parts';

  let _db = null;
  let _dbFailed = false;
  let _openPromise = null;

  /** Live object URLs, keyed by part key, so they can all be revoked at once. */
  const _urls = new Map();

  /* ─── Progress (localStorage) ─── */

  /** A fresh save: no characters, two default teams, sound on. */
  function defaults() {
    return {
      roster: [],
      teams: [
        { colour: CONFIG.teamColours[0], players: [null, null, null, null] },
        { colour: CONFIG.teamColours[1], players: [null, null, null, null] },
      ],
      ballCustom: false,
      muted: false,
      difficulty: CONFIG.difficulty,
      twoPlayer: CONFIG.twoPlayer,
      nextId: 1,
    };
  }

  /**
   * Read the save. Corrupt or partial data starts fresh rather than throwing,
   * and missing keys are filled from defaults so an older save still loads.
   */
  function loadProgress() {
    const base = defaults();
    try {
      const raw = localStorage.getItem(PROGRESS_KEY);
      if (!raw) return base;
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return base;
      return Object.assign(base, data);
    } catch {
      return base;   /* corrupt save - start fresh */
    }
  }

  /**
   * Persist the save. A full disk or a private-mode quota error is swallowed:
   * losing a save is better than losing the match in progress.
   * @param {object} progress
   */
  function saveProgress(progress) {
    try {
      localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
    } catch { /* quota or private mode - the match carries on regardless */ }
  }

  /** Wipe the save and every stored part image. */
  async function resetAll() {
    try { localStorage.removeItem(PROGRESS_KEY); } catch { /* ignore */ }
    revokeAll();
    const db = await _open();
    if (!db) return;
    await _tx('readwrite', store => store.clear());
  }

  /* ─── Parts (IndexedDB) ─── */

  /**
   * Open the database once and cache it. Resolves to null when IndexedDB is
   * unavailable (file:// origin, private mode, blocked site data) - callers
   * treat that as "no custom parts" and use the built-in defaults.
   * @returns {Promise<IDBDatabase|null>}
   */
  function _open() {
    if (_db) return Promise.resolve(_db);
    if (_dbFailed) return Promise.resolve(null);
    if (_openPromise) return _openPromise;

    _openPromise = new Promise(resolve => {
      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch {
        _dbFailed = true;
        return resolve(null);
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => { _dbFailed = true; resolve(null); };
      req.onblocked = () => { _dbFailed = true; resolve(null); };
    });
    return _openPromise;
  }

  /**
   * Run one transaction against the parts store.
   * @param {'readonly'|'readwrite'} mode
   * @param {function(IDBObjectStore): IDBRequest|void} fn - receives the store,
   *   may return a request whose result becomes the resolved value
   * @returns {Promise<*>} the request result, or null if the store is unavailable
   */
  async function _tx(mode, fn) {
    const db = await _open();
    if (!db) return null;
    return new Promise(resolve => {
      let req;
      try {
        const tx = db.transaction(STORE, mode);
        req = fn(tx.objectStore(STORE));
        tx.onabort = () => resolve(null);
        tx.onerror = () => resolve(null);
        tx.oncomplete = () => resolve(req ? req.result : null);
      } catch {
        resolve(null);
      }
    });
  }

  /** Compose the store key for one slot of one character. */
  function partKey(characterId, slot) { return `${characterId}:${slot}`; }

  /**
   * Store one imported part image.
   * @param {string} key - from partKey()
   * @param {Blob} blob - PNG produced by the import pipeline
   * @returns {Promise<boolean>} false if storage was unavailable
   */
  async function putPart(key, blob) {
    _revoke(key);   /* the cached URL now points at a stale blob */
    const result = await _tx('readwrite', store => store.put(blob, key));
    return result !== null || !_dbFailed;
  }

  /**
   * Read one part image.
   * @param {string} key - from partKey()
   * @returns {Promise<Blob|null>}
   */
  function getPart(key) {
    return _tx('readonly', store => store.get(key));
  }

  /**
   * Remove one part image, reverting that slot to its built-in default.
   * @param {string} key - from partKey()
   */
  async function deletePart(key) {
    _revoke(key);
    await _tx('readwrite', store => store.delete(key));
  }

  /** Every key currently in the store, for cleanup and diagnostics. */
  async function allKeys() {
    const keys = await _tx('readonly', store => store.getAllKeys());
    return keys || [];
  }

  /* ─── Object URL lifecycle ─── */

  /*
   * Blobs are read once at match start and turned into object URLs; the URLs
   * are revoked when the match ends. Holding them any longer pins the decoded
   * image in memory for every character that ever appeared.
   */

  /**
   * Resolve part keys to object URLs, reusing any already live.
   * Keys with no stored blob are simply absent from the result, which is how
   * the caller learns to use the built-in default for that slot.
   * @param {string[]} keys
   * @returns {Promise<Object<string, string>>} key -> object URL
   */
  async function loadPartUrls(keys) {
    const out = {};
    const wanted = [...new Set(keys)];
    await Promise.all(wanted.map(async key => {
      if (_urls.has(key)) { out[key] = _urls.get(key); return; }
      const blob = await getPart(key);
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      _urls.set(key, url);
      out[key] = url;
    }));
    return out;
  }

  /** Revoke one cached URL. */
  function _revoke(key) {
    const url = _urls.get(key);
    if (!url) return;
    URL.revokeObjectURL(url);
    _urls.delete(key);
  }

  /** Revoke every live object URL. Call when a match or the editor ends. */
  function revokeAll() {
    for (const url of _urls.values()) URL.revokeObjectURL(url);
    _urls.clear();
  }

  /** True once an IndexedDB open has failed - the uploads UI warns on this. */
  function partsUnavailable() { return _dbFailed; }

  return {
    defaults, loadProgress, saveProgress, resetAll,
    partKey, putPart, getPart, deletePart, allKeys,
    loadPartUrls, revokeAll, partsUnavailable,
  };
})();
