/**
 * Input - turns a finger or a keyboard into intents.
 *
 * A "seat" is a human player, not a pitch player: seat 0 is touch and the arrow
 * keys, seat 1 is WASD for the two-player game. Which pitch player a seat is
 * driving is decided by game.js (auto-switch), so nothing here needs to know
 * about teams or possession.
 *
 * Touch, one finger:
 *   drag  -> relative joystick from wherever the finger went down
 *   flick -> shoot along the flick, power from how fast it left
 *   tap   -> pass if you have the ball, otherwise switch to whoever is nearest it
 *
 * The joystick direction is converted through the pitch projection, so the
 * player runs toward where the finger is pointing on screen rather than toward
 * a world direction that looks wrong under the depth squash.
 */
const Input = (() => {
  const JOY_RADIUS = 72;      /* finger travel, in px, for full tilt */
  const SAMPLE_MS = 120;      /* flick velocity is measured over this window */

  /** One per seat. */
  function _seat() {
    return {
      mx: 0, my: 0,
      shootRequest: null,     /* {dx, dy, power} - dx/dy may be 0, meaning "use facing" */
      passRequest: false,
      tapRequest: false,      /* pass or switch, game.js decides which */
      keys: Object.create(null),
      shootDownAt: 0,
    };
  }

  const seats = [_seat(), _seat()];

  /* Touch state for seat 0. */
  let _pointerId = null;
  let _origin = null;         /* {x, y, t} where the finger went down */
  let _samples = [];          /* recent {x, y, t} for flick detection */
  let _dragged = false;
  let _enabled = true;

  /**
   * Bind listeners.
   * @param {HTMLElement} surface - the element that receives the gestures
   */
  function init(surface) {
    surface.addEventListener('pointerdown', _onDown);
    surface.addEventListener('pointermove', _onMove);
    surface.addEventListener('pointerup', _onUp);
    surface.addEventListener('pointercancel', _onCancel);
    window.addEventListener('keydown', _onKeyDown);
    window.addEventListener('keyup', _onKeyUp);
    /* A key held when the tab loses focus would otherwise stick down. */
    window.addEventListener('blur', reset);
  }

  /** Stop reading input (menus, celebrations, full time). */
  function setEnabled(on) {
    _enabled = on;
    if (!on) reset();
  }

  /** Drop all held state. */
  function reset() {
    _pointerId = null; _origin = null; _samples = []; _dragged = false;
    for (const s of seats) {
      s.mx = 0; s.my = 0;
      s.shootRequest = null; s.passRequest = false; s.tapRequest = false;
      s.keys = Object.create(null);
      s.shootDownAt = 0;
    }
  }

  /* ─── Touch / mouse ─── */

  function _onDown(e) {
    if (!_enabled || _pointerId !== null) return;
    _pointerId = e.pointerId;
    _origin = { x: e.clientX, y: e.clientY, t: e.timeStamp };
    _samples = [{ x: e.clientX, y: e.clientY, t: e.timeStamp }];
    _dragged = false;
    if (e.currentTarget.setPointerCapture) {
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    }
  }

  function _onMove(e) {
    if (e.pointerId !== _pointerId || !_origin) return;
    _samples.push({ x: e.clientX, y: e.clientY, t: e.timeStamp });
    while (_samples.length > 2 && e.timeStamp - _samples[0].t > SAMPLE_MS) _samples.shift();

    const dx = e.clientX - _origin.x;
    const dy = e.clientY - _origin.y;
    const px = Math.hypot(dx, dy);
    if (px < CONFIG.dragDeadZonePx) { seats[0].mx = 0; seats[0].my = 0; return; }

    _dragged = true;
    const tilt = Math.min(1, px / JOY_RADIUS);
    const w = Pitch.screenToWorldDelta(dx, dy);
    const wlen = Math.hypot(w.dx, w.dy) || 1;
    seats[0].mx = w.dx / wlen * tilt;
    seats[0].my = w.dy / wlen * tilt;
  }

  function _onUp(e) {
    if (e.pointerId !== _pointerId) return;
    const s = seats[0];
    const first = _samples[0];
    const dt = e.timeStamp - (first ? first.t : e.timeStamp);
    const dx = e.clientX - (first ? first.x : e.clientX);
    const dy = e.clientY - (first ? first.y : e.clientY);
    const px = Math.hypot(dx, dy);

    if (_dragged && dt > 0 && dt < CONFIG.flickMaxMs && px > CONFIG.flickMinPx) {
      /* A flick: shoot along it, power from how fast the finger left. */
      const speed = px / (dt / 1000);
      const w = Pitch.screenToWorldDelta(dx, dy);
      const wlen = Math.hypot(w.dx, w.dy) || 1;
      s.shootRequest = {
        dx: w.dx / wlen,
        dy: w.dy / wlen,
        power: Math.max(0.25, Math.min(1, (speed - 380) / 2400)),
      };
    } else if (!_dragged) {
      s.tapRequest = true;
    }

    _pointerId = null; _origin = null; _samples = []; _dragged = false;
    /* Fall back to whatever keys are still held rather than zeroing outright. */
    _syncKeyAxes(s);
  }

  function _onCancel(e) {
    if (e.pointerId !== _pointerId) return;
    _pointerId = null; _origin = null; _samples = []; _dragged = false;
    _syncKeyAxes(seats[0]);
  }

  /* ─── Keyboard ─── */

  /*
   * Seat 0: arrows, space to shoot (hold for power), shift to pass.
   * Seat 1: WASD, F to shoot, G to pass. Two key sets is the whole of local
   * two-player, because input is intent-based and physics does not care who
   * produced an intent.
   */
  const KEYMAP = [
    { up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'],
      shoot: [' ', 'Spacebar'], pass: ['Shift', 'ShiftLeft', 'ShiftRight'] },
    { up: ['w', 'W'], down: ['s', 'S'], left: ['a', 'A'], right: ['d', 'D'],
      shoot: ['f', 'F'], pass: ['g', 'G'] },
  ];

  /*
   * What to print for each seat. It sits next to the bindings deliberately:
   * changing a key without changing its label is then obviously wrong, and the
   * on-screen legend can never quietly disagree with what the keys do.
   */
  const LEGEND = [
    { move: '\u2190 \u2191 \u2193 \u2192', shoot: 'space', pass: 'shift' },
    { move: 'W A S D', shoot: 'F', pass: 'G' },
  ];

  /* Actions only - the other KEYMAP fields would confuse the lookup below. */
  const ACTIONS = ['up', 'down', 'left', 'right', 'shoot', 'pass'];

  /** Which seat and action a key belongs to, or null. */
  function _lookup(key) {
    const limit = CONFIG.twoPlayer ? 2 : 1;
    for (let i = 0; i < limit; i++) {
      for (const action of ACTIONS) {
        if (KEYMAP[i][action].includes(key)) return { seat: i, action };
      }
    }
    return null;
  }

  /**
   * The keys for one seat, as markup ready to drop into the splash or the
   * editor. Keeping this here rather than in each screen is what stops the two
   * legends drifting apart from each other or from the bindings.
   * @param {number} i - seat index
   * @returns {string} HTML
   */
  function legendHtml(i) {
    const l = LEGEND[i];
    if (!l) return '';
    return `<kbd>${l.move}</kbd> run` +
           ` <kbd>${l.shoot}</kbd> shoot` +
           ` <kbd>${l.pass}</kbd> pass`;
  }

  function _onKeyDown(e) {
    if (!_enabled) return;
    const hit = _lookup(e.key);
    if (!hit) return;
    e.preventDefault();
    const s = seats[hit.seat];
    if (s.keys[hit.action]) return;          /* ignore auto-repeat */
    s.keys[hit.action] = true;
    if (hit.action === 'shoot') s.shootDownAt = e.timeStamp;
    if (hit.action === 'pass') s.passRequest = true;
    _syncKeyAxes(s);
  }

  function _onKeyUp(e) {
    const hit = _lookup(e.key);
    if (!hit) return;
    const s = seats[hit.seat];
    s.keys[hit.action] = false;
    if (hit.action === 'shoot' && s.shootDownAt) {
      const held = e.timeStamp - s.shootDownAt;
      s.shootDownAt = 0;
      /* Direction comes from whatever is held; zero means "use facing". */
      s.shootRequest = {
        dx: s.mx, dy: s.my,
        power: Math.max(0.3, Math.min(1, held / CONFIG.holdMaxMs)),
      };
    }
    _syncKeyAxes(s);
  }

  /** Recompute a seat's move axes from its held keys. */
  function _syncKeyAxes(s) {
    const x = (s.keys.right ? 1 : 0) - (s.keys.left ? 1 : 0);
    /* Screen up is toward the far touchline, which is +y in world space. */
    const y = (s.keys.up ? 1 : 0) - (s.keys.down ? 1 : 0);
    if (x || y) {
      const len = Math.hypot(x, y);
      s.mx = x / len; s.my = y / len;
    } else if (_pointerId === null) {
      /* Nothing held and no finger down. Note pointerId 0 is a valid id, so
         this has to be an explicit null check. */
      s.mx = 0; s.my = 0;
    }
  }

  /**
   * Read a seat's current state. The caller consumes the one-shot requests with
   * clearRequests() once it has acted on them.
   * @param {number} i - seat index
   * @returns {object}
   */
  function seat(i) { return seats[i]; }

  /** Clear a seat's one-shot requests after the game has acted on them. */
  function clearRequests(i) {
    const s = seats[i];
    s.shootRequest = null;
    s.passRequest = false;
    s.tapRequest = false;
  }

  /** How many seats are live. Two only when two-player is switched on. */
  function seatCount() { return CONFIG.twoPlayer ? 2 : 1; }

  return { init, setEnabled, reset, seat, clearRequests, seatCount, legendHtml };
})();
