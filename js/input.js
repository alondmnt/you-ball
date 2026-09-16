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
 *   hold  -> wind a power kick up, and shoot it on release
 *
 * The wind-up is the one accumulator both hands share: the shoot key on a
 * keyboard, a finger held still on a screen. "Still" means inside the dead
 * zone, so a finger that steered and came back to where it started counts -
 * you do not have to lift and press again to wind up. It also means you are
 * not steering while you wind up, which is the whole cost of the gesture, and
 * it is what stops a child who rests their thumb mid-run charging by accident.
 *
 * windUpMs belongs to the finger alone. A screen cannot tell a tap from a hold
 * until some time has passed, so it waits; a dedicated shoot key has nothing
 * to disambiguate and charges from the first frame.
 *
 * The joystick direction is converted through the pitch projection, so the
 * player runs toward where the finger is pointing on screen rather than toward
 * a world direction that looks wrong under the depth squash.
 */
const Input = (() => {
  const JOY_RADIUS = 72;      /* finger travel, in px, for full tilt */
  const SAMPLE_MS = 120;      /* flick velocity is measured over this window */
  const HOLD_POWER_FLOOR = 0.3;  /* the shot an uncharged stab still gets */

  /** One per seat. */
  function _seat() {
    return {
      mx: 0, my: 0,
      shootRequest: null,     /* {dx, dy, power} - dx/dy may be 0, meaning "use facing" */
      shootPressed: false,    /* the shoot control went down this frame */
      passRequest: false,
      tapRequest: false,      /* pass or switch, game.js decides which */
      keys: Object.create(null),
      shootDownAt: 0,       /* timeStamp the shoot key went down, 0 when up */
      canCharge: false,     /* whether a wind-up may accumulate at all */
      chargeFrom: 0,        /* timeStamp it was last allowed to start */
    };
  }

  /**
   * How far a hold has wound the kick up, 0..1.
   *
   * Straight from first contact, with no arming delay in it: windUpMs is only
   * the touch discriminator and has no business in the ramp. Leaving it here
   * meant the meter showed nothing for the first 240ms - over a third of the
   * hold - which is exactly the part a child needs to see to learn that
   * holding does anything at all. Both hands now reach the same power for the
   * same hold, and holdMaxMs is the one number that says how long a power kick
   * takes however you are playing.
   * @param {number} heldMs - how long the control has been down
   * @returns {number} 0..1
   */
  function _charge(heldMs) {
    return Math.max(0, Math.min(1, heldMs / Math.max(1, CONFIG.holdMaxMs)));
  }

  /**
   * The shot a charge buys. A stab is never nothing and a full wind-up is
   * everything, so the floor is what makes tapping shoot worth doing at all.
   * @param {number} c - charge, 0..1
   * @returns {number} power, 0..1
   */
  function _holdPower(c) { return HOLD_POWER_FLOOR + (1 - HOLD_POWER_FLOOR) * c; }

  /**
   * The charge a hold that began at `from` has reached, or 0 if this seat is
   * not allowed to wind up at all.
   *
   * chargeFrom is what stops a hold that started before the seat was allowed
   * counting toward the kick. Without it, holding the key down permanently
   * would arrive at the ball already at full power and the meter would mean
   * nothing.
   * @param {object} s - the seat
   * @param {number|null} from - timeStamp the hold began
   * @param {number} now - performance.now()
   * @returns {number} 0..1
   */
  function _chargeAt(s, from, now) {
    if (!s.canCharge || from == null) return 0;
    return _charge(now - Math.max(from, s.chargeFrom));
  }

  const seats = [_seat(), _seat()];

  /* Touch state for seat 0. */
  let _pointerId = null;
  let _origin = null;         /* {x, y, t} where the finger went down */
  let _samples = [];          /* recent {x, y, t} for flick detection */
  let _dragged = false;
  let _stillSince = null;     /* timeStamp the finger last settled in the dead
                                 zone, null while it is out steering */
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
    _stillSince = null;
    for (const s of seats) {
      s.mx = 0; s.my = 0;
      s.shootRequest = null; s.shootPressed = false;
      s.passRequest = false; s.tapRequest = false;
      s.keys = Object.create(null);
      s.shootDownAt = 0;
      s.canCharge = false; s.chargeFrom = 0;
    }
  }

  /* ─── Touch / mouse ─── */

  function _onDown(e) {
    if (!_enabled || _pointerId !== null) return;
    _pointerId = e.pointerId;
    _origin = { x: e.clientX, y: e.clientY, t: e.timeStamp };
    _samples = [{ x: e.clientX, y: e.clientY, t: e.timeStamp }];
    _dragged = false;
    _stillSince = e.timeStamp;
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
    if (px < CONFIG.dragDeadZonePx) {
      seats[0].mx = 0; seats[0].my = 0;
      /* Back in the dead zone: the wind-up starts now, not when the finger
         first went down, so steering away from a charge really does drop it. */
      if (_stillSince == null) _stillSince = e.timeStamp;
      return;
    }

    _dragged = true;
    _stillSince = null;
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
    } else if (_stillSince != null && e.timeStamp - _stillSince >= CONFIG.windUpMs) {
      /* A wind-up: held still long enough to mean it. Direction comes from
         nothing, because a still finger is not pointing anywhere - game.js
         falls back to the player's facing. */
      const c = _chargeAt(s, _stillSince, e.timeStamp);
      s.shootRequest = { dx: 0, dy: 0, power: _holdPower(c), charge: c, held: true };
    } else if (!_dragged) {
      s.tapRequest = true;
    }

    _pointerId = null; _origin = null; _samples = []; _dragged = false;
    _stillSince = null;
    /* Fall back to whatever keys are still held rather than zeroing outright. */
    _syncKeyAxes(s);
  }

  function _onCancel(e) {
    if (e.pointerId !== _pointerId) return;
    _pointerId = null; _origin = null; _samples = []; _dragged = false;
    _stillSince = null;
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
   * @param {boolean} [keeper] - this seat is keeping goal, so shoot dives
   * @returns {string} HTML
   */
  function legendHtml(i, keeper) {
    const l = LEGEND[i];
    if (!l) return '';
    return `<kbd>${l.move}</kbd> run` +
           (keeper ? ` <kbd>${l.shoot}</kbd> dive` : ` <kbd>${l.shoot}</kbd> shoot (hold it)`) +
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
    /* The press matters on its own, not just the release: a keeper dives on it,
       and a shot is on the goal line in well under half a second. */
    if (hit.action === 'shoot') { s.shootDownAt = e.timeStamp; s.shootPressed = true; }
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
      const c = _chargeAt(s, e.timeStamp - held, e.timeStamp);
      s.shootRequest = { dx: s.mx, dy: s.my, power: _holdPower(c), charge: c, held: true };
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

  /**
   * How far a seat has wound its kick up right now, 0..1.
   *
   * Live, unlike shootRequest, which only exists for the one frame after a
   * release - this is what the ball's charge ring reads every frame while the
   * player is still holding on, so it reports only what the player would
   * actually get if they let go now.
   * @param {number} i - seat index
   * @param {number} now - performance.now(), the clock pointer events use
   * @returns {number} 0..1
   */
  function charge(i, now) {
    const s = seats[i];
    if (!s) return 0;
    if (s.shootDownAt) return _chargeAt(s, s.shootDownAt, now);
    /* Only seat 0 has a finger; seat 1 is keyboard by definition. A finger
       that has not passed windUpMs might still be a tap, so there is no charge
       to promise and the meter stays dark - it would be showing power the
       player is about to not get. What the gesture shoots once it does commit
       still counts from first contact; see _onUp. */
    if (i === 0 && _pointerId !== null && _stillSince != null &&
        now - _stillSince >= CONFIG.windUpMs) return _chargeAt(s, _stillSince, now);
    return 0;
  }

  /**
   * Whether a seat may wind a kick up at all.
   *
   * game.js calls this every step with whether the seat has the ball. Input
   * still knows nothing about teams or possession - only that this seat may
   * charge now, which is the same shape as setEnabled. Turning it on restarts
   * the clock, so walking onto the ball with the key already down buys you
   * nothing and the wind-up stays a thing you spend possession on.
   * @param {number} i - seat index
   * @param {boolean} on
   * @param {number} now - performance.now()
   */
  function setCharging(i, on, now) {
    const s = seats[i];
    if (!s || s.canCharge === on) return;
    s.canCharge = on;
    if (on) s.chargeFrom = now;
  }

  /** Clear a seat's one-shot requests after the game has acted on them. */
  function clearRequests(i) {
    const s = seats[i];
    s.shootRequest = null;
    s.shootPressed = false;
    s.passRequest = false;
    s.tapRequest = false;
  }

  /** How many seats are live. Two only when two-player is switched on. */
  function seatCount() { return CONFIG.twoPlayer ? 2 : 1; }

  return { init, setEnabled, reset, seat, charge, setCharging, clearRequests, seatCount, legendHtml };
})();
