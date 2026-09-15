/**
 * Physics - the ball, player movement, possession and goal detection.
 *
 * No DOM. No Date.now(). Every timestamp is `world.t`, the accumulated seconds
 * of play, so a step is deterministic given (world, intents, dt) and the whole
 * module can be driven from a plain script with no browser.
 *
 * The step mutates the world in place and returns the events it produced.
 * Reallocating eight players sixty times a second buys nothing, and the seam
 * that matters - no rendering in here - is unaffected either way.
 *
 * Possession is deliberately not loose dribbling. Touching the ball takes it,
 * and it then sticks to your foot until you shoot, pass, or an opponent bumps
 * you. That is far easier for small hands than controlling a free ball.
 */
const Physics = (() => {

  /** Which way a team attacks along x. Team 0 defends the x = 0 goal. */
  function attackDir(team) { return team === 0 ? 1 : -1; }

  /** The x of the goal a team is defending. */
  function ownGoalX(team) { return team === 0 ? 0 : CONFIG.pitchW; }

  /** The x of the goal a team is attacking. */
  function targetGoalX(team) { return team === 0 ? CONFIG.pitchW : 0; }

  /** True if a world y is inside the goal mouth. */
  function inGoalMouth(y) {
    return Math.abs(y - CONFIG.pitchH / 2) <= CONFIG.goalMouth / 2;
  }

  /**
   * A fresh world: eight players in formation, ball on the centre spot.
   * @returns {object} world
   */
  function createWorld() {
    const players = [];
    for (let team = 0; team < 2; team++) {
      for (let i = 0; i < 4; i++) {
        const slot = CONFIG.formation[i];
        players.push({
          id: team * 4 + i,
          team, index: i,
          role: i === 0 ? 'gk' : 'field',
          x: team === 0 ? slot.x : CONFIG.pitchW - slot.x,
          y: slot.y,
          vx: 0, vy: 0,
          facing: attackDir(team),
          kickAt: -99,        /* world.t of the last kick, for the kick pose */
          diveUntil: -99,     /* keepers only */
          diveDir: 1,
          human: false,
          speedMult: 1,
        });
      }
    }
    return {
      t: 0,
      players,
      ball: {
        x: CONFIG.pitchW / 2, y: CONFIG.pitchH / 2,
        vx: 0, vy: 0,
        carrier: null,
        stealLockUntil: 0,   /* the carrier cannot be robbed before this */
        pickupLockUntil: 0,  /* a loose ball cannot be collected before this */
        lastTouch: null,
      },
    };
  }

  /**
   * Reset positions for a kickoff. Players return to formation, the ball to
   * the centre spot, and the kicking team gets a player on it.
   * @param {object} world
   * @param {number} kickingTeam - 0 or 1, the team that restarts
   */
  function kickoff(world, kickingTeam) {
    for (const p of world.players) {
      const slot = CONFIG.formation[p.index];
      p.x = p.team === 0 ? slot.x : CONFIG.pitchW - slot.x;
      p.y = slot.y;
      p.vx = 0; p.vy = 0;
      p.facing = attackDir(p.team);
      p.kickAt = -99;
      p.diveUntil = -99;
    }
    /* The kicking team's forward stands over the ball. */
    const taker = world.players.find(p => p.team === kickingTeam && p.index === 3);
    if (taker) {
      taker.x = CONFIG.pitchW / 2 - attackDir(kickingTeam) * CONFIG.carryOffset;
      taker.y = CONFIG.pitchH / 2;
    }
    const b = world.ball;
    b.x = CONFIG.pitchW / 2; b.y = CONFIG.pitchH / 2;
    b.vx = 0; b.vy = 0;
    b.carrier = taker ? taker.id : null;
    b.stealLockUntil = world.t + CONFIG.stealImmunityMs / 1000;
    b.pickupLockUntil = 0;
    b.lastTouch = taker ? taker.id : null;
  }

  /** Look up a player by id. Ids are assigned as array indices in createWorld. */
  function byId(world, id) {
    return id == null ? null : world.players[id] || null;
  }

  /** The player currently carrying the ball, or null. */
  function carrier(world) { return byId(world, world.ball.carrier); }

  /**
   * The teammate best placed to receive a pass: nearest in the attacking half
   * of the passer's view, falling back to nearest overall.
   * @param {object} world
   * @param {object} p - the passer
   * @returns {object|null}
   */
  function passTarget(world, p) {
    const dir = attackDir(p.team);
    let ahead = null, aheadD = Infinity, any = null, anyD = Infinity;
    for (const q of world.players) {
      if (q.team !== p.team || q.id === p.id || q.role === 'gk') continue;
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < anyD) { anyD = d; any = q; }
      if ((q.x - p.x) * dir > 0 && d < aheadD) { aheadD = d; ahead = q; }
    }
    return ahead || any;
  }

  /**
   * Advance the world one step.
   * @param {object} world
   * @param {Array<object|null>} intents - one per player id:
   *   { mx, my, shoot: {dx, dy, power}|null, pass: boolean }
   * @param {number} dt - seconds, already clamped by the caller
   * @returns {Array<object>} events produced this step
   */
  function step(world, intents, dt) {
    const events = [];
    world.t += dt;

    _applyBallIntents(world, intents, dt, events);
    _movePlayers(world, intents, dt);
    _separatePlayers(world);
    _moveBall(world, dt, events);
    if (events.some(e => e.type === 'goal')) return events;
    _resolvePossession(world, events);

    return events;
  }

  /* ─── Intents that release the ball ─── */

  function _applyBallIntents(world, intents, dt, events) {
    const b = world.ball;
    const p = carrier(world);
    if (!p) return;
    const intent = intents[p.id];
    if (!intent) return;

    if (intent.shoot) {
      const s = intent.shoot;
      const len = Math.hypot(s.dx, s.dy) || 1;
      const power = CONFIG.shootPowerMin +
        (CONFIG.shootPowerMax - CONFIG.shootPowerMin) * Math.max(0, Math.min(1, s.power));
      _release(world, p, s.dx / len * power, s.dy / len * power);
      p.kickAt = world.t;
      events.push({ type: 'kick', id: p.id, power, x: b.x, y: b.y });
      return;
    }

    if (intent.pass) {
      const mate = passTarget(world, p);
      const dir = attackDir(p.team);
      let dx = dir, dy = 0;
      if (mate) {
        /* Lead the receiver slightly so the ball arrives where they are going. */
        dx = mate.x + mate.vx * 0.25 - b.x;
        dy = mate.y + mate.vy * 0.25 - b.y;
        const len = Math.hypot(dx, dy) || 1;
        dx /= len; dy /= len;
      }
      _release(world, p, dx * CONFIG.passPower, dy * CONFIG.passPower);
      p.kickAt = world.t;
      events.push({ type: 'pass', id: p.id, to: mate ? mate.id : null, x: b.x, y: b.y });
    }
  }

  /** Let go of the ball with a velocity, and stop anyone re-collecting it at once. */
  function _release(world, p, vx, vy) {
    const b = world.ball;
    b.carrier = null;
    b.lastTouch = p.id;
    b.vx = vx; b.vy = vy;
    b.pickupLockUntil = world.t + CONFIG.looseBallMs / 1000;
  }

  /* ─── Players ─── */

  function _movePlayers(world, intents, dt) {
    const R = CONFIG.playerRadius;
    for (const p of world.players) {
      const intent = intents[p.id];
      const mx = intent ? intent.mx || 0 : 0;
      const my = intent ? intent.my || 0 : 0;
      const mag = Math.hypot(mx, my);

      /* Keepers move at their own pace, and faster again while diving. */
      let base = CONFIG.playerSpeed;
      if (p.role === 'gk') base = p.diveUntil > world.t ? CONFIG.gkDiveSpeed : CONFIG.gkTrackSpeed;
      const speed = base * (p.speedMult || 1);

      if (mag > 0.01) {
        /* Normalise so diagonal input is not faster than straight. */
        const nx = mx / Math.max(1, mag), ny = my / Math.max(1, mag);
        const tvx = nx * speed, tvy = ny * speed;
        const step = CONFIG.playerAccel * dt;
        p.vx += Math.max(-step, Math.min(step, tvx - p.vx));
        p.vy += Math.max(-step, Math.min(step, tvy - p.vy));
      } else {
        const f = Math.pow(CONFIG.playerFriction, dt * 60);
        p.vx *= f; p.vy *= f;
      }

      p.x += p.vx * dt;
      p.y += p.vy * dt;

      if (Math.abs(p.vx) > 12) p.facing = p.vx > 0 ? 1 : -1;

      /* Everyone stays on the pitch. */
      p.x = Math.max(R, Math.min(CONFIG.pitchW - R, p.x));
      p.y = Math.max(R, Math.min(CONFIG.pitchH - R, p.y));

      if (p.role === 'gk') {
        /* Keepers hold their line: near their own goal, inside the mouth's reach. */
        const goal = ownGoalX(p.team);
        const lo = Math.min(goal + CONFIG.gkReach, goal - CONFIG.gkReach);
        const hi = Math.max(goal + CONFIG.gkReach, goal - CONFIG.gkReach);
        p.x = Math.max(Math.max(R, lo), Math.min(Math.min(CONFIG.pitchW - R, hi), p.x));
        const spread = CONFIG.goalMouth * 0.95;
        p.y = Math.max(CONFIG.pitchH / 2 - spread, Math.min(CONFIG.pitchH / 2 + spread, p.y));
      }
    }
  }

  /**
   * Push overlapping players apart. Without this a chase collapses into a stack
   * and the steal rule fires every frame on the same pair.
   */
  function _separatePlayers(world) {
    const minD = CONFIG.playerRadius * 1.15;
    const ps = world.players;
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i], b = ps[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d >= minD) continue;
        if (d < 0.001) { dx = 1; dy = 0; d = 1; }   /* exactly coincident */
        const push = (minD - d) / 2;
        const ux = dx / d, uy = dy / d;
        a.x -= ux * push; a.y -= uy * push;
        b.x += ux * push; b.y += uy * push;
      }
    }
  }

  /* ─── Ball ─── */

  function _moveBall(world, dt, events) {
    const b = world.ball;
    const R = CONFIG.ballRadius;
    const p = carrier(world);

    if (p) {
      /* Glued to the carrier's foot, in the direction they are facing. */
      b.x = p.x + p.facing * CONFIG.carryOffset;
      b.y = p.y;
      b.vx = p.vx; b.vy = p.vy;
      b.x = Math.max(R, Math.min(CONFIG.pitchW - R, b.x));
      b.y = Math.max(R, Math.min(CONFIG.pitchH - R, b.y));
      return;
    }

    b.x += b.vx * dt;
    b.y += b.vy * dt;
    const f = Math.pow(CONFIG.ballFriction, dt * 60);
    b.vx *= f; b.vy *= f;
    if (Math.abs(b.vx) < 2) b.vx = 0;
    if (Math.abs(b.vy) < 2) b.vy = 0;

    /* End walls: a goal inside the mouth, a bounce everywhere else. */
    if (b.x <= R) {
      if (inGoalMouth(b.y)) {
        events.push({ type: 'goal', team: 1, x: b.x, y: b.y, by: b.lastTouch });
        return;
      }
      b.x = R;
      b.vx = -b.vx * CONFIG.wallBounce;
      events.push({ type: 'wall', speed: Math.abs(b.vx), x: b.x, y: b.y });
    } else if (b.x >= CONFIG.pitchW - R) {
      if (inGoalMouth(b.y)) {
        events.push({ type: 'goal', team: 0, x: b.x, y: b.y, by: b.lastTouch });
        return;
      }
      b.x = CONFIG.pitchW - R;
      b.vx = -b.vx * CONFIG.wallBounce;
      events.push({ type: 'wall', speed: Math.abs(b.vx), x: b.x, y: b.y });
    }

    /* Touchlines are walls too - no out of bounds, no throw-ins. */
    if (b.y <= R) {
      b.y = R;
      b.vy = -b.vy * CONFIG.wallBounce;
      events.push({ type: 'wall', speed: Math.abs(b.vy), x: b.x, y: b.y });
    } else if (b.y >= CONFIG.pitchH - R) {
      b.y = CONFIG.pitchH - R;
      b.vy = -b.vy * CONFIG.wallBounce;
      events.push({ type: 'wall', speed: Math.abs(b.vy), x: b.x, y: b.y });
    }
  }

  /* ─── Possession ─── */

  function _resolvePossession(world, events) {
    const b = world.ball;
    const holder = carrier(world);

    if (!holder) {
      if (world.t < b.pickupLockUntil) return;
      let best = null, bestD = CONFIG.pickupDist;
      for (const p of world.players) {
        const d = Math.hypot(p.x - b.x, p.y - b.y);
        if (d < bestD) { bestD = d; best = p; }
      }
      if (!best) return;
      const speed = Math.hypot(b.vx, b.vy);
      _take(world, best);
      events.push({
        type: 'pickup', id: best.id, team: best.team,
        /* A keeper collecting a fast ball is a save, and sounds like one. */
        save: best.role === 'gk' && speed > 380,
        x: b.x, y: b.y,
      });
      return;
    }

    /* Contact steals the ball. That is the whole tackle system - no fouls. */
    if (world.t < b.stealLockUntil) return;
    let thief = null, thiefD = CONFIG.stealDist;
    for (const p of world.players) {
      if (p.team === holder.team) continue;
      const d = Math.hypot(p.x - holder.x, p.y - holder.y);
      if (d < thiefD) { thiefD = d; thief = p; }
    }
    if (!thief) return;
    _take(world, thief);
    events.push({ type: 'steal', id: thief.id, from: holder.id, team: thief.team, x: b.x, y: b.y });
  }

  /** Give the ball to a player and start their immunity window. */
  function _take(world, p) {
    const b = world.ball;
    b.carrier = p.id;
    b.lastTouch = p.id;
    b.vx = 0; b.vy = 0;
    b.stealLockUntil = world.t + CONFIG.stealImmunityMs / 1000;
  }

  return {
    createWorld, kickoff, step,
    attackDir, ownGoalX, targetGoalX, inGoalMouth,
    byId, carrier, passTarget,
  };
})();

/* Node can require this file for the logic tests; browsers ignore the guard. */
if (typeof module !== 'undefined' && module.exports) module.exports = Physics;
