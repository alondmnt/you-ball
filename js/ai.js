/**
 * AI - produces the same intents a human produces, for the players a human is
 * not driving.
 *
 * No DOM, no Date.now(), no Math.random: the generator is seeded here so a
 * match replays identically from the same seed, which is what makes the logic
 * testable from a plain script.
 *
 * Deliberately dumb and tunable. The behaviours are:
 *   carrier        run at the goal, shoot in range with a clear lane, pass under pressure
 *   chaser         the field player nearest a loose or enemy ball goes and gets it
 *   the rest       hold a formation slot that slides with the ball, with a wander
 *   keeper         track the ball's y on its line, dive at a fast inbound shot
 *
 * Difficulty is three multipliers, nothing more: how fast AI players run, how
 * fast keepers track, and how much aim error a shot carries.
 */
const AI = (() => {

  let _seed = 0x9e3779b9;

  /** Reseed the generator. Same seed, same match. */
  function seed(n) { _seed = (n >>> 0) || 0x9e3779b9; }

  /** mulberry32 - small, fast, good enough for jitter and aim noise. */
  function _rand() {
    _seed |= 0; _seed = (_seed + 0x6D2B79F5) | 0;
    let t = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** A random number in [-n, n]. */
  function _jitter(n) { return (_rand() * 2 - 1) * n; }

  /** The active difficulty multipliers. */
  function _diff() {
    return CONFIG.difficulties[CONFIG.difficulty] || CONFIG.difficulties.normal;
  }

  /**
   * Apply the difficulty to every AI on the pitch, whichever side it is on.
   *
   * Only the player a human is actually driving is exempt. The dial therefore
   * says how good everyone who is not you is, and the two teams are always
   * built to the same spec.
   *
   * It briefly described the opposition alone, exempting your whole side. That
   * left your three teammates at full against an opposition held back, and the
   * gap was not subtle: over 30 matches a row, on normal, your side won 4.57
   * to 0.07. On easy the opposition did not score at all, and your side had
   * *less* of the ball than they did (38%), because opponents too slow to hold
   * their formation end up bunched in their own box where they block shots
   * without ever threatening. Levelled, the same runs come out 2.77 to 2.43 on
   * normal and dead level on hard.
   *
   * The reason it was changed in the first place was that a levelled easy put
   * your own keeper at 60% tracking, and that was measured to concede more
   * than the slower opponents saved you. That does not reproduce: at easy the
   * opposition scores 0.00 a match whichever rule is used, because opponents
   * that slow cannot shoot straight either, so nothing punishes a weak keeper.
   * If it ever does come back, gkTrack is the dial, not this rule.
   *
   * Call after createWorld and whenever the human roster changes.
   * @param {object} world
   * @param {Set<number>|Array<number>} humanIds
   */
  function applyDifficulty(world, humanIds) {
    const humans = humanIds instanceof Set ? humanIds : new Set(humanIds || []);
    const d = _diff();

    for (const p of world.players) {
      p.human = humans.has(p.id);
      p.speedMult = p.human ? 1 : (p.role === 'gk' ? d.gkTrack : d.aiSpeed);
      /* Aim error is part of the difficulty too, so it follows the same rule. */
      p.aimNoise = CONFIG.shootNoise * (p.human ? 1 : d.shootNoise);
    }
  }

  /**
   * Fill in intents for every AI-controlled player.
   * @param {object} world
   * @param {Set<number>} humanIds - ids a human is driving this frame
   * @param {Array<object>} intents - written in place, one entry per player id
   */
  function think(world, humanIds, intents) {
    const humans = humanIds instanceof Set ? humanIds : new Set(humanIds || []);
    const chasers = _pickChasers(world, humans);

    for (const p of world.players) {
      const mine = Physics.ballOf(world, p.id);
      /* The tell belongs to the ball you are holding. */
      if (!mine) p.aimUntil = -99;
      if (humans.has(p.id)) continue;
      const intent = intents[p.id] || (intents[p.id] = { mx: 0, my: 0, shoot: null, pass: false });
      intent.mx = 0; intent.my = 0; intent.shoot = null; intent.pass = false; intent.dive = false;

      if (!p.ai) p.ai = { nextDecideAt: 0, jx: 0, jy: 0 };
      if (world.t >= p.ai.nextDecideAt) {
        p.ai.nextDecideAt = world.t + CONFIG.aiReactionMs / 1000;
        p.ai.jx = _jitter(CONFIG.aiJitter);
        p.ai.jy = _jitter(CONFIG.aiJitter);
      }

      const chase = chasers[p.team];
      if (p.role === 'gk') _keeper(world, p, mine, intent);
      else if (mine) _withBall(world, p, mine, intent);
      else if (chase && chase.id === p.id) _chase(world, p, chase.ball, intent);
      else _holdSlot(world, p, intent);
    }
  }

  /**
   * One field player per team goes for a ball: the closest player-and-ball
   * pairing, skipping any ball a teammate already has. With a single ball
   * that is exactly "the nearest player chases, unless we already have it".
   *
   * Deliberately still one chaser per team in a star match. Sending a second
   * would empty the formation, and with three balls loose there is already
   * more happening than anyone can mark.
   * @returns {Array<{id: number, ball: object}|null>} per team
   */
  function _pickChasers(world, humans) {
    const out = [null, null];
    for (let team = 0; team < 2; team++) {
      let best = null, bestD = Infinity;
      for (const b of world.balls) {
        const holder = Physics.carrierOf(world, b);
        if (holder && holder.team === team) continue;   /* ours already */
        for (const p of world.players) {
          if (p.team !== team || p.role === 'gk' || humans.has(p.id)) continue;
          const d = Math.hypot(p.x - b.x, p.y - b.y);
          if (d < bestD) { bestD = d; best = { id: p.id, ball: b }; }
        }
      }
      out[team] = best;
    }
    return out;
  }

  /** Steer toward a world point, easing off over the last ARRIVE units. */
  function _steer(p, tx, ty, intent) {
    const ARRIVE = 55;
    intent.mx = Math.max(-1, Math.min(1, (tx - p.x) / ARRIVE));
    intent.my = Math.max(-1, Math.min(1, (ty - p.y) / ARRIVE));
  }

  /* ─── Behaviours ─── */

  /**
   * Carrying: run at the goal, shoot once in range, and pass only when that
   * actually gains ground.
   *
   * The order matters. An earlier version checked pressure first and passed on
   * every touch, because a chaser is always inside pressureDist - the ball went
   * round in circles and no one ever got within shooting range. So: settle
   * first, then shoot, then pass, and only forward.
   */
  function _withBall(world, p, b, intent) {
    const goalX = Physics.targetGoalX(p.team);
    const goalY = CONFIG.pitchH / 2;
    const dir = Physics.attackDir(p.team);
    const dist = Math.hypot(goalX - p.x, goalY - p.y);

    /* Time on the ball, read off the immunity window rather than stored. */
    const heldFor = world.t - (b.stealLockUntil - CONFIG.stealImmunityMs / 1000);

    /*
     * Show where this would go, while it is still deciding.
     *
     * A human keeper is otherwise flying blind: the AI keeper at the other end
     * is handed an exact prediction of the crossing point the moment the ball
     * comes loose, and a person gets 457ms of flight and a guess. The tell
     * costs nothing, because it lives in a window that already existed - an AI
     * carrier must hold the ball aiSettleMs before it is allowed to shoot, and
     * that is exactly when a keeper needs to be moving. Delaying the shot
     * instead was tried and is not affordable: 300ms of commitment took grass
     * from 4.0 goals a match to 1.7 and emptied the pool scene entirely.
     */
    if (dist < CONFIG.shootRange * CONFIG.aiAimRange) {
      p.aimY = _aimTarget(world, p, goalY);
      p.aimUntil = world.t + CONFIG.aiAimHoldMs / 1000;
    }

    if (heldFor < CONFIG.aiSettleMs / 1000) {
      _steer(p, goalX, goalY + p.ai.jy * 0.6, intent);
      return;
    }

    if (dist < CONFIG.shootRange &&
        (dist < CONFIG.aiPointBlank || _laneClear(world, p, goalX, goalY))) {
      const aimY = _aimTarget(world, p, goalY);
      let dx = goalX - b.x, dy = aimY - b.y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      const noise = _jitter(p.aimNoise == null ? CONFIG.shootNoise : p.aimNoise);
      const c = Math.cos(noise), s = Math.sin(noise);
      intent.shoot = {
        dx: dx * c - dy * s,
        dy: dx * s + dy * c,
        power: Math.max(0.55, Math.min(1, dist / CONFIG.shootRange)),
      };
      return;
    }

    /* Under pressure, look for a teammate meaningfully further up the pitch.
       A sideways or backward pass just hands the ball around. */
    let nearest = Infinity;
    for (const q of world.players) {
      if (q.team === p.team) continue;
      nearest = Math.min(nearest, Math.hypot(q.x - p.x, q.y - p.y));
    }
    if (nearest < CONFIG.pressureDist) {
      const mate = Physics.passTarget(world, p);
      if (mate && (mate.x - p.x) * dir > CONFIG.aiMinPassGain) {
        intent.pass = true;
        return;
      }
    }

    _steer(p, goalX, goalY + p.ai.jy * 0.6, intent);
  }

  /** Not carrying, nearest to a ball: go and get that one. */
  function _chase(world, p, b, intent) {
    /* Lead a moving ball rather than running at where it was. */
    const lead = Math.min(0.4, Math.hypot(b.vx, b.vy) / 2200);
    _steer(p, b.x + b.vx * lead, b.y + b.vy * lead, intent);
  }

  /** Everyone else: a formation slot that slides with the ball, plus a wander. */
  function _holdSlot(world, p, intent) {
    const slot = CONFIG.formation[p.index];
    const baseX = p.team === 0 ? slot.x : CONFIG.pitchW - slot.x;
    /* The formation slides with where the play is. With several balls that is
       their average, so the shape stays one shape instead of tearing. */
    let sum = 0;
    for (const b of world.balls) sum += b.x;
    const pull = (sum / world.balls.length - CONFIG.pitchW / 2) * CONFIG.formationBallPull;
    const tx = Math.max(140, Math.min(CONFIG.pitchW - 140, baseX + pull + p.ai.jx));
    const ty = Math.max(80, Math.min(CONFIG.pitchH - 80, slot.y + p.ai.jy));
    _steer(p, tx, ty, intent);
  }

  /**
   * Keeper: sit on the line at the ball's y, come out a little for a close
   * ball, dive at a fast inbound shot, and punt after collecting one.
   * How fast it tracks is the difficulty dial.
   */
  function _keeper(world, p, mine, intent) {
    const goalX = Physics.ownGoalX(p.team);
    const centreY = CONFIG.pitchH / 2;
    const b = mine || _threat(world, goalX);

    if (mine) {
      /* Collected it - hold a beat, then punt to a teammate. */
      if (world.t > b.stealLockUntil + 0.3) intent.pass = true;
      else _steer(p, goalX + Physics.attackDir(p.team) * 60, centreY, intent);
      return;
    }

    /* Inbound: the ball is closing on the goal this keeper defends. Works for
       either end because the sign of (b.x - goalX) flips with the goal. */
    const inbound = (b.x - goalX) * b.vx < 0;
    const speed = Math.hypot(b.vx, b.vy);
    let aimY = b.y;

    if (b.carrier === null && inbound && Math.abs(b.vx) > 1) {
      /* Predict where the shot crosses the line and go there. */
      const tt = Math.abs((b.x - goalX) / b.vx);
      if (tt < 1.6) {
        aimY = b.y + b.vy * tt;
        /* The touchlines are walls, so a shot can arrive off a bounce. */
        const span = CONFIG.pitchH;
        aimY = Math.abs(((aimY % (2 * span)) + 2 * span) % (2 * span));
        if (aimY > span) aimY = 2 * span - aimY;
        /* Ask for the dive rather than setting it: physics owns when a
           keeper is airborne, and it cannot tell this apart from a child
           pressing the button. _steer below points the intent at aimY, which
           is where the dive direction comes from. */
        if (speed > 520 && tt < 0.55 && Math.abs(aimY - p.y) > 45) intent.dive = true;
      }
    }

    const reach = CONFIG.goalMouth * 0.95;
    aimY = Math.max(centreY - reach, Math.min(centreY + reach, aimY));

    /* Edge off the line when the ball is close, to cut the angle. */
    const ballDist = Math.abs(b.x - goalX);
    const advance = ballDist < 620 ? CONFIG.gkReach * 0.75 : CONFIG.gkReach * 0.25;
    _steer(p, goalX + Physics.attackDir(p.team) * advance, aimY, intent);
  }

  /**
   * The ball this keeper should be worrying about: whichever arrives at their
   * goal soonest. One that is not coming at all is ranked behind every one
   * that is, nearest first, so a keeper with nothing inbound still drifts
   * toward the closest threat rather than freezing on the match ball.
   * @param {object} world
   * @param {number} goalX - the goal this keeper defends
   * @returns {object} a ball, never null
   */
  function _threat(world, goalX) {
    let best = world.balls[0], bestScore = Infinity;
    for (const b of world.balls) {
      if (b.scored) continue;
      const dx = b.x - goalX;
      const closing = dx * b.vx < 0 && Math.abs(b.vx) > 1;
      const score = closing ? Math.abs(dx / b.vx) : 10 + Math.abs(dx) / CONFIG.pitchW;
      if (score < bestScore) { bestScore = score; best = b; }
    }
    return best;
  }

  /**
   * Where in the goal an AI carrier would put it: away from the keeper's
   * current side. Shared by the shot and the tell that precedes it, so the
   * target a keeper reads is the one the shot is actually aimed at - the
   * difficulty's aim noise is added at release, not here.
   * @param {object} world
   * @param {object} p - the carrier
   * @param {number} goalY - the centre of the goal being attacked
   * @returns {number} world y
   */
  function _aimTarget(world, p, goalY) {
    const gk = world.players.find(q => q.team !== p.team && q.role === 'gk');
    const half = CONFIG.goalMouth / 2 - CONFIG.ballRadius * 2;
    return gk ? goalY - Math.sign(gk.y - goalY || 1) * half * 0.7 : goalY;
  }

  /**
   * Is the path to the target roughly free of opponents?
   * Samples the first stretch of the shot rather than the whole line - what
   * matters is getting it away, not threading it past the keeper.
   */
  function _laneClear(world, p, tx, ty) {
    const dx = tx - p.x, dy = ty - p.y;
    const len = Math.hypot(dx, dy) || 1;
    const reach = Math.min(len, 420);
    const ux = dx / len, uy = dy / len;
    for (const q of world.players) {
      if (q.team === p.team || q.role === 'gk') continue;
      const rx = q.x - p.x, ry = q.y - p.y;
      const along = rx * ux + ry * uy;
      if (along < 0 || along > reach) continue;
      const off = Math.abs(rx * uy - ry * ux);
      if (off < 62) return false;
    }
    return true;
  }

  return { seed, think, applyDifficulty };
})();

/* Node can require this file for the logic tests; browsers ignore the guard. */
if (typeof module !== 'undefined' && module.exports) module.exports = AI;
