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
  let _charge = 0;      /* last wind-up reading, so the ignite sound fires once */

  /* ─── Bootstrap ─── */

  function init() {
    _progress = Storage.loadProgress();
    CONFIG.difficulty = _progress.difficulty || CONFIG.difficulty;
    CONFIG.twoPlayer = !!_progress.twoPlayer;
    CONFIG.inGoal = _places();
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
    /* The rAF loop stops itself when hidden, but a setTimeout scheduler would
       happily keep playing to a tab nobody is looking at. Coming back only
       restarts the anthem if a match is actually up and still running: the
       splash, the editor and the full time card are all meant to be quiet. */
    document.addEventListener('visibilitychange', () => {
      _paused = document.hidden;
      _acc = 0;
      if (document.hidden) Audio.stopMusic();
      else if (_raf && _match && _match.phase !== Match.PHASE.FULLTIME) Audio.startMusic();
    });
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
      host.innerHTML = `<div class="splash__keyrow">${Input.legendHtml(0, CONFIG.inGoal[0])}</div>`;
      return;
    }
    host.innerHTML =
      `<div class="splash__keyrow"><span class="who">1</span>${Input.legendHtml(0, CONFIG.inGoal[0])}</div>` +
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
    Audio.stopMusic();
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
    Audio.stopMusic();
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
    _charge = 0;          /* or a match that ended mid-wind-up swallows the next ignite */
    Render.unmount();
    Render.hideFullTime();
    Storage.revokeAll();
    _show('match');
    /* Before the resize, so the zoom is computed once at the width this match
       will actually use. */
    Pitch.setWideView(_places().some(Boolean));
    Pitch.resize();       /* the viewport had no size while it was hidden */

    CONFIG.difficulty = _progress.difficulty || 'normal';
    CONFIG.twoPlayer = !!_progress.twoPlayer;
    CONFIG.inGoal = _places();
    /* Both halves of a scene at once: how it plays, then how it looks. */
    Pitch.setScene(CONFIG.applyScene(_progress.scene));

    _teams = _buildTeams();
    _urls = await _loadUrls();
    _ballSrc = _progress.ballCustom ? _urls[Storage.partKey(Editor.BALL_ID, 'ball')] : null;

    _world = Physics.createWorld();
    _match = Match.create();
    _intents = _world.players.map(() => ({ mx: 0, my: 0, shoot: null, pass: false }));
    /* Player index 0 of each team is its keeper; see Physics.createWorld. A
       keeper seat is pinned, because the whole point of choosing to play in
       goal is that control does not wander off to whoever is near the ball. */
    const place = CONFIG.inGoal;
    _seats = [{ team: 0, playerId: place[0] ? 0 : 1, keeper: !!place[0] }];
    if (CONFIG.twoPlayer) _seats.push({ team: 1, playerId: place[1] ? 4 : 5, keeper: !!place[1] });
    _humanKey = '';
    _switchTimer = 0;

    const s = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
    AI.seed(s);
    Physics.seed(s ^ 0x5bf03635);   /* a separate stream from the AI's */
    Match.begin(_match, _world, 0);

    Render.mount(_world, _teams, _urls, _ballSrc);
    Render.banner('kick off', 'panel');
    Pitch.follow(_world.ball.x, true);
    Input.reset();
    Input.setEnabled(false);
    Audio.startMusic();
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

  /**
   * Turn a lean into a shot at the goal.
   *
   * A shot always travels toward the goal being attacked; the input only
   * chooses where in the mouth. Aiming by compass could not work on a
   * keyboard: the direction came from the held keys, so only multiples of 45
   * degrees existed, and the whole goal spans 44 degrees from 400 units out.
   * Exactly one of the eight was on target, and it was dead centre - which is
   * where the keeper is standing, and where a shot scores 0% of the time.
   *
   * Up is always the far touchline and down always the near one, whichever end
   * you are attacking, so the control never reverses under a child's hands.
   * @param {object} p - the player shooting
   * @param {number} bias - -1..1, from the held or flicked y
   * @returns {{dx: number, dy: number}} a unit vector at the goal
   */
  function _aimAt(p, bias) {
    const at = _aimPoint(p, bias);
    const dx = at.x - p.x, dy = at.y - p.y;
    const len = Math.hypot(dx, dy) || 1;
    return { dx: dx / len, dy: dy / len };
  }

  /**
   * The point on the goal line a lean is pointing at.
   *
   * Split out from _aimAt because the renderer needs the point itself, to draw
   * the target while the shot is still being wound up. A child cannot learn to
   * place a shot they cannot see themselves placing.
   * @param {object} p - the player shooting
   * @param {number} bias - -1..1
   * @returns {{x: number, y: number}} world units
   */
  function _aimPoint(p, bias) {
    const b = Math.max(-1, Math.min(1, bias || 0));
    return {
      x: Physics.targetGoalX(p.team),
      y: CONFIG.pitchH / 2 + b * (CONFIG.goalMouth / 2) * CONFIG.aimReach,
    };
  }

  /**
   * Where each live seat is playing: true for in goal, one entry per seat.
   *
   * Reads _progress rather than CONFIG, because the camera has to know before
   * the match has copied the settings across. A second entry only exists when
   * two-player is on, so a stale choice for a player who is not on the pitch
   * can never widen the camera or take over a keeper.
   * @returns {Array<boolean>}
   */
  function _places() {
    const g = _progress.inGoal || [];
    return _progress.twoPlayer ? [!!g[0], !!g[1]] : [!!g[0]];
  }

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
      if (seat.keeper) { taken.add(seat.playerId); continue; }
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

    const now = performance.now();
    let charge = 0, aimAt = null;
    for (let i = 0; i < _seats.length; i++) {
      const seat = _seats[i];
      const s = Input.seat(i);
      const p = _world.players[seat.playerId];
      const it = _intents[seat.playerId];
      const hasBall = _world.ball.carrier === seat.playerId;

      /* You can only wind a kick up round a ball you actually have. */
      Input.setCharging(i, hasBall, now);
      if (hasBall) {
        const c = Input.charge(i, now);
        if (c > charge) { charge = c; aimAt = _aimPoint(p, s.my); }
      }

      it.mx = s.mx; it.my = s.my;
      it.shoot = null; it.pass = false; it.dive = false;

      /* A tap passes if you have the ball, and switches players if you do not.
         A wind-up that found no ball to kick is only a tap that took its time,
         so holding still to charge never leaves you stuck on the wrong player. */
      if (s.tapRequest || (s.shootRequest && s.shootRequest.held && !hasBall)) {
        if (hasBall) it.pass = true;
        else if (!seat.keeper) {
          const taken = new Set(_seats.filter(x => x !== seat).map(x => x.playerId));
          const pick = _nearestField(seat.team, taken);
          if (pick) seat.playerId = pick.id;
        }
      }
      if (s.passRequest && hasBall) it.pass = true;
      /*
       * A keeper with no ball dives instead of shooting. On a keyboard the
       * press is what counts, because waiting for the key to come back up
       * would spend most of the 457ms a shot takes to arrive. On a screen a
       * flick dives the way you flicked and a tap dives at the ball, which is
       * as much control as a child needs with one finger.
       */
      if (p.role === 'gk' && !hasBall) {
        if (s.shootPressed || s.shootRequest || s.tapRequest) it.dive = true;
        if (s.shootRequest && (s.shootRequest.dx || s.shootRequest.dy)) {
          it.mx = s.shootRequest.dx; it.my = s.shootRequest.dy;
        }
      }

      if (s.shootRequest && hasBall) {
        const { power, charge, dy } = s.shootRequest;
        const at = _aimAt(p, dy);
        it.shoot = { dx: at.dx, dy: at.dy, power, charge: charge || 0 };
      }
      Input.clearRequests(i);
    }

    /*
     * Nobody of ours is winding up, so show the opposition's tell instead: an
     * AI lining a shot up at a goal we are defending. Without it a human
     * keeper has no information at all, while the AI keeper at the other end
     * is handed an exact prediction of where the shot will cross.
     */
    if (!aimAt) {
      const ours = new Set(_seats.map(x => x.team));
      for (const q of _world.players) {
        if (q.aimUntil > _world.t && !ours.has(q.team)) {
          aimAt = { x: Physics.targetGoalX(q.team), y: q.aimY };
          break;
        }
      }
    }

    /* The ball is the meter and there is one of it, so two seats can never
       both be charging and the max above is a pick rather than a blend. */
    if (charge >= 1 && _charge < 1) Audio.play('ignite');
    _charge = charge;
    Render.setWindUp(charge, aimAt ? aimAt.x : null, aimAt ? aimAt.y : 0);
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
    Render.frame(_world, _match, _humanIds(), elapsed);
    _feedMusic(elapsed);
  }

  /**
   * Hand the music the two things its arrangement depends on: who is carrying
   * the ball, and what the match is doing.
   *
   * This reads the world once a frame rather than riding the events, because
   * the interesting states are the ones with no event in them - a loose ball
   * has nobody to fire a pickup, and a goal celebration does not step physics
   * at all.
   *
   * @param {number} elapsed - real seconds since the previous frame
   */
  function _feedMusic(elapsed) {
    const holder = Physics.carrier(_world);
    Audio.updateMusic({
      carrierTeam: holder ? holder.team : null,
      phase: _match.phase,
      score: _match.score,
    }, elapsed);
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
        case 'dive':
          Audio.play('dive');
          break;
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
          /* No screen shake. Shake says collision, and a steal is not one -
             it is kept for hard wall hits and goals. */
          Audio.play('steal');
          Render.tackleBurst(e.x, e.y);
          Render.sceneFx('tackle', e.x, e.y, 0.8);
          break;
        case 'pickup':
          Audio.play(e.save ? 'save' : 'pickup');
          if (e.save) Pitch.shake(CONFIG.shakePx * 0.7);
          break;
        case 'parry':
          /* Beaten away rather than caught. It is a save, and a bigger one. */
          Audio.play('save');
          Pitch.shake(CONFIG.shakePx);
          Render.tackleBurst(e.x, e.y);
          break;
        default:
          break;
      }
    }

    for (const e of matchEvents) {
      switch (e.type) {
        case 'goal':
          Render.goalBurst(e.team, e.x, e.y);
          Render.banner('GOAL!', 'boom');
          /* Which end it went in decides which motif plays. The sad slide
             that used to follow every goal played when you scored too. */
          Audio.play('goal', e.team === 0 ? 'home' : 'away');
          Input.setEnabled(false);
          Input.reset();
          break;
        case 'celebrate':
          Render.fireworks(_world.ball.x);
          break;
        case 'kickoff':
          Render.banner('kick off', 'panel');
          Pitch.follow(_world.ball.x, true);
          break;
        case 'whistle':
          Render.banner(null);
          Audio.play('whistle');
          Input.setEnabled(true);
          break;
        case 'fulltime':
          Render.banner(null);
          Audio.stopMusic();   /* the three whistles land better dry */
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
