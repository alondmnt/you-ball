/**
 * Game - bootstrap, screen switching, and the loop.
 *
 * The loop is a fixed 60Hz logic step inside requestAnimationFrame with an
 * accumulator, so physics behaves the same on a 60Hz tablet and a 120Hz laptop.
 * The catch-up is clamped: a tab that was in the background for a minute must
 * not try to simulate a minute of soccer in one frame.
 *
 * This module is the only place that knows a human exists. Input produces
 * intents, AI produces the same intents, and physics cannot tell them apart -
 * which is also why local two-player costs nothing but a second key set.
 */
const Game = (() => {
  const STEP = 1 / 60;
  const MAX_STEPS = 5;          /* at most ~83ms of catch-up in one frame */
  const SWITCH_EVERY = 0.3;     /* how often auto-switch reconsiders, seconds */

  let _progress = null;
  let _world = null, _match = null, _teams = null;
  let _urls = {}, _ballSrc = null;
  let _intents = [];
  let _seats = [];
  let _raf = null, _lastFrame = 0, _acc = 0, _paused = false;
  let _switchTimer = 0;
  let _humanKey = '';

  /* ─── Bootstrap ─── */

  function init() {
    _progress = Storage.loadProgress();
    CONFIG.difficulty = _progress.difficulty || CONFIG.difficulty;
    CONFIG.twoPlayer = !!_progress.twoPlayer;
    Audio.setMuted(!!_progress.muted);

    Pitch.init({
      viewport: document.getElementById('viewport'),
      pitch: document.getElementById('pitch'),
      markings: document.getElementById('pitch-markings'),
      world: document.getElementById('world'),
      crowd: document.getElementById('crowd'),
      fx: document.getElementById('fx'),
    });
    Input.init(document.getElementById('viewport'));
    Editor.init(() => startMatch());

    document.getElementById('splash-play').addEventListener('click', () => _fromSplash(startMatch));
    document.getElementById('splash-edit').addEventListener('click', () => _fromSplash(openEditor));

    document.getElementById('sound-btn').addEventListener('click', _toggleSound);
    document.getElementById('edit-btn').addEventListener('click', () => { Audio.play('tap'); openEditor(); });
    document.getElementById('restart-btn').addEventListener('click', () => { Audio.play('tap'); startMatch(); });

    document.getElementById('ft-rematch').addEventListener('click', () => { Audio.play('tap'); startMatch(); });
    document.getElementById('ft-edit').addEventListener('click', () => { Audio.play('tap'); openEditor(); });
    document.getElementById('ft-home').addEventListener('click', () => { Audio.play('tap'); goHome(); });

    _syncSoundButton();
    _renderSplashKeys();
    /* Any gesture can wake an AudioContext the device suspended. */
    document.addEventListener('pointerdown', () => Audio.resume(), true);
    /* Pause when the tab is hidden, rather than banking up simulation time. */
    document.addEventListener('visibilitychange', () => { _paused = document.hidden; _acc = 0; });
  }

  /** Leaving the splash is the gesture that unlocks audio. */
  function _fromSplash(then) {
    Audio.unlock();
    Audio.play('tap');
    document.getElementById('splash').classList.add('splash--hidden');
    then();
  }

  /**
   * Print the keyboard controls on the splash.
   *
   * Touch needs no explaining, but space and shift are not discoverable, and
   * player two's keys were previously written down nowhere but the README.
   * The second row only appears once two-player is switched on.
   */
  function _renderSplashKeys() {
    const host = document.getElementById('splash-keys');
    if (!host) return;
    if (!CONFIG.twoPlayer) {
      host.innerHTML = `<div class="splash__keyrow">${Input.legendHtml(0)}</div>`;
      return;
    }
    host.innerHTML =
      `<div class="splash__keyrow"><span class="who">1</span>${Input.legendHtml(0)}</div>` +
      `<div class="splash__keyrow"><span class="who who--2">2</span>${Input.legendHtml(1)}</div>`;
  }

  /** Show one of the screens. */
  function _show(name) {
    document.getElementById('match-screen').classList.toggle('screen--hidden', name !== 'match');
    document.getElementById('editor-screen').classList.toggle('screen--hidden', name !== 'editor');
  }

  function _toggleSound() {
    Audio.setMuted(!Audio.isMuted());
    _progress.muted = Audio.isMuted();
    Storage.saveProgress(_progress);
    _syncSoundButton();
  }

  function _syncSoundButton() {
    const btn = document.getElementById('sound-btn');
    if (btn) btn.textContent = Audio.isMuted() ? '🔇' : '🔊';
  }

  /* ─── Screens ─── */

  /** Back to the splash, with the match torn down. */
  function goHome() {
    _stopLoop();
    Render.unmount();
    Render.hideFullTime();
    Storage.revokeAll();
    _show('none');
    _renderSplashKeys();   /* two-player may have been switched on since */
    document.getElementById('splash').classList.remove('splash--hidden');
  }

  /** Open the editor. */
  async function openEditor() {
    _stopLoop();
    Render.unmount();
    Render.hideFullTime();
    Input.setEnabled(false);
    Storage.revokeAll();
    _show('editor');
    await Editor.open(_progress);
  }

  /**
   * Start a fresh match: rebuild the teams from the save, pull the part images
   * out of IndexedDB, and kick off.
   */
  async function startMatch() {
    _stopLoop();
    Render.unmount();
    Render.hideFullTime();
    Storage.revokeAll();
    _show('match');
    Pitch.resize();       /* the viewport had no size while it was hidden */

    CONFIG.difficulty = _progress.difficulty || 'normal';
    CONFIG.twoPlayer = !!_progress.twoPlayer;
    /* Both halves of a scene at once: how it plays, then how it looks. */
    Pitch.setScene(CONFIG.applyScene(_progress.scene));

    _teams = _buildTeams();
    _urls = await _loadUrls();
    _ballSrc = _progress.ballCustom ? _urls[Storage.partKey(Editor.BALL_ID, 'ball')] : null;

    _world = Physics.createWorld();
    _match = Match.create();
    _intents = _world.players.map(() => ({ mx: 0, my: 0, shoot: null, pass: false }));
    _seats = [{ team: 0, playerId: 1 }];
    if (CONFIG.twoPlayer) _seats.push({ team: 1, playerId: 5 });
    _humanKey = '';
    _switchTimer = 0;

    const s = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
    AI.seed(s);
    Physics.seed(s ^ 0x5bf03635);   /* a separate stream from the AI's */
    Match.begin(_match, _world, 0);

    Render.mount(_world, _teams, _urls, _ballSrc);
    Render.banner('kick off');
    Pitch.follow(_world.ball.x, true);
    Input.reset();
    Input.setEnabled(false);
    _startLoop();
  }

  /* ─── Teams and assets ─── */

  /**
   * Turn the save into the four characters per side the renderer needs.
   * Any empty place falls back to a built-in character, so a save with an
   * empty roster is still a playable match.
   */
  function _buildTeams() {
    return _progress.teams.map((team, t) => ({
      colour: team.colour || CONFIG.teamColours[t],
      name: team.name || CONFIG.teamNames[t],
      chars: [0, 1, 2, 3].map(i => {
        const found = _progress.roster.find(c => c.id === team.players[i]);
        return found || { id: `_d${t}${i}`, name: '', head: (t * 3 + i) % Assets.HEAD_VARIANTS.length, slots: {} };
      }),
    }));
  }

  /** Read every part image this match needs and turn it into an object URL. */
  function _loadUrls() {
    const keys = [];
    for (const team of _teams) {
      for (const c of team.chars) {
        for (const slot of Assets.allSlotKeys()) keys.push(Storage.partKey(c.id, slot));
      }
    }
    keys.push(Storage.partKey(Editor.BALL_ID, 'ball'));
    return Storage.loadPartUrls(keys);
  }

  /* ─── Control ─── */

  /** The player ids a human is driving right now. */
  function _humanIds() { return new Set(_seats.map(s => s.playerId)); }

  /**
   * Keep each seat on the right player.
   *
   * If your team has the ball you control whoever has it. Otherwise control
   * jumps to your field player nearest the ball, so the kid never has to think
   * about who they are.
   *
   * @param {boolean} reconsider - also re-pick when the ball is not ours
   */
  function _autoSwitch(reconsider) {
    const holder = Physics.carrier(_world);
    const taken = new Set();
    for (const seat of _seats) {
      if (holder && holder.team === seat.team && holder.role !== 'gk') {
        seat.playerId = holder.id;
      } else if (reconsider) {
        const pick = _nearestField(seat.team, taken);
        if (pick) seat.playerId = pick.id;
      }
      taken.add(seat.playerId);
    }
  }

  /** A team's field player nearest the ball, skipping ones another seat has. */
  function _nearestField(team, taken) {
    const b = _world.ball;
    let best = null, bestD = Infinity;
    for (const p of _world.players) {
      if (p.team !== team || p.role === 'gk' || taken.has(p.id)) continue;
      const d = Math.hypot(p.x - b.x, p.y - b.y);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  /** Fill the intents array: AI for everyone, then the humans on top. */
  function _buildIntents() {
    const humans = _humanIds();

    /* speedMult only changes when control changes, so only recompute then. */
    const key = [...humans].join(',');
    if (key !== _humanKey) { _humanKey = key; AI.applyDifficulty(_world, humans); }

    AI.think(_world, humans, _intents);

    for (let i = 0; i < _seats.length; i++) {
      const seat = _seats[i];
      const s = Input.seat(i);
      const p = _world.players[seat.playerId];
      const it = _intents[seat.playerId];
      const hasBall = _world.ball.carrier === seat.playerId;

      it.mx = s.mx; it.my = s.my;
      it.shoot = null; it.pass = false;

      /* A tap passes if you have the ball, and switches players if you do not. */
      if (s.tapRequest) {
        if (hasBall) it.pass = true;
        else {
          const taken = new Set(_seats.filter(x => x !== seat).map(x => x.playerId));
          const pick = _nearestField(seat.team, taken);
          if (pick) seat.playerId = pick.id;
        }
      }
      if (s.passRequest && hasBall) it.pass = true;
      if (s.shootRequest && hasBall) {
        let { dx, dy, power } = s.shootRequest;
        if (!dx && !dy) { dx = p.facing; dy = 0; }   /* no direction held - shoot ahead */
        it.shoot = { dx, dy, power };
      }
      Input.clearRequests(i);
    }
  }

  /* ─── Loop ─── */

  function _startLoop() {
    _lastFrame = performance.now();
    _acc = 0;
    _paused = document.hidden;
    if (!_raf) _raf = requestAnimationFrame(_frame);
  }

  function _stopLoop() {
    if (_raf) cancelAnimationFrame(_raf);
    _raf = null;
  }

  function _frame(now) {
    _raf = requestAnimationFrame(_frame);
    const elapsed = Math.min(0.25, (now - _lastFrame) / 1000);
    _lastFrame = now;
    if (_paused || !_world) return;

    _acc += elapsed;
    let steps = 0;
    while (_acc >= STEP && steps < MAX_STEPS) {
      _step(STEP);
      _acc -= STEP;
      steps++;
    }
    /* Too far behind to catch up - drop the backlog rather than spiral. */
    if (steps >= MAX_STEPS) _acc = 0;

    Pitch.follow(_world.ball.x);
    Pitch.stepFeel(elapsed);
    Render.frame(_world, _match, _humanIds());
  }

  /** One fixed logic step. */
  function _step(dt) {
    const scale = Match.timeScale(_match);
    let worldEvents = [];

    if (scale > 0) {
      _switchTimer -= dt;
      const reconsider = _switchTimer <= 0;
      if (reconsider) _switchTimer = SWITCH_EVERY;
      _autoSwitch(reconsider);
      _buildIntents();
      worldEvents = Physics.step(_world, _intents, dt * scale);
    }

    const matchEvents = Match.update(_match, _world, dt, worldEvents);
    _react(worldEvents, matchEvents);
  }

  /** Turn events into sound and spectacle. */
  function _react(worldEvents, matchEvents) {
    for (const e of worldEvents) {
      switch (e.type) {
        case 'kick':
          Audio.play('kick', e.power / CONFIG.shootPowerMax);
          Render.sceneFx('kick', e.x, e.y, e.power / CONFIG.shootPowerMax);
          break;
        case 'pass':
          Audio.play('pass');
          break;
        case 'wall':
          if (e.speed > 320) {
            Audio.play('wall');
            Pitch.shake(CONFIG.shakePx * Math.min(1, e.speed / 1200));
            Render.sceneFx('wall', e.x, e.y, Math.min(1, e.speed / 1200));
          }
          break;
        case 'steal':
          Audio.play('steal');
          Pitch.shake(CONFIG.shakePx * 0.7);
          Render.tackleBurst(e.x, e.y);
          Render.sceneFx('tackle', e.x, e.y, 0.8);
          break;
        case 'pickup':
          Audio.play(e.save ? 'save' : 'pickup');
          if (e.save) Pitch.shake(CONFIG.shakePx * 0.7);
          break;
        default:
          break;
      }
    }

    for (const e of matchEvents) {
      switch (e.type) {
        case 'goal':
          Render.goalBurst(e.team, e.x, e.y);
          Render.banner('GOAL!');
          Audio.play('goal');
          /* The conceding slide comes in under the cheer, not over it. */
          setTimeout(() => Audio.play('concede'), 800);
          Input.setEnabled(false);
          Input.reset();
          break;
        case 'celebrate':
          Render.fireworks(_world.ball.x);
          break;
        case 'kickoff':
          Render.banner('kick off');
          Pitch.follow(_world.ball.x, true);
          break;
        case 'whistle':
          Render.banner(null);
          Audio.play('whistle');
          Input.setEnabled(true);
          break;
        case 'fulltime':
          Render.banner(null);
          Audio.play('fulltime');
          Input.setEnabled(false);
          Render.showFullTime(_match, _teams);
          break;
        default:
          break;
      }
    }
  }

  return { init, startMatch, openEditor, goHome };
})();

document.addEventListener('DOMContentLoaded', Game.init);
