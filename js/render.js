/**
 * Render - reads world and match state, writes transforms, classes and the
 * score bar. Nothing writes back: this module is the only one that touches
 * match DOM, which is what makes physics, ai and match swappable behind a
 * different renderer.
 *
 * Every animation state is derived from the world each frame rather than
 * remembered here. A player is kicking because their kickAt is recent, not
 * because something started a timer. That keeps the DOM a pure function of
 * the state and makes a pause or a rewind free.
 */
const Render = (() => {
  const CW = Assets.CHAR_W, CH = Assets.CHAR_H;

  /*
   * Base pixel sizes, set on the element once. Everything after is transform
   * only, so nothing in the per-frame loop can trigger a layout.
   */
  const BALL_BASE = CONFIG.ballDrawD;
  const SHADOW_W = CONFIG.ballDrawD * 0.8;
  const SHADOW_H = CONFIG.ballDrawD * 0.26;
  const PIT_BASE = 30;

  /** Write z-index only when it changes; it is a paint, not a free property. */
  function _setZ(el, z) {
    if (el._z === z) return;
    el._z = z;
    el.style.zIndex = z;
  }

  let _rigs = [];       /* one per player id */
  let _ball = null;     /* { el, shadow } */
  let _teams = null;    /* [{ colour, chars: [record x4] }, …] */
  let _urls = {};
  let _els = {};        /* cached UI elements */
  let _faceChar = [];   /* which character speaks for each team in the score bar */
  let _lastScore = [-1, -1];
  let _lastClock = '';
  let _trailAt = 0;
  const _runFxAt = [];   /* per player, world.t of their last run effect */

  /* Scene effects are decoration; someone who asked for less motion gets none. */
  const _calmly = typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false;

  const RUN_FX_SPEED = 170;   /* world units a second before a player kicks up anything */
  const RUN_FX_EVERY = 0.30;  /* seconds between one player's run effects */
  const RUN_FX_MAX = 2;       /* emitters per frame, across everyone */

  /**
   * Build the match DOM.
   * @param {object} world
   * @param {Array<object>} teams - [{ colour, chars: [record, …] }, …]
   * @param {Object<string, string>} urls - part key -> object URL
   * @param {string} [ballSrc] - custom ball image, if there is one
   */
  function mount(world, teams, urls, ballSrc) {
    unmount();
    _teams = teams;
    _urls = urls || {};
    _els = {
      scoreFace: [document.getElementById('score-face-0'), document.getElementById('score-face-1')],
      scoreNum: [document.getElementById('score-num-0'), document.getElementById('score-num-1')],
      clock: document.getElementById('clock'),
      banner: document.getElementById('banner'),
      bannerText: document.getElementById('banner-text'),
      crowd: document.getElementById('crowd'),
    };

    const layer = Pitch.worldLayer();
    for (const p of world.players) {
      const team = teams[p.team];
      const rig = Character.create({
        record: team.chars[p.index],
        colour: team.colour,
        urls: _urls,
        badge: true,
      });
      rig.el.classList.add('ch--team-' + p.team);
      layer.appendChild(rig.el);
      _rigs[p.id] = rig;
    }

    const el = document.createElement('img');
    el.className = 'ball';
    el.src = ballSrc || Assets.defaultBall();
    el.alt = '';
    el.style.width = BALL_BASE + 'px';
    el.style.height = BALL_BASE + 'px';
    const shadow = document.createElement('div');
    shadow.className = 'ball__shadow';
    shadow.style.width = SHADOW_W + 'px';
    shadow.style.height = SHADOW_H + 'px';
    layer.appendChild(shadow);
    layer.appendChild(el);
    _ball = { el, shadow };

    /* Each team's face in the score bar. */
    for (let t = 0; t < 2; t++) {
      _faceChar[t] = _teamFace(teams[t]);
      const face = _els.scoreFace[t];
      if (!face) continue;
      face.style.setProperty('--team-colour', teams[t].colour);
      face.innerHTML = '<img alt="">';
    }
    _lastScore = [-1, -1];
    _lastClock = '';

    const loose = (CONFIG.fx || {}).loose;
    if (loose) { _buildPit(loose); _pitWatch = []; }
  }

  /**
   * Which character speaks for a team in the score bar.
   *
   * Prefer one the player actually made a face for. Picking a fixed place
   * meant the kid's own face could be sitting in goal while the bar showed a
   * built-in head, and the score bar is where the faces do their job.
   * @param {object} team
   * @returns {object} a roster record
   */
  function _teamFace(team) {
    return team.chars.find(c => c && c.slots && c.slots.head_idle) || team.chars[1] || team.chars[0];
  }

  /** Tear the match DOM down. */
  function unmount() {
    for (const rig of _rigs) if (rig) rig.destroy();
    _rigs = [];
    for (const b of _pit) b.el.remove();
    _pit = [];
    _pitWatch = null;
    if (_ball) { _ball.el.remove(); _ball.shadow.remove(); _ball = null; }
    const fx = Pitch.fxLayer();
    if (fx) fx.innerHTML = '';
  }

  /**
   * Which animation a player's current state implies.
   * @param {object} p
   * @param {object} world
   * @param {object} match
   * @param {string} [prev] - what this player is playing now, for the run
   *   threshold's hysteresis. Without it the state flaps frame by frame.
   * @returns {string} a Character animation name
   */
  function animFor(p, world, match, prev) {
    if (match.phase === Match.PHASE.GOAL) {
      /* Everybody dances. The conceding team dances too, just sadly. */
      return match.scorer === p.team ? 'celebrate' : 'sad-dance';
    }
    if (match.phase === Match.PHASE.FULLTIME) {
      if (match.winner === null) return 'idle';
      return match.winner === p.team ? 'celebrate' : 'sad';
    }
    /* Stunned first: a tackled player cannot be doing anything else. */
    if (p.stunUntil > world.t) return 'stumble';
    if (world.t - p.tackleAt < 0.30) return 'tackle';
    if (p.role === 'gk' && p.diveUntil > world.t) return 'dive';
    if (world.t - p.kickAt < 0.34) return 'kick';
    /* Easier to keep running than to start: one threshold makes a player
       coasting to a stop stutter between the two. */
    const speed = Math.hypot(p.vx, p.vy);
    const bar = prev === 'run' ? CONFIG.runExitSpeed : CONFIG.runEnterSpeed;
    return speed > bar ? 'run' : 'idle';
  }

  /**
   * Draw one frame.
   * @param {object} world
   * @param {object} match
   * @param {Set<number>} [controlled] - player ids a human is driving
   * @param {number} [dt] - seconds since the last frame, for the loose balls
   */
  function frame(world, match, controlled, dt) {
    if (!_ball) return;   /* unmounted between a frame being queued and run */
    const L = Pitch.layout();
    if (_pit.length) {
      _watchPitCost(dt || 1 / 60, match.phase === Match.PHASE.PLAY);
      _stepPit(world, Math.min(0.05, dt || 1 / 60), L);
    }
    const runFx = _calmly ? null : EMITTERS[(CONFIG.fx || {}).run];
    let runFxLeft = RUN_FX_MAX;   /* capped per frame: eight players kicking up
                                     dust continuously is noise, not atmosphere */

    for (const p of world.players) {
      const rig = _rigs[p.id];
      if (!rig) continue;
      const q = Pitch.project(p.x, p.y);

      if (runFx && runFxLeft > 0) {
        const speed = Math.hypot(p.vx, p.vy);
        if (speed > RUN_FX_SPEED && world.t - (_runFxAt[p.id] || -9) > RUN_FX_EVERY) {
          _runFxAt[p.id] = world.t;
          /* Scaled down: running should whisper, kicking should shout. */
          runFx(q.sx, q.sy, q.scale, Math.min(1, speed / CONFIG.playerSpeed) * 0.45);
          runFxLeft--;
        }
      }
      const s = L.charScale * q.scale;
      const flip = p.facing < 0 ? ' scaleX(-1)' : '';
      rig.el.style.transform =
        `translate3d(${q.sx - CW / 2}px,${q.sy - CH}px,0) scale(${s})${flip}`;
      rig.el.style.zIndex = q.z;
      if (p.role === 'gk') rig.setDiveDir(p.diveDir);
      rig.setAnim(animFor(p, world, match, rig.getAnim()));
      rig.el.classList.toggle('ch--mine', !!controlled && controlled.has(p.id));
    }

    const b = world.ball;
    const q = Pitch.project(b.x, b.y);
    /*
     * Depth is a scale in the transform, never a width and height.
     * Writing width/height every frame forces a layout every frame, which on
     * an older tablet is the single most expensive thing this loop did.
     * Elements are built at their base size once and only transformed after.
     */
    const k = L.zoom * q.scale;
    const size = BALL_BASE * k;
    /* A scene can float the ball; in the pool it reads immediately as bobbing. */
    const bob = (CONFIG.fx || {}).ballBob
      ? Math.sin(world.t * 4.2) * CONFIG.fx.ballBob * L.zoom * q.scale : 0;
    /* Scale is about the element's centre, so place the centre and let it be. */
    const cy = q.sy - size * 0.42 - bob;
    _ball.el.style.transform =
      `translate3d(${q.sx - BALL_BASE / 2}px,${cy - BALL_BASE / 2}px,0) scale(${k}) rotate(${b.x * 0.6}deg)`;
    _ball.shadow.style.transform =
      `translate3d(${q.sx - SHADOW_W / 2}px,${q.sy - SHADOW_H / 2}px,0) scale(${k})`;
    _setZ(_ball.el, q.z + 1);
    _setZ(_ball.shadow, q.z);

    /* A trail on a hard shot - a few fading clones behind the ball. */
    const speed = Math.hypot(b.vx, b.vy);
    if (speed > CONFIG.trailMinSpeed && world.t - _trailAt > 0.03) {
      _trailAt = world.t;
      _spawnTrail(q.sx, q.sy - size * 0.92, size);
    }

    _scoreBar(match);
  }

  /** Update the score bar only when something in it changed. */
  function _scoreBar(match) {
    for (let t = 0; t < 2; t++) {
      if (match.score[t] !== _lastScore[t]) {
        _lastScore[t] = match.score[t];
        if (_els.scoreNum[t]) _els.scoreNum[t].textContent = match.score[t];
      }
      const face = _els.scoreFace[t];
      if (!face) continue;
      const img = face.firstElementChild;
      const mood = Match.teamMood(match, t);
      if (img && img.dataset.mood !== mood) {
        img.dataset.mood = mood;
        img.src = Character.faceSrc(_faceChar[t], mood, _teams[t].colour, _urls);
        face.classList.remove('score__face--pop');
        void face.offsetWidth;
        face.classList.add('score__face--pop');
      }
    }
    const text = Match.clockText(match);
    if (text !== _lastClock) {
      _lastClock = text;
      if (_els.clock) _els.clock.textContent = text;
    }
  }

  /* ─── Loose balls (the ball pool floor) ─── */

  /*
   * Balls that lie on the pitch, get shoved aside by anyone who runs through
   * them, and drift back to where they were.
   *
   * Deliberately not in physics.js. They never touch possession, the match
   * ball or a player's movement - the wading is already in the ball pool's
   * tuned speed and friction. Keeping them here means the whole feature
   * cannot affect a match result, and the pure seam stays pure.
   *
   * The cost control is that a ball at rest is skipped entirely: no maths and
   * no DOM write. Only the handful someone is currently disturbing cost
   * anything, so a still pitch is free.
   */
  const PIT_R = 15;            /* world units, matching the painted floor */
  const PIT_PUSH = 2900;       /* how hard a player displaces one */
  const PIT_BALL_PUSH = 5600;  /* the match ball hits harder */
  const PIT_NEIGHBOUR = 380;   /* a moving ball nudges the ones around it */
  /*
   * Only a ball actually travelling passes the nudge on. Without this the
   * chain never dies: a ball drifting home nudges its neighbours, they nudge
   * back, and the whole pit shimmers forever instead of settling behind
   * whoever ran through it.
   */
  const PIT_SOURCE_SPEED = 55;
  /*
   * How far that nudge carries. Contact distance would be PIT_R * 2, but at
   * this density the balls sit about 110 units apart and would essentially
   * never touch, so propagation did nothing. This is a sloshing radius rather
   * than a collision one - it is decoration, and what it has to do is spread.
   */
  const PIT_NEIGHBOUR_R = 110;
  const PIT_WAKE = 1.7;        /* a player's reach, as a multiple of contact */
  const PIT_SPRING = 2.5;      /* pull back toward home */
  const PIT_DAMP = 0.905;
  const PIT_REST = 4;          /* below this speed and offset, treat it as settled */
  const PIT_COLOURS = ['#ef476f', '#ffd166', '#06d6a0', '#4cc9f0', '#b388eb'];

  let _pit = [];

  /*
   * Older tablets feel 190 loose balls. Rather than guess a number that suits
   * every device, watch the first stretch of real play and thin the pit once
   * if the frame rate is not holding up. One-shot, so it costs nothing after
   * it has decided, and it can only ever remove balls - a fast device is
   * never touched.
   */
  const PIT_WATCH_FRAMES = 90;
  const PIT_SLOW_MS = 22;        /* below roughly 45fps */
  let _pitWatch = null;

  /** Drop every other loose ball. Called at most once per match. */
  function _thinPit() {
    const keep = [];
    for (let i = 0; i < _pit.length; i++) {
      if (i % 2) _pit[i].el.remove();
      else keep.push(_pit[i]);
    }
    _pit = keep;
  }

  /**
   * Sample frame times during play and thin the pit if the device is
   * struggling. Stops sampling either way once it has enough.
   * @param {number} dt - seconds since the last frame
   * @param {boolean} live - only judge during play, not during a celebration
   */
  function _watchPitCost(dt, live) {
    if (!_pitWatch || !live) return;
    _pitWatch.push(dt * 1000);
    if (_pitWatch.length < PIT_WATCH_FRAMES) return;
    const sorted = _pitWatch.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    _pitWatch = null;
    if (median > PIT_SLOW_MS) _thinPit();
  }

  /**
   * Scatter loose balls over the pitch in a jittered grid, so they read as a
   * floor rather than a pattern.
   * @param {number} count
   */
  function _buildPit(count) {
    const layer = Pitch.worldLayer();
    if (!layer) return;
    /* A grid with jitter covers evenly without clumping or obvious rows. */
    const cols = Math.max(1, Math.round(Math.sqrt(count * CONFIG.pitchW / CONFIG.pitchH)));
    const rows = Math.max(1, Math.ceil(count / cols));
    const frag = document.createDocumentFragment();
    for (let i = 0; i < count; i++) {
      const cx = (i % cols + 0.5) / cols * CONFIG.pitchW;
      const cy = (Math.floor(i / cols) + 0.5) / rows * CONFIG.pitchH;
      const hx = cx + (Math.random() - 0.5) * (CONFIG.pitchW / cols) * 0.85;
      const hy = cy + (Math.random() - 0.5) * (CONFIG.pitchH / rows) * 0.85;
      const el = document.createElement('div');
      el.className = 'pit-ball';
      el.style.background = PIT_COLOURS[i % PIT_COLOURS.length];
      el.style.width = PIT_BASE + 'px';
      el.style.height = PIT_BASE + 'px';
      frag.appendChild(el);
      const b = {
        hx, hy, x: hx, y: hy, vx: 0, vy: 0, el,
        settled: false,   /* forces one write to place it */
      };
      _pit.push(b);
    }
    layer.appendChild(frag);
  }

  /** Place one loose ball, with depth. Transform only - see the note above. */
  function _drawPitBall(b, L) {
    const q = Pitch.project(b.x, b.y);
    const k = L.zoom * q.scale;
    b.el.style.transform =
      `translate3d(${q.sx - PIT_BASE / 2}px,${q.sy - PIT_BASE / 2}px,0) scale(${k})`;
    _setZ(b.el, q.z);
  }

  /**
   * Shove the loose balls around and let them settle back.
   * @param {object} world
   * @param {number} dt - seconds since the last frame
   * @param {object} L - the pitch layout
   */
  function _stepPit(world, dt, L) {
    const reach = (PIT_R + CONFIG.playerRadius) * PIT_WAKE;
    const ballReach = (PIT_R + CONFIG.ballRadius) * PIT_WAKE;
    const near = PIT_NEIGHBOUR_R;
    const damp = Math.pow(PIT_DAMP, dt * 60);
    const mb = world.ball;

    /* Pass one: what the players and the match ball disturb directly. */
    for (const b of _pit) {
      b.touched = false;

      for (const p of world.players) {
        const dx = b.x - p.x, dy = b.y - p.y;
        const d2 = dx * dx + dy * dy;
        if (d2 >= reach * reach) continue;
        const d = Math.sqrt(d2) || 0.01;
        const push = (reach - d) / reach;
        b.vx += (dx / d) * push * PIT_PUSH * dt;
        b.vy += (dy / d) * push * PIT_PUSH * dt;
        b.touched = true;
      }

      /* The match ball ploughs a line through them, which is the best of it. */
      const bx = b.x - mb.x, by = b.y - mb.y;
      const bd2 = bx * bx + by * by;
      if (bd2 < ballReach * ballReach) {
        const bd = Math.sqrt(bd2) || 0.01;
        const push = (ballReach - bd) / ballReach;
        b.vx += (bx / bd) * push * PIT_BALL_PUSH * dt;
        b.vy += (by / bd) * push * PIT_BALL_PUSH * dt;
        b.touched = true;
      }
    }

    /*
     * Pass two: a ball that is moving shoves the ones it is touching, so a
     * disturbance spreads outward instead of stopping at whoever caused it.
     * This is what makes a run through the pit look like a run through a pit.
     *
     * Only moving balls are sources, so a still pitch does no work here, and
     * the push is one-directional - the source is already being driven, and
     * pushing both ways invites two balls oscillating against each other.
     */
    for (const a of _pit) {
      if (a.settled && !a.touched) continue;
      if (Math.hypot(a.vx, a.vy) < PIT_SOURCE_SPEED) continue;
      for (const b of _pit) {
        if (b === a) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d2 = dx * dx + dy * dy;
        if (d2 >= near * near) continue;
        const d = Math.sqrt(d2) || 0.01;
        const push = (near - d) / near;
        b.vx += (dx / d) * push * PIT_NEIGHBOUR * dt;
        b.vy += (dy / d) * push * PIT_NEIGHBOUR * dt;
        b.touched = true;
      }
    }

    /* Pass three: move what is moving. A ball at home and still costs nothing. */
    for (const b of _pit) {
      if (b.settled && !b.touched) continue;

      b.vx += (b.hx - b.x) * PIT_SPRING * dt * 60 * dt;
      b.vy += (b.hy - b.y) * PIT_SPRING * dt * 60 * dt;
      b.vx *= damp;
      b.vy *= damp;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.x = Math.max(PIT_R, Math.min(CONFIG.pitchW - PIT_R, b.x));
      b.y = Math.max(PIT_R, Math.min(CONFIG.pitchH - PIT_R, b.y));

      const speed = Math.hypot(b.vx, b.vy);
      const offset = Math.hypot(b.x - b.hx, b.y - b.hy);
      if (!b.touched && speed < PIT_REST && offset < PIT_REST) {
        b.x = b.hx; b.y = b.hy; b.vx = 0; b.vy = 0;
        b.settled = true;
      } else {
        b.settled = false;
      }
      _drawPitBall(b, L);
    }
  }

  /* ─── Scene effects ─── */

  /*
   * The vocabulary a scene can draw on. Scenes name these in CONFIG.fx; they
   * do not describe them. Adding a scene costs no code here, adding a new kind
   * of effect does.
   *
   * Everything lands in the fx layer, which pans with the world, so emitters
   * work in world-layer pixels and need no camera arithmetic.
   */
  const EMITTERS = {
    /** Moon dust: soft puffs that spread and settle. */
    dust(sx, sy, scale, strength) {
      /* Quadratic, so a footstep stays a wisp while a full-power kick throws a
         real cloud. Both go through the same emitter. */
      const n = 1 + Math.round(strength * strength * 4);
      for (let i = 0; i < n; i++) {
        const size = (12 + Math.random() * 18) * scale * (0.6 + strength);
        _particle('puff', sx, sy, size, size, {
          dx: (Math.random() - 0.5) * 34 * scale + 'px',
          dy: (-6 - Math.random() * 16) * scale + 'px',
        }, 620);
      }
    },

    /** Water: a flattened ring spreading out from the feet. */
    ripple(sx, sy, scale, strength) {
      const w = (34 + strength * 26) * scale;
      _particle('ripple', sx, sy, w, w * 0.4, null, 900);
    },

    /** Water: droplets thrown up and out. */
    splash(sx, sy, scale, strength) {
      _particle('ripple', sx, sy, 44 * scale, 44 * scale * 0.4, null, 900);
      const n = 5 + Math.round(strength * 4);
      for (let i = 0; i < n; i++) {
        const a = -Math.PI + (i / n) * Math.PI * 2;
        const d = (16 + Math.random() * 26) * scale * (0.5 + strength);
        const size = (3 + Math.random() * 4) * scale;
        _particle('drop', sx, sy, size, size, {
          dx: Math.cos(a) * d + 'px',
          dy: (Math.sin(a) * d * 0.45 - 10 * scale) + 'px',
        }, 620);
      }
    },
  };

  /**
   * Spawn one effect element in the fx layer.
   * @param {string} cls - CSS class, which carries the animation
   * @param {number} sx - world-layer x, the element is centred on it
   * @param {number} sy - world-layer y
   * @param {number} w - width in px
   * @param {number} h - height in px
   * @param {Object<string, string>|null} vars - CSS custom properties (--dx, --dy)
   * @param {number} life - ms before removal, must outlast the animation
   */
  function _particle(cls, sx, sy, w, h, vars, life) {
    const fx = Pitch.fxLayer();
    if (!fx) return;
    const el = document.createElement('div');
    el.className = cls;
    el.style.left = sx + 'px';
    el.style.top = sy + 'px';
    el.style.width = w + 'px';
    el.style.height = h + 'px';
    if (vars) for (const [k, v] of Object.entries(vars)) el.style.setProperty('--' + k, v);
    fx.appendChild(el);
    setTimeout(() => el.remove(), life);
  }

  /**
   * The moment a tackle takes the ball: a soft ring and a few sparkles arcing
   * up. Unlike the scene effects this is not optional - it is the one bit of
   * feedback that says a tackle happened, in every scene. It is deliberately
   * not an impact burst; nothing here should read as a collision.
   * @param {number} x - world x
   * @param {number} y - world y
   */
  function tackleBurst(x, y) {
    if (_calmly) return;
    const q = Pitch.project(x, y);
    _particle('pop', q.sx, q.sy, 30 * q.scale, 30 * q.scale * 0.55, null, 440);
    for (let i = 0; i < 3; i++) {
      const a = -Math.PI * 0.78 + (i / 2) * Math.PI * 0.56;
      const d = (14 + Math.random() * 11) * q.scale;
      _particle('twinkle', q.sx, q.sy, 6 * q.scale, 6 * q.scale, {
        dx: Math.cos(a) * d + 'px',
        dy: (Math.sin(a) * d - 9 * q.scale) + 'px',
      }, 540);
    }
  }

  /**
   * Emit whatever the current scene does for this kind of moment.
   * @param {string} kind - 'kick', 'wall' or 'tackle'
   * @param {number} x - world x
   * @param {number} y - world y
   * @param {number} [strength] - 0..1, scales the burst
   */
  function sceneFx(kind, x, y, strength) {
    if (_calmly) return;
    const name = (CONFIG.fx || {})[kind];
    const emit = EMITTERS[name];
    if (!emit) return;
    const q = Pitch.project(x, y);
    emit(q.sx, q.sy, q.scale, strength == null ? 1 : Math.max(0, Math.min(1, strength)));
  }

  /* ─── Effects ─── */

  /**
   * Show the big banner.
   * @param {string|null} text - null hides it
   */
  function banner(text) {
    if (!_els.banner) return;
    if (!text) { _els.banner.classList.add('banner--hidden'); return; }
    _els.bannerText.textContent = text;
    _els.banner.classList.remove('banner--hidden');
    /* Restart the pop-in even if the banner was already up. */
    _els.bannerText.style.animation = 'none';
    void _els.bannerText.offsetWidth;
    _els.bannerText.style.animation = '';
  }

  /**
   * The goal moment: zoom punch on the ball, shake, fireworks, crowd bounce.
   * @param {number} team - who scored
   * @param {number} x - world x of the goal
   * @param {number} y - world y of the goal
   */
  function goalBurst(team, x, y) {
    Pitch.punch(CONFIG.zoomPunch, x, y);
    Pitch.shake(CONFIG.shakePx * 1.6);
    fireworks(x);
    if (_els.crowd) {
      _els.crowd.classList.remove('crowd--cheer');
      void _els.crowd.offsetWidth;
      _els.crowd.classList.add('crowd--cheer');
    }
  }

  /**
   * Fireworks over the pitch. CSS particle bursts in a few colours - cheap,
   * and they clean themselves up.
   * @param {number} [aroundX] - world x to centre the bursts on
   */
  function fireworks(aroundX) {
    const fx = Pitch.fxLayer();
    if (!fx) return;
    const L = Pitch.layout();
    const colours = ['#ffd166', '#ef476f', '#06d6a0', '#5bc0eb'];
    const centre = aroundX == null ? Pitch.camX() + CONFIG.cameraViewW / 2 : aroundX;
    for (let burst = 0; burst < 5; burst++) {
      const bx = (centre + (Math.random() - 0.5) * CONFIG.cameraViewW * 0.8) * L.zoom;
      const by = L.pitchTop * (0.15 + Math.random() * 0.7);
      const colour = colours[burst % colours.length];
      setTimeout(() => _burst(fx, bx, by, colour), burst * 170);
    }
  }

  /** One firework: twelve sparks on radial CSS custom properties. */
  function _burst(fx, x, y, colour) {
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const dist = 42 + Math.random() * 46;
      const el = document.createElement('div');
      el.className = 'spark';
      el.style.left = x + 'px';
      el.style.top = y + 'px';
      el.style.background = colour;
      el.style.setProperty('--dx', Math.cos(a) * dist + 'px');
      el.style.setProperty('--dy', Math.sin(a) * dist + 'px');
      fx.appendChild(el);
      setTimeout(() => el.remove(), 900);
    }
  }

  /** One fading clone of the ball, left behind on a hard shot. */
  function _spawnTrail(x, y, size) {
    const fx = Pitch.fxLayer();
    if (!fx) return;
    const el = document.createElement('div');
    el.className = 'ball-trail';
    el.style.left = (x - size / 2) + 'px';
    el.style.top = y + 'px';
    el.style.width = size + 'px';
    el.style.height = size + 'px';
    fx.appendChild(el);
    setTimeout(() => el.remove(), 260);
  }

  /**
   * The full-time card.
   * @param {object} match
   * @param {Array<object>} teams
   */
  function showFullTime(match, teams) {
    const overlay = document.getElementById('fulltime');
    if (!overlay) return;
    const title = overlay.querySelector('.fulltime__title');
    const score = overlay.querySelector('.fulltime__score');
    title.textContent = match.winner === null
      ? 'a draw!'
      : `${teams[match.winner].name || CONFIG.teamNames[match.winner]} win!`;
    score.textContent = `${match.score[0]} - ${match.score[1]}`;
    overlay.classList.remove('overlay--hidden');
  }

  /** Hide the full-time card. */
  function hideFullTime() {
    const overlay = document.getElementById('fulltime');
    if (overlay) overlay.classList.add('overlay--hidden');
  }

  return {
    mount, unmount, frame, animFor, sceneFx, tackleBurst,
    banner, goalBurst, fireworks, showFullTime, hideFullTime,
  };
})();
