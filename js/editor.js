/**
 * Editor - build characters from your own pictures, put them in teams.
 *
 * Kid-first, so it is almost entirely pictures: tap a character, tap a slot,
 * pick a photo, drag and pinch until it sits right, tap the tick. The character
 * runs on the spot the whole time you are editing it, wearing what you have
 * given it so far.
 *
 * Nothing leaves the device. There is no share button and no upload, because
 * the pictures are of real children. Parts go into IndexedDB, roster and team
 * metadata into localStorage.
 */
const Editor = (() => {
  const BALL_ID = '__ball';   /* the ball is a slot too, on its own pseudo-character */

  let _progress = null;
  let _urls = {};
  let _selected = null;       /* roster character id being edited */
  let _showExtras = false;
  let _preview = null;        /* the live-running rig */
  let _onPlay = null;
  let _pendingSlot = null;    /* slot awaiting a file pick */

  /* Adjust-overlay state. */
  let _adj = null;            /* { img, slot, view, paper, canvas } */
  const _pointers = new Map();
  let _pinchStart = 0, _pinchScale = 1, _dragFrom = null;

  /**
   * Bind the editor once.
   * @param {function} onPlay - called when the player taps play
   */
  function init(onPlay) {
    _onPlay = onPlay;
    document.getElementById('editor-back').addEventListener('click', () => { Audio.play('tap'); onPlay(); });
    document.getElementById('editor-play').addEventListener('click', () => { Audio.play('tap'); onPlay(); });
    document.getElementById('file-input').addEventListener('change', _onFilePicked);
    document.getElementById('adjust-cancel').addEventListener('click', _closeAdjust);
    document.getElementById('adjust-ok').addEventListener('click', _commitAdjust);
    document.getElementById('adjust-paper').addEventListener('click', _togglePaper);
    _bindAdjustGestures();
  }

  /**
   * Show the editor.
   * @param {object} progress - the live save, mutated in place
   */
  async function open(progress) {
    _progress = progress;
    if (!_progress.roster.length) _addCharacter(false);
    if (!_selected || !_find(_selected)) _selected = _progress.roster[0].id;
    await _refreshUrls();
    render();
  }

  /** Re-read every part URL the editor needs. */
  async function _refreshUrls() {
    const keys = [];
    for (const c of _progress.roster) {
      for (const slot of Assets.allSlotKeys()) keys.push(Storage.partKey(c.id, slot));
    }
    keys.push(Storage.partKey(BALL_ID, 'ball'));
    _urls = await Storage.loadPartUrls(keys);
  }

  /** Find a roster record. */
  function _find(id) { return _progress.roster.find(c => c.id === id) || null; }

  /**
   * Add a character to the roster.
   * @param {boolean} [select] - make it the one being edited
   * @returns {object} the new record
   */
  function _addCharacter(select) {
    const id = 'c' + (_progress.nextId++);
    const record = {
      id,
      name: '',
      /* A random built-in head, so a brand new character already has a face. */
      head: Math.floor(Math.random() * Assets.HEAD_VARIANTS.length),
      slots: {},
    };
    _progress.roster.push(record);
    /* Fill an empty team place so a fresh save is playable immediately. Field
       places first: both keepers are always AI, so a character parked in goal
       is one the kid never gets to be. */
    for (const team of _progress.teams) {
      const gap = [1, 2, 3, 0].find(i => team.players[i] == null);
      if (gap !== undefined) team.players[gap] = id;
    }
    if (select !== false) _selected = id;
    Storage.saveProgress(_progress);
    return record;
  }

  /* ─── Rendering ─── */

  /** Rebuild the whole editor body. */
  function render() {
    const body = document.getElementById('editor-body');
    if (!body) return;
    body.innerHTML = `
      <div class="ed__roster" id="ed-roster"></div>
      <div class="ed__main">
        <div class="ed__stage" id="ed-stage"></div>
        <div class="ed__slots" id="ed-slots"></div>
      </div>
      <div class="ed__teams" id="ed-teams"></div>
    `;
    _renderRoster();
    _renderStage();
    _renderSlots();
    _renderTeams();
  }

  /** The strip of characters, plus the button that makes a new one. */
  function _renderRoster() {
    const host = document.getElementById('ed-roster');
    host.innerHTML = '';
    for (const c of _progress.roster) {
      const card = document.createElement('button');
      card.className = 'ed__card' + (c.id === _selected ? ' ed__card--on' : '');
      card.type = 'button';
      const img = document.createElement('img');
      img.src = Character.faceSrc(c, 'idle', _teamColourOf(c.id), _urls);
      img.alt = '';
      card.appendChild(img);
      card.addEventListener('click', () => {
        Audio.play('tap');
        _selected = c.id;
        render();
      });
      host.appendChild(card);
    }

    const add = document.createElement('button');
    add.className = 'ed__card ed__card--add';
    add.type = 'button';
    add.textContent = '+';
    add.setAttribute('aria-label', 'new character');
    add.addEventListener('click', () => { Audio.play('confirm'); _addCharacter(true); render(); });
    host.appendChild(add);

    const del = document.createElement('button');
    del.className = 'ed__card ed__card--del';
    del.type = 'button';
    del.textContent = '🗑';
    del.setAttribute('aria-label', 'delete this character');
    del.addEventListener('click', _deleteSelected);
    host.appendChild(del);
  }

  /** The live preview: the selected character running on the spot. */
  function _renderStage() {
    const stage = document.getElementById('ed-stage');
    stage.innerHTML = '';
    const record = _find(_selected);
    if (!record) return;
    _preview = Character.create({
      record, colour: _teamColourOf(record.id), urls: _urls, badge: false,
    });
    _preview.setAnim('run');
    stage.appendChild(_preview.el);

    /* Tapping the preview cycles the face, so the three faces are discoverable
       without any text telling the kid they exist. */
    const faces = ['idle', 'goal', 'sad'];
    let fi = 0;
    stage.addEventListener('click', () => {
      fi = (fi + 1) % faces.length;
      _preview.setFace(faces[fi]);
      _preview.setAnim(faces[fi] === 'goal' ? 'celebrate' : faces[fi] === 'sad' ? 'sad-dance' : 'run');
      Audio.play('tap');
    });
  }

  /** One chip per slot. A chip with a custom picture gets a clear button. */
  function _renderSlots() {
    const host = document.getElementById('ed-slots');
    host.innerHTML = '';
    const record = _find(_selected);
    if (!record) return;

    const slots = Assets.MAIN_SLOTS.concat(_showExtras ? Assets.EXTRA_SLOTS : []);
    for (const slot of slots) {
      const def = Assets.SLOTS[slot];
      const has = !!record.slots[slot];
      const chip = document.createElement('div');
      chip.className = 'ed__chip' + (has ? ' ed__chip--set' : '');

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ed__chip-btn';
      btn.title = def.label;
      btn.setAttribute('aria-label', def.label);
      btn.innerHTML = `<span class="ed__chip-icon">${def.icon}</span>`;
      btn.addEventListener('click', () => _pickFor(slot));
      chip.appendChild(btn);

      if (has) {
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'ed__chip-clear';
        clear.textContent = '✕';
        clear.setAttribute('aria-label', 'remove ' + def.label);
        clear.addEventListener('click', async () => {
          await Storage.deletePart(Storage.partKey(record.id, slot));
          delete record.slots[slot];
          Storage.saveProgress(_progress);
          await _refreshUrls();
          render();
        });
        chip.appendChild(clear);
      }
      host.appendChild(chip);
    }

    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'ed__more' + (_showExtras ? ' ed__more--on' : '');
    more.textContent = _showExtras ? '−' : '…';
    more.setAttribute('aria-label', 'left and right parts separately');
    more.addEventListener('click', () => { _showExtras = !_showExtras; _renderSlots(); });
    host.appendChild(more);
  }

  /** The two team strips, the colour pickers, the ball, and the match settings. */
  function _renderTeams() {
    const host = document.getElementById('ed-teams');
    host.innerHTML = '';

    for (let t = 0; t < 2; t++) {
      const team = _progress.teams[t];
      const row = document.createElement('div');
      row.className = 'ed__team';
      row.style.setProperty('--team-colour', team.colour);

      for (const colour of CONFIG.teamColours.concat(['#ffd166', '#06d6a0', '#9b5de5', '#f15bb5'])) {
        const sw = document.createElement('button');
        sw.type = 'button';
        sw.className = 'ed__swatch' + (colour === team.colour ? ' ed__swatch--on' : '');
        sw.style.background = colour;
        sw.setAttribute('aria-label', 'team colour');
        sw.addEventListener('click', () => {
          team.colour = colour;
          Storage.saveProgress(_progress);
          Audio.play('tap');
          render();
        });
        row.appendChild(sw);
      }

      for (let i = 0; i < 4; i++) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'ed__slotcell' + (i === 0 ? ' ed__slotcell--gk' : '');
        const rec = _find(team.players[i]);
        if (rec) {
          const img = document.createElement('img');
          img.src = Character.faceSrc(rec, 'idle', team.colour, _urls);
          img.alt = '';
          cell.appendChild(img);
        } else {
          cell.textContent = '+';
        }
        /* Tap a team place to put the character you are editing into it. */
        cell.addEventListener('click', () => {
          team.players[i] = _selected;
          Storage.saveProgress(_progress);
          Audio.play('confirm');
          render();
        });
        row.appendChild(cell);
      }
      host.appendChild(row);
    }

    const extras = document.createElement('div');
    extras.className = 'ed__extras';

    const ball = document.createElement('button');
    ball.type = 'button';
    ball.className = 'ed__ball';
    ball.setAttribute('aria-label', 'the ball');
    const ballImg = document.createElement('img');
    ballImg.src = _urls[Storage.partKey(BALL_ID, 'ball')] || Assets.defaultBall();
    ballImg.alt = '';
    ball.appendChild(ballImg);
    ball.addEventListener('click', () => _pickFor('ball', BALL_ID));
    extras.appendChild(ball);

    /* Difficulty: three faces, no words. */
    const diffs = [['easy', '🙂'], ['normal', '😀'], ['hard', '😈']];
    for (const [key, icon] of diffs) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ed__toggle' + (_progress.difficulty === key ? ' ed__toggle--on' : '');
      b.textContent = icon;
      b.setAttribute('aria-label', key);
      b.addEventListener('click', () => {
        _progress.difficulty = key;
        CONFIG.difficulty = key;
        Storage.saveProgress(_progress);
        Audio.play('tap');
        render();
      });
      extras.appendChild(b);
    }

    /* Two-player: one on the screen, one on the keyboard. */
    const two = document.createElement('button');
    two.type = 'button';
    two.className = 'ed__toggle ed__toggle--wide' + (_progress.twoPlayer ? ' ed__toggle--on' : '');
    two.textContent = _progress.twoPlayer ? '👤👤' : '👤';
    two.setAttribute('aria-label', 'two players');
    two.addEventListener('click', () => {
      _progress.twoPlayer = !_progress.twoPlayer;
      CONFIG.twoPlayer = _progress.twoPlayer;
      Storage.saveProgress(_progress);
      Audio.play('tap');
      render();
    });
    extras.appendChild(two);

    host.appendChild(extras);

    if (Storage.partsUnavailable()) {
      const warn = document.createElement('div');
      warn.className = 'ed__warn';
      warn.textContent = 'pictures cannot be saved from a file:// page — serve the folder over http';
      host.appendChild(warn);
    }
  }

  /** The colour a character shows in, taken from whichever team it plays for. */
  function _teamColourOf(id) {
    for (const team of _progress.teams) {
      if (team.players.includes(id)) return team.colour;
    }
    return _progress.teams[0].colour;
  }

  /** Remove the selected character from the roster, its parts and its teams. */
  async function _deleteSelected() {
    const record = _find(_selected);
    if (!record || _progress.roster.length <= 1) return;
    for (const slot of Object.keys(record.slots)) {
      await Storage.deletePart(Storage.partKey(record.id, slot));
    }
    _progress.roster = _progress.roster.filter(c => c.id !== record.id);
    for (const team of _progress.teams) {
      team.players = team.players.map(id => (id === record.id ? _progress.roster[0].id : id));
    }
    _selected = _progress.roster[0].id;
    Storage.saveProgress(_progress);
    await _refreshUrls();
    Audio.play('tap');
    render();
  }

  /* ─── Import ─── */

  /**
   * Open the picker for a slot. On a tablet this offers the camera.
   * @param {string} slot
   * @param {string} [characterId] - defaults to the selected character
   */
  function _pickFor(slot, characterId) {
    _pendingSlot = { slot, id: characterId || _selected };
    const input = document.getElementById('file-input');
    input.value = '';         /* so picking the same file twice still fires */
    input.click();
  }

  async function _onFilePicked(e) {
    const file = e.target.files && e.target.files[0];
    if (!file || !_pendingSlot) return;
    try {
      const img = await Assets.loadImage(file);
      _openAdjust(img, _pendingSlot.slot, _pendingSlot.id);
    } catch (err) {
      _pendingSlot = null;
      alert(err.message || 'could not read that picture');
    }
  }

  /* ─── Adjust: drag to position, pinch or wheel to scale ─── */

  function _openAdjust(img, slot, id) {
    _pointers.clear();
    _pinchStart = 0; _dragFrom = null;
    const canvas = document.getElementById('adjust-canvas');
    _adj = { img, slot, id, view: Assets.fitView(img, slot), paper: false, canvas };
    const frame = Assets.frameSize(slot);
    /* Keep the on-screen frame the slot's aspect, whatever the slot is. */
    const box = document.querySelector('.adjust__frame');
    box.style.aspectRatio = `${frame.w} / ${frame.h}`;
    document.getElementById('adjust-paper').setAttribute('aria-pressed', 'false');
    document.getElementById('adjust-paper').classList.remove('btn--on');
    document.getElementById('adjust').classList.remove('overlay--hidden');
    _drawAdjust();
  }

  function _drawAdjust() {
    if (!_adj) return;
    Assets.renderCrop(_adj.img, _adj.slot, _adj.view, _adj.paper, _adj.canvas);
  }

  function _togglePaper() {
    if (!_adj) return;
    _adj.paper = !_adj.paper;
    const btn = document.getElementById('adjust-paper');
    btn.setAttribute('aria-pressed', String(_adj.paper));
    btn.classList.toggle('btn--on', _adj.paper);
    Audio.play('tap');
    _drawAdjust();
  }

  function _closeAdjust() {
    _adj = null;
    _pendingSlot = null;
    _pointers.clear();
    document.getElementById('adjust').classList.add('overlay--hidden');
  }

  async function _commitAdjust() {
    if (!_adj) return;
    const { slot, id } = _adj;
    const canvas = Assets.renderCrop(_adj.img, slot, _adj.view, _adj.paper);
    const blob = await Assets.toBlob(canvas);
    await Storage.putPart(Storage.partKey(id, slot), blob);

    if (id === BALL_ID) {
      _progress.ballCustom = true;
    } else {
      const record = _find(id);
      if (record) record.slots[slot] = true;
    }
    Storage.saveProgress(_progress);
    _closeAdjust();
    await _refreshUrls();
    Audio.play('confirm');
    render();
  }

  /** Drag pans the picture; two fingers or the wheel scale it. */
  function _bindAdjustGestures() {
    const frame = document.querySelector('.adjust__frame');
    if (!frame) return;

    frame.addEventListener('pointerdown', e => {
      if (!_adj) return;
      frame.setPointerCapture(e.pointerId);
      _pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (_pointers.size === 1) _dragFrom = { x: e.clientX, y: e.clientY, vx: _adj.view.x, vy: _adj.view.y };
      if (_pointers.size === 2) { _pinchStart = _pinchDistance(); _pinchScale = _adj.view.scale; }
    });

    frame.addEventListener('pointermove', e => {
      if (!_adj || !_pointers.has(e.pointerId)) return;
      _pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (_pointers.size >= 2 && _pinchStart > 0) {
        const ratio = _pinchDistance() / _pinchStart;
        _adj.view.scale = Math.max(0.05, Math.min(12, _pinchScale * ratio));
      } else if (_dragFrom) {
        /* The canvas is drawn at frame resolution but shown larger, so a finger
           pixel is worth more than a canvas pixel. */
        const k = Assets.frameSize(_adj.slot).w / frame.getBoundingClientRect().width;
        _adj.view.x = _dragFrom.vx + (e.clientX - _dragFrom.x) * k;
        _adj.view.y = _dragFrom.vy + (e.clientY - _dragFrom.y) * k;
      }
      _drawAdjust();
    });

    const release = e => {
      _pointers.delete(e.pointerId);
      if (_pointers.size < 2) _pinchStart = 0;
      if (_pointers.size === 0) _dragFrom = null;
    };
    frame.addEventListener('pointerup', release);
    frame.addEventListener('pointercancel', release);

    frame.addEventListener('wheel', e => {
      if (!_adj) return;
      e.preventDefault();
      _adj.view.scale = Math.max(0.05, Math.min(12, _adj.view.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
      _drawAdjust();
    }, { passive: false });
  }

  /** Distance between the first two active pointers. */
  function _pinchDistance() {
    const [a, b] = [..._pointers.values()];
    return Math.hypot(b.x - a.x, b.y - a.y) || 1;
  }

  return { init, open, BALL_ID };
})();
