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

  let _rigs = [];       /* one per player id */
  let _ball = null;     /* { el, shadow } */
  let _teams = null;    /* [{ colour, chars: [record x4] }, …] */
  let _urls = {};
  let _els = {};        /* cached UI elements */
  let _faceChar = [];   /* which character speaks for each team in the score bar */
  let _lastScore = [-1, -1];
  let _lastClock = '';
  let _trailAt = 0;

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
    const shadow = document.createElement('div');
    shadow.className = 'ball__shadow';
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
    if (_ball) { _ball.el.remove(); _ball.shadow.remove(); _ball = null; }
    const fx = Pitch.fxLayer();
    if (fx) fx.innerHTML = '';
  }

  /**
   * Which animation a player's current state implies.
   * @param {object} p
   * @param {object} world
   * @param {object} match
   * @returns {string} a Character animation name
   */
  function animFor(p, world, match) {
    if (match.phase === Match.PHASE.GOAL) {
      /* Everybody dances. The conceding team dances too, just sadly. */
      return match.scorer === p.team ? 'celebrate' : 'sad-dance';
    }
    if (match.phase === Match.PHASE.FULLTIME) {
      if (match.winner === null) return 'idle';
      return match.winner === p.team ? 'celebrate' : 'sad';
    }
    if (p.role === 'gk' && p.diveUntil > world.t) return 'dive';
    if (world.t - p.kickAt < 0.34) return 'kick';
    if (Math.hypot(p.vx, p.vy) > 45) return 'run';
    return 'idle';
  }

  /**
   * Draw one frame.
   * @param {object} world
   * @param {object} match
   * @param {Set<number>} [controlled] - player ids a human is driving
   */
  function frame(world, match, controlled) {
    const L = Pitch.layout();

    for (const p of world.players) {
      const rig = _rigs[p.id];
      if (!rig) continue;
      const q = Pitch.project(p.x, p.y);
      const s = L.charScale * q.scale;
      const flip = p.facing < 0 ? ' scaleX(-1)' : '';
      rig.el.style.transform =
        `translate3d(${q.sx - CW / 2}px,${q.sy - CH}px,0) scale(${s})${flip}`;
      rig.el.style.zIndex = q.z;
      if (p.role === 'gk') rig.setDiveDir(p.diveDir);
      rig.setAnim(animFor(p, world, match));
      /* A stunned player flashes, so a tackle reads as something that happened. */
      rig.el.classList.toggle('ch--stunned', p.stunUntil > world.t);
      rig.el.classList.toggle('ch--mine', !!controlled && controlled.has(p.id));
    }

    const b = world.ball;
    const q = Pitch.project(b.x, b.y);
    const size = CONFIG.ballDrawD * L.zoom * q.scale;
    _ball.el.style.width = size + 'px';
    _ball.el.style.height = size + 'px';
    _ball.el.style.transform =
      `translate3d(${q.sx - size / 2}px,${q.sy - size * 0.92}px,0) rotate(${b.x * 0.6}deg)`;
    _ball.el.style.zIndex = q.z + 1;
    _ball.shadow.style.width = size * 0.8 + 'px';
    _ball.shadow.style.height = size * 0.26 + 'px';
    _ball.shadow.style.transform = `translate3d(${q.sx - size * 0.4}px,${q.sy - size * 0.13}px,0)`;
    _ball.shadow.style.zIndex = q.z;

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
    mount, unmount, frame, animFor,
    banner, goalBurst, fireworks, showFullTime, hideFullTime,
  };
})();
