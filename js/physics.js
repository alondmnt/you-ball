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

  /*
   * A seeded generator, so a bounce that scatters is still deterministic and
   * the logic tests still replay. It is deliberately a separate stream from
   * the one in ai.js: sharing would make every AI decision shift the moment a
   * scene switched the scatter on.
   */
  let _seed = 0x51ed270b;

  /** Reseed the bounce generator. Same seed, same bounces. */
  function seed(n) { _seed = (n >>> 0) || 0x51ed270b; }

  /** mulberry32. */
  function _rand() {
    _seed |= 0; _seed = (_seed + 0x6D2B79F5) | 0;
    let t = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Rotate a bounce by a random angle, for scenes where the ball should not
   * come off a wall predictably. A ball pool is not a billiard table.
   *
   * The caller re-asserts the outward direction afterwards, because a glancing
   * hit plus a big scatter could otherwise turn the ball back into the wall.
   *
   * @param {object} b - the ball, rotated in place
   */
  function _scatterBounce(b) {
    const k = CONFIG.bounceScatter || 0;
    if (!k) return;
    const a = (_rand() * 2 - 1) * k;
    const c = Math.cos(a), s = Math.sin(a);
    const vx = b.vx * c - b.vy * s;
    const vy = b.vx * s + b.vy * c;
    b.vx = vx; b.vy = vy;
  }

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
          carrySide: attackDir(team),
          kickAt: -99,        /* world.t of the last kick, for the kick pose */
          tackleAt: -99,      /* world.t of the last tackle they made */
          stunUntil: -99,     /* just been tackled - cannot steer */
          diveUntil: -99,     /* keepers only */
          diveDir: 1,
          /* An AI lining a shot up: world time the tell expires, and the point
             on the goal line it is aimed at. Physics reads neither - they are
             here so a human keeper can be shown what a human shooter gives
             away for free by winding up. */
          aimUntil: -99,
          aimY: 0,
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
        /* A fully wound kick leaves the ball burning until this. A keeper
           cannot hold a burning ball, so it is a fact about the world and not
           about the picture - render reads it, it does not own it. */
        fireUntil: -99,
        /* Set the instant a goal is detected. The ball then keeps flying into
           the net for the slow-motion beat instead of re-scoring every step. */
        scored: false,
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
      p.carrySide = p.facing;
      p.kickAt = -99;
      p.tackleAt = -99;
      p.stunUntil = -99;
      p.diveUntil = -99;
      p.aimUntil = -99;
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
    b.fireUntil = -99;
    b.scored = false;
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
   *   { mx, my, shoot: {dx, dy, power, charge}|null, pass: boolean, dive: boolean }
   * @param {number} dt - seconds, already clamped by the caller
   * @returns {Array<object>} events produced this step
   */
  function step(world, intents, dt) {
    const events = [];
    world.t += dt;

    _applyBallIntents(world, intents, dt, events);
    _applyDives(world, intents, events);
    _movePlayers(world, intents, dt);
    _separatePlayers(world);
    _moveBall(world, dt, events);
    /* After a goal nobody may collect the ball - it is flying into the net. */
    if (!world.ball.scored) _resolvePossession(world, events);

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
      /* charge rides along untouched: physics has no use for it, but it is the
         only thing that tells a wound-up kick from an AI clearance, and both
         arrive here at the same power. */
      /* A kick wound all the way up sets the ball alight. */
      const charge = s.charge || 0;
      if (charge >= 1) b.fireUntil = world.t + CONFIG.ballFireMs / 1000;
      events.push({ type: 'kick', id: p.id, power, x: b.x, y: b.y, charge });
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

  /**
   * A keeper lunges.
   *
   * Fires the moment the intent says so, never on a release: a shot is on the
   * line in well under half a second, so waiting for a key to come back up
   * would spend the whole window. You cannot dive while already diving, which
   * is the only limit it needs - the commitment below is the real cost.
   * @param {object} world
   * @param {Array<object|null>} intents
   * @param {Array<object>} events - appended to
   */
  function _applyDives(world, intents, events) {
    for (const p of world.players) {
      if (p.role !== 'gk' || p.diveUntil > world.t) continue;
      const intent = intents[p.id];
      if (!intent || !intent.dive) continue;
      p.diveUntil = world.t + CONFIG.gkDiveMs / 1000;
      /* Nothing held: go at the ball. Pressing dive has to do something or a
         child stops pressing it, and on a screen there is no stick to hold. */
      const dy = intent.my || (world.ball.y - p.y);
      p.diveDir = dy >= 0 ? 1 : -1;
      events.push({ type: 'dive', id: p.id, x: p.x, y: p.y });
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
      if (p.role === 'gk') {
        /* Airborne, then picking yourself up off the floor, then back to pace.
           The recovery is what makes when to dive a decision: without it the
           dive is a free speed button and the answer is always press it. */
        if (p.diveUntil > world.t) base = CONFIG.gkDiveSpeed;
        else if (world.t < p.diveUntil + CONFIG.gkRecoverMs / 1000) {
          base = CONFIG.gkTrackSpeed * CONFIG.gkRecoverMult;
        } else base = CONFIG.gkTrackSpeed;
      }
      if (world.ball.carrier === p.id) base *= CONFIG.carrierSpeedMult;
      const speed = base * (p.speedMult || 1);

      const stunned = p.stunUntil > world.t;
      const diving = p.role === 'gk' && p.diveUntil > world.t && !stunned;
      const steering = mag > 0.01 && !stunned;
      if (steering || diving) {
        /* Normalise so diagonal input is not faster than straight. */
        const scale = Math.max(1, mag);
        const tvx = steering ? mx / scale * speed : 0;
        /*
         * A dive with nothing held still goes, carrying the direction it was
         * launched in. That is what makes a tap control enough on a screen,
         * where there is no stick left to hold once the finger has gone. Hold
         * a direction and you steer the dive as usual - taking that away was
         * measured at 12% more goals conceded, because the keeper could no
         * longer correct a prediction that had moved.
         */
        const tvy = steering ? my / scale * speed : p.diveDir * speed;
        const step = CONFIG.playerAccel * dt;
        p.vx += Math.max(-step, Math.min(step, tvx - p.vx));
        p.vy += Math.max(-step, Math.min(step, tvy - p.vy));
      } else {
        const f = Math.pow(CONFIG.playerFriction, dt * 60);
        p.vx *= f; p.vy *= f;
      }

      const wasX = p.x, wasY = p.y;
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      if (Math.abs(p.vx) > CONFIG.facingFlipSpeed) p.facing = p.vx > 0 ? 1 : -1;
      /* The side the ball is carried on trails the facing rather than
         matching it, so a turn sweeps the ball across instead of snapping it
         the full width of the player in one frame. Nothing reads this but the
         ball's drawn position: steals measure player to player. */
      p.carrySide += (p.facing - p.carrySide) * Math.min(1, CONFIG.carryTurnRate * dt);

      /* Everyone stays on the pitch. */
      p.x = Math.max(R, Math.min(CONFIG.pitchW - R, p.x));
      p.y = Math.max(R, Math.min(CONFIG.pitchH - R, p.y));

      /*
       * Keepers hold their line: near their own goal, inside the mouth's reach.
       *
       * Two things this is deliberately not. It lets go entirely while the
       * keeper is carrying, so one who has collected the ball can charge
       * upfield and leave the goal empty - a real risk, and the first thing a
       * child will try. And it is a wall from the inside rather than a leash:
       * it only bites on a player who was on the right side of it a moment
       * ago, so a keeper coming home from midfield runs back rather than being
       * snapped there. The AI keeper never leaves, so for it nothing changed.
       */
      if (p.role === 'gk' && world.ball.carrier !== p.id) {
        const goal = ownGoalX(p.team);
        const lo = Math.max(R, Math.min(goal + CONFIG.gkReach, goal - CONFIG.gkReach));
        const hi = Math.min(CONFIG.pitchW - R, Math.max(goal + CONFIG.gkReach, goal - CONFIG.gkReach));
        if (wasX >= lo && wasX <= hi) p.x = Math.max(lo, Math.min(hi, p.x));
        const spread = CONFIG.goalMouth * 0.95;
        const yLo = CONFIG.pitchH / 2 - spread, yHi = CONFIG.pitchH / 2 + spread;
        if (wasY >= yLo && wasY <= yHi) p.y = Math.max(yLo, Math.min(yHi, p.y));
      }
    }
  }

  /**
   * Push overlapping players apart. Without this a chase collapses into a stack
   * and the steal rule fires every frame on the same pair.
   */
  function _separatePlayers(world) {
    /* Must stay under stealDist, or contact could never happen at all. */
    const minD = CONFIG.playerRadius * 1.6;
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
      /* Glued to the carrier's foot, on the side they are turning towards. */
      b.x = p.x + p.carrySide * CONFIG.carryOffset;
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

    /* End walls: a goal inside the mouth, a bounce everywhere else. Once a
       goal is scored the end walls stop existing, so the ball carries on into
       the net while the celebration plays. */
    if (!b.scored) {
      if (b.x <= R) {
        if (inGoalMouth(b.y)) {
          b.scored = true;
          b.carrier = null;   /* a walked-in goal must roll on, not stay glued */
          events.push({ type: 'goal', team: 1, x: b.x, y: b.y, by: b.lastTouch });
        } else {
          b.x = R;
          b.vx = -b.vx * CONFIG.wallBounce;
          _scatterBounce(b);
          if (b.vx < 0) b.vx = -b.vx;
          events.push({ type: 'wall', speed: Math.abs(b.vx), x: b.x, y: b.y });
        }
      } else if (b.x >= CONFIG.pitchW - R) {
        if (inGoalMouth(b.y)) {
          b.scored = true;
          b.carrier = null;   /* a walked-in goal must roll on, not stay glued */
          events.push({ type: 'goal', team: 0, x: b.x, y: b.y, by: b.lastTouch });
        } else {
          b.x = CONFIG.pitchW - R;
          b.vx = -b.vx * CONFIG.wallBounce;
          _scatterBounce(b);
          if (b.vx > 0) b.vx = -b.vx;
          events.push({ type: 'wall', speed: Math.abs(b.vx), x: b.x, y: b.y });
        }
      }
    }

    /* Touchlines are walls too - no out of bounds, no throw-ins. */
    if (b.y <= R) {
      b.y = R;
      b.vy = -b.vy * CONFIG.wallBounce;
      _scatterBounce(b);
      if (b.vy < 0) b.vy = -b.vy;
      events.push({ type: 'wall', speed: Math.abs(b.vy), x: b.x, y: b.y });
    } else if (b.y >= CONFIG.pitchH - R) {
      b.y = CONFIG.pitchH - R;
      b.vy = -b.vy * CONFIG.wallBounce;
      _scatterBounce(b);
      if (b.vy > 0) b.vy = -b.vy;
      events.push({ type: 'wall', speed: Math.abs(b.vy), x: b.x, y: b.y });
    }
  }

  /* ─── Possession ─── */

  /**
   * A keeper beats a burning ball away instead of catching it.
   *
   * This is what a wound-up kick actually buys. Speed alone bought almost
   * nothing - measured over a grid of distances and angles, going from 770 to
   * 1400 units/s moved the goals from 30% to 33%, because the keeper predicts
   * the crossing point exactly and the mouth is small enough that it always
   * gets there. A parry does not beat the keeper either; it leaves the ball
   * live in front of an open goal, which is a chance rather than a certainty.
   *
   * The parry puts the fire out. Otherwise the rebound is still burning, the
   * keeper cannot hold that either, and the ball pings off it forever.
   * @param {object} world
   * @param {object} gk - the keeper
   * @param {Array<object>} events - appended to
   */
  function _parry(world, gk, events) {
    const b = world.ball;
    const speed = Math.hypot(b.vx, b.vy);
    const out = attackDir(gk.team);                 /* away from the goal behind them */
    const side = (b.y - gk.y) >= 0 ? 1 : -1;        /* spills the side it struck */
    const v = Math.max(CONFIG.parryMinSpeed, speed * CONFIG.parryKeep);
    b.vx = out * v * 0.78;
    b.vy = side * v * 0.62;
    b.lastTouch = gk.id;
    b.pickupLockUntil = world.t + CONFIG.looseBallMs / 1000;
    b.fireUntil = world.t;
    gk.diveUntil = Math.max(gk.diveUntil, world.t + CONFIG.gkDiveMs / 1000);
    gk.diveDir = side;
    events.push({ type: 'parry', id: gk.id, team: gk.team, x: b.x, y: b.y });
  }

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
      if (best.role === 'gk' && world.t < b.fireUntil) { _parry(world, best, events); return; }
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
    /*
     * Except from a keeper who has hold of it. Their immunity runs out at
     * stealImmunityMs but their own AI holds the ball for 300ms longer before
     * punting, and that gap was a free goal: stand next to them, take it off
     * their hands the instant immunity lapses, and the steal knocks them clear
     * of their own goal and stuns them. Measured at 21 goals from 21 attempts,
     * 617ms after every save, from as far as 160 units away. It was the safest
     * way to score in the game.
     */
    if (holder.role === 'gk') return;
    let thief = null, thiefD = CONFIG.stealDist;
    for (const p of world.players) {
      if (p.team === holder.team) continue;
      const d = Math.hypot(p.x - holder.x, p.y - holder.y);
      if (d < thiefD) { thiefD = d; thief = p; }
    }
    if (!thief) return;
    _take(world, thief);
    thief.tackleAt = world.t;

    /* Knock the dispossessed player clear and stun them briefly. This is what
       stops the two of them trading the ball back and forth on the spot. */
    let dx = holder.x - thief.x, dy = holder.y - thief.y;
    const d = Math.hypot(dx, dy) || 1;
    const clear = CONFIG.stealDist * CONFIG.tackleClearance;
    holder.x = thief.x + (dx / d) * clear;
    holder.y = thief.y + (dy / d) * clear;
    holder.x = Math.max(CONFIG.playerRadius, Math.min(CONFIG.pitchW - CONFIG.playerRadius, holder.x));
    holder.y = Math.max(CONFIG.playerRadius, Math.min(CONFIG.pitchH - CONFIG.playerRadius, holder.y));
    holder.vx = 0; holder.vy = 0;
    holder.stunUntil = world.t + CONFIG.tackleStunMs / 1000;

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
    seed, createWorld, kickoff, step,
    attackDir, ownGoalX, targetGoalX, inGoalMouth,
    byId, carrier, passTarget,
  };
})();

/* Node can require this file for the logic tests; browsers ignore the guard. */
if (typeof module !== 'undefined' && module.exports) module.exports = Physics;
