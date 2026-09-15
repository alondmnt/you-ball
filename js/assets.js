/**
 * Assets - the slot table, the built-in illustrated parts, and the pipeline
 * that turns an uploaded photo or drawing into a stored part image.
 *
 * SLOTS is the contract between the editor (which frame you crop into) and the
 * rig (which frame it renders in). Both read it, so an imported image can never
 * be a different aspect from the frame it lands in.
 *
 * Every part is an `<img>` whose src is either an object URL from IndexedDB or
 * a data-URI SVG generated here. Keeping the two interchangeable is what stops
 * character.js from branching on "custom or default" anywhere.
 */
const Assets = (() => {

  /* ─── Slots ─── */

  /*
   * fallback is walked until a stored image is found, so a character with only
   * head_idle uploaded still has a GOAL face and a sad face (the same one), and
   * a character with only `arm` uploaded has two matching arms.
   */
  const SLOTS = {
    head_idle: { w: 44, h: 44, icon: '🙂', label: 'face' },
    head_goal: { w: 44, h: 44, icon: '🎉', label: 'GOAL face', fallback: 'head_idle' },
    head_sad:  { w: 44, h: 44, icon: '😢', label: 'sad face',  fallback: 'head_idle' },
    torso:     { w: 40, h: 52, icon: '👕', label: 'body' },
    arm:       { w: 14, h: 44, icon: '💪', label: 'arms' },
    leg:       { w: 16, h: 48, icon: '🦵', label: 'legs' },
    arm_l:     { w: 14, h: 44, icon: '💪', label: 'left arm',  fallback: 'arm', extra: true },
    arm_r:     { w: 14, h: 44, icon: '💪', label: 'right arm', fallback: 'arm', extra: true },
    leg_l:     { w: 16, h: 48, icon: '🦵', label: 'left leg',  fallback: 'leg', extra: true },
    leg_r:     { w: 16, h: 48, icon: '🦵', label: 'right leg', fallback: 'leg', extra: true },
    ball:      { w: 40, h: 40, icon: '⚽', label: 'the ball' },
  };

  /** The slots the editor offers by default. The `extra: true` ones are the
   *  asymmetric overrides, shown only when the player asks for them. */
  const MAIN_SLOTS = ['head_idle', 'head_goal', 'head_sad', 'torso', 'arm', 'leg'];
  const EXTRA_SLOTS = ['arm_l', 'arm_r', 'leg_l', 'leg_r'];

  /*
   * The paper doll, in character-local pixels. The character box is 100 x 140
   * with the feet at the bottom centre, which is the point the renderer places
   * on the pitch.
   *
   * `origin` is the pivot every animation rotates about: neck for the head,
   * shoulder for arms, hip for legs.
   *
   * The arm pivots sit just inside the torso frame, at x 32 and 68. They used
   * to sit outside it, which is invisible while the arms hang down but makes
   * them appear to fly off the body in any pose that swings them out - the
   * stumble, the dive and the goal celebration all showed it. The built-in
   * torso is narrower at the shoulders than its frame, and an uploaded one
   * fills the frame, so these land between the two.
   */
  const CHAR_W = 100, CHAR_H = 140;
  const RIG = [
    { part: 'leg_l', slot: 'leg_l', x: 32, y: 92, w: 16, h: 48, z: 1, origin: '50% 0%' },
    { part: 'leg_r', slot: 'leg_r', x: 52, y: 92, w: 16, h: 48, z: 2, origin: '50% 0%' },
    { part: 'arm_l', slot: 'arm_l', x: 25, y: 48, w: 14, h: 44, z: 1, origin: '50% 0%' },
    { part: 'torso', slot: 'torso', x: 30, y: 42, w: 40, h: 52, z: 3, origin: '50% 100%' },
    { part: 'arm_r', slot: 'arm_r', x: 61, y: 48, w: 14, h: 44, z: 4, origin: '50% 0%' },
    /* The head is three stacked images - one per face. CSS shows one at a time,
       so a goal never waits on an image decode to change expression. */
    { part: 'head', slot: 'head_idle', x: 28, y: 0, w: 44, h: 44, z: 5, origin: '50% 100%',
      faces: { idle: 'head_idle', goal: 'head_goal', sad: 'head_sad' } },
  ];

  /**
   * Walk a slot's fallback chain against a set of available custom slots.
   * @param {string} slot
   * @param {Object<string, boolean>} have - the character's custom slot flags
   * @returns {string|null} the slot whose stored image should be used, or null
   */
  function resolveSlot(slot, have) {
    let s = slot;
    while (s) {
      if (have && have[s]) return s;
      s = SLOTS[s] && SLOTS[s].fallback;
    }
    return null;
  }

  /** Every slot key a character might need loaded from IndexedDB. */
  function allSlotKeys() { return Object.keys(SLOTS).filter(s => s !== 'ball'); }

  /* ─── Built-in illustrated parts ─── */

  const HEAD_VARIANTS = [
    { skin: '#f6c9a0', hair: '#4a2c17', style: 'bowl' },
    { skin: '#8d5524', hair: '#1f1209', style: 'curly' },
    { skin: '#ffdbac', hair: '#d4820a', style: 'spiky' },
    { skin: '#e0ac69', hair: '#2e2e34', style: 'long' },
    { skin: '#fce0c8', hair: '#c94f3d', style: 'freckles' },
    { skin: '#c68642', hair: '#f2f2f2', style: 'cap' },
  ];

  /** Wrap SVG source as a data URI. */
  function _uri(svg) {
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  }

  /** Hair, cap and freckles for one head variant. */
  function _hair(v) {
    switch (v.style) {
      case 'curly':
        return `<path d="M7 24A15 15 0 0 1 37 24Z" fill="${v.hair}"/>` +
          [10, 15.5, 22, 28.5, 34].map((x, i) =>
            `<circle cx="${x}" cy="${[19, 13.5, 11.5, 13.5, 19][i]}" r="4.4" fill="${v.hair}"/>`).join('');
      case 'spiky':
        return `<path d="M7 24A15 15 0 0 1 37 24Z" fill="${v.hair}"/>` +
          `<path d="M9 18l2-7 4 6 4-8 4 8 4-6 2 7z" fill="${v.hair}"/>`;
      case 'long':
        return `<path d="M7 24A15 15 0 0 1 37 24Z" fill="${v.hair}"/>` +
          `<path d="M7 22q-1 12 1 16h4V22zM37 22q1 12-1 16h-4V22z" fill="${v.hair}"/>`;
      case 'cap':
        return `<path d="M7 23A15 15 0 0 1 37 23Z" fill="${v.hair}"/>` +
          `<rect x="20" y="20" width="20" height="4" rx="2" fill="${v.hair}"/>` +
          `<circle cx="22" cy="9" r="2" fill="${v.hair}"/>`;
      case 'freckles':
        return `<path d="M8 23A14 14 0 0 1 36 23q-3-5-14-5T8 23Z" fill="${v.hair}"/>` +
          [[14, 27], [17, 29], [27, 29], [30, 27]].map(([x, y]) =>
            `<circle cx="${x}" cy="${y}" r="0.9" fill="#b9714f"/>`).join('');
      default:
        return `<path d="M7 24A15 15 0 0 1 37 24Z" fill="${v.hair}"/>`;
    }
  }

  /** Eyes, brows and mouth for one expression. */
  function _face(expr) {
    const ink = '#2b2b2b', lip = '#8a3b2c';
    if (expr === 'goal') {
      return `<path d="M12 24q4-5 8 0M24 24q4-5 8 0" stroke="${ink}" stroke-width="2.2" fill="none" stroke-linecap="round"/>` +
        `<path d="M11 17.5q5-3 9-1M24 16.5q4-2 9 1" stroke="${ink}" stroke-width="1.6" fill="none" stroke-linecap="round"/>` +
        `<ellipse cx="22" cy="32" rx="6.5" ry="5.5" fill="#6d221c"/>` +
        `<ellipse cx="22" cy="35" rx="3.6" ry="2.2" fill="#e8657a"/>`;
    }
    if (expr === 'sad') {
      return `<circle cx="16" cy="24.5" r="2" fill="${ink}"/><circle cx="28" cy="24.5" r="2" fill="${ink}"/>` +
        `<path d="M11.5 19.5q4.5 2 8 3.5M32.5 19.5q-4.5 2-8 3.5" stroke="${ink}" stroke-width="1.6" fill="none" stroke-linecap="round"/>` +
        `<path d="M16 34.5q6-5 12 0" stroke="${lip}" stroke-width="2.2" fill="none" stroke-linecap="round"/>` +
        `<path d="M13 27q2 3 0 4.5-2-1.5 0-4.5Z" fill="#7ec8f0"/>`;
    }
    return `<circle cx="16" cy="24" r="2.2" fill="${ink}"/><circle cx="28" cy="24" r="2.2" fill="${ink}"/>` +
      `<path d="M16 31q6 4.5 12 0" stroke="${lip}" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;
  }

  /**
   * A built-in head.
   * @param {number} variant - index into HEAD_VARIANTS
   * @param {'idle'|'goal'|'sad'} expr
   * @returns {string} data URI
   */
  function defaultHead(variant, expr) {
    const v = HEAD_VARIANTS[((variant | 0) % HEAD_VARIANTS.length + HEAD_VARIANTS.length) % HEAD_VARIANTS.length];
    return _uri(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44">` +
      `<circle cx="6.5" cy="26" r="3.2" fill="${v.skin}"/><circle cx="37.5" cy="26" r="3.2" fill="${v.skin}"/>` +
      `<circle cx="22" cy="24" r="15" fill="${v.skin}" stroke="rgba(0,0,0,.16)" stroke-width="1"/>` +
      _hair(v) + _face(expr) +
      `</svg>`);
  }

  /**
   * A built-in torso in the team colour.
   * @param {string} colour - team colour
   * @returns {string} data URI
   */
  function defaultTorso(colour) {
    return _uri(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 52">` +
      `<path d="M4 8q6-5 16-5t16 5v34a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4Z" fill="${colour}" stroke="rgba(0,0,0,.2)" stroke-width="1.2"/>` +
      `<path d="M14 3q6 7 12 0 4 1 6 3-8 8-24 0 2-2 6-3Z" fill="rgba(255,255,255,.85)"/>` +
      `<rect x="4" y="30" width="32" height="4" fill="rgba(255,255,255,.25)"/>` +
      `</svg>`);
  }

  /**
   * A built-in arm: sleeve in the team colour, then skin, then a hand.
   * @param {string} colour - team colour
   * @returns {string} data URI
   */
  function defaultArm(colour) {
    return _uri(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 44">` +
      `<rect x="1.5" y="0" width="11" height="34" rx="5.5" fill="#f0c49c" stroke="rgba(0,0,0,.18)" stroke-width="1"/>` +
      `<path d="M1.5 5.5A5.5 5.5 0 0 1 12.5 5.5V15H1.5Z" fill="${colour}"/>` +
      `<circle cx="7" cy="37" r="5.5" fill="#f0c49c" stroke="rgba(0,0,0,.18)" stroke-width="1"/>` +
      `</svg>`);
  }

  /**
   * A built-in leg: shorts, skin, then a boot.
   * @param {string} colour - team colour
   * @returns {string} data URI
   */
  function defaultLeg(colour) {
    return _uri(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 48">` +
      `<rect x="2" y="0" width="12" height="34" rx="5" fill="#f0c49c" stroke="rgba(0,0,0,.18)" stroke-width="1"/>` +
      `<path d="M2 0h12v12H2Z" fill="${colour}" opacity="0.92"/>` +
      `<rect x="2" y="26" width="12" height="7" fill="rgba(255,255,255,.7)"/>` +
      `<path d="M1 36h12a3 3 0 0 1 3 3v4a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2Z" fill="#232733"/>` +
      `</svg>`);
  }

  /** The built-in ball. */
  function defaultBall() {
    return _uri(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">` +
      `<circle cx="20" cy="20" r="18.5" fill="#fdfdfd" stroke="#c9ccd1" stroke-width="1.4"/>` +
      `<path d="M20 9l6.5 4.7-2.5 7.6h-8l-2.5-7.6Z" fill="#23262d"/>` +
      `<path d="M8 17l4 6-3 5.5a18.5 18.5 0 0 1-2.4-8Z" fill="#23262d"/>` +
      `<path d="M32 17l-4 6 3 5.5a18.5 18.5 0 0 0 2.4-8Z" fill="#23262d"/>` +
      `<path d="M15 33l2-5h6l2 5a18.5 18.5 0 0 1-10 0Z" fill="#23262d"/>` +
      `</svg>`);
  }

  /**
   * The built-in image for one rig part.
   * @param {string} part - 'head' | 'torso' | 'arm_l' | 'arm_r' | 'leg_l' | 'leg_r'
   * @param {object} character - roster record (supplies the head variant)
   * @param {string} colour - team colour
   * @param {'idle'|'goal'|'sad'} [expr] - only meaningful for the head
   * @returns {string} data URI
   */
  function defaultPart(part, character, colour, expr) {
    switch (part) {
      case 'head':  return defaultHead(character ? character.head : 0, expr || 'idle');
      case 'torso': return defaultTorso(colour);
      case 'arm_l':
      case 'arm_r': return defaultArm(colour);
      case 'leg_l':
      case 'leg_r': return defaultLeg(colour);
      default:      return defaultTorso(colour);
    }
  }

  /* ─── Import pipeline ─── */

  /*
   * file -> Image -> canvas at the slot's aspect -> crop to the frame ->
   * downscale to partMaxPx on the long side -> optional paper mode -> PNG blob.
   *
   * 256px is plenty at match scale and keeps 8 characters x 8 slots small
   * enough to decode without a hitch at kickoff.
   */

  /**
   * Decode a picked file into an Image.
   * @param {File} file
   * @returns {Promise<HTMLImageElement>}
   */
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('could not read that picture')); };
      img.src = url;
    });
  }

  /**
   * The export canvas size for a slot: the slot's aspect, scaled so the long
   * side is CONFIG.partMaxPx.
   * @param {string} slot
   * @returns {{w: number, h: number}}
   */
  function frameSize(slot) {
    const s = SLOTS[slot] || SLOTS.torso;
    const k = CONFIG.partMaxPx / Math.max(s.w, s.h);
    return { w: Math.round(s.w * k), h: Math.round(s.h * k) };
  }

  /**
   * The view that fits an image inside a slot frame, covering it completely.
   * This is the starting position the adjust screen opens with.
   * @param {HTMLImageElement} img
   * @param {string} slot
   * @returns {{x: number, y: number, scale: number}} centre offset and zoom,
   *   in frame-relative units (0,0 = the image centred in the frame)
   */
  function fitView(img, slot) {
    const f = frameSize(slot);
    const scale = Math.max(f.w / img.naturalWidth, f.h / img.naturalHeight);
    return { x: 0, y: 0, scale };
  }

  /**
   * Draw an image into a slot frame at the given view.
   * @param {HTMLImageElement} img
   * @param {string} slot
   * @param {{x: number, y: number, scale: number}} view
   * @param {boolean} paperMode - knock out white-ish paper behind a drawing
   * @param {HTMLCanvasElement} [canvas] - reuse a canvas (the live preview does)
   * @returns {HTMLCanvasElement}
   */
  function renderCrop(img, slot, view, paperMode, canvas) {
    const f = frameSize(slot);
    const c = canvas || document.createElement('canvas');
    c.width = f.w; c.height = f.h;
    const ctx = c.getContext('2d', { willReadFrequently: !!paperMode });
    ctx.clearRect(0, 0, f.w, f.h);
    ctx.imageSmoothingQuality = 'high';

    const dw = img.naturalWidth * view.scale;
    const dh = img.naturalHeight * view.scale;
    ctx.drawImage(img, (f.w - dw) / 2 + view.x, (f.h - dh) / 2 + view.y, dw, dh);

    if (paperMode) applyPaperMode(ctx, f.w, f.h);
    return c;
  }

  /**
   * Paper mode - a threshold pass that turns the white page behind a crayon
   * drawing transparent. Cheap and effective for pen or crayon on white paper;
   * off by default because it eats the highlights in a photo.
   *
   * The feather band below the threshold keeps the cut-out edge from going
   * jagged, which a hard cut does badly on a phone photo of a drawing.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} w
   * @param {number} h
   */
  function applyPaperMode(ctx, w, h) {
    const T = CONFIG.paperThreshold;
    const FEATHER = 30;
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      /* Rec. 601 luma - close enough, and one multiply cheaper than 709. */
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (lum >= T) {
        d[i + 3] = 0;
      } else if (lum > T - FEATHER) {
        d[i + 3] = Math.round(d[i + 3] * (T - lum) / FEATHER);
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  /**
   * Canvas to PNG blob. PNG rather than JPEG because parts need alpha - both
   * paper mode and any crop that doesn't fill the frame depend on it.
   * @param {HTMLCanvasElement} canvas
   * @returns {Promise<Blob>}
   */
  function toBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('could not save that picture')), 'image/png');
    });
  }

  return {
    SLOTS, MAIN_SLOTS, EXTRA_SLOTS, RIG, CHAR_W, CHAR_H, HEAD_VARIANTS,
    resolveSlot, allSlotKeys,
    defaultHead, defaultTorso, defaultArm, defaultLeg, defaultBall, defaultPart,
    loadImage, frameSize, fitView, renderCrop, applyPaperMode, toBlob,
  };
})();
