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
      /*
       * Every ball in play. balls[0] is the match ball and is always there;
       * a star match adds more and a kickoff drops them again. There is
       * deliberately no `world.ball`: with more than one in play, code that
       * reaches for "the ball" is almost always asking the wrong question,
       * and an alias for balls[0] would let it do so silently.
       */
      balls: [newBall(CONFIG.pitchW / 2, CONFIG.pitchH / 2)],
      /* The star sitting on the pitch right now, or null for almost always. */
      star: null,
      /* World time the star is due. -1 once it has been and gone, and in the
         three matches out of four that never had one. */
      starAt: -1,
      /* World time the extra balls go away again. 0 when there are none. */
      multiUntil: 0,
    };
  }

  /**
   * A ball sitting still at a point, owned by nobody.
   * @param {number} x
   * @param {number} y
   * @returns {object}
   */
  function newBall(x, y) {
    return {
      x, y,
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
    };
  }

  /**
   * Decide whether this is a star match, and when the star turns up.
   *
   * Rolled once, at the start of the match, off the same seeded stream as the
   * bounces - so a seed replays a match exactly, star and all. Most matches
   * roll no star, which is what makes the ones that do worth remembering.
   * @param {object} world
   */
  function planStar(world) {
    world.star = null;
    if (_rand() >= CONFIG.starChance) { world.starAt = -1; return; }
    const lo = CONFIG.matchSeconds * CONFIG.starEarliest;
    const hi = CONFIG.matchSeconds * CONFIG.starLatest;
    world.starAt = world.t + lo + _rand() * (hi - lo);
  }

  /**
   * Put the star out, hand it to whoever runs into it, or take it away again.
   *
   * Only a player a person is actually driving can collect one. An AI
   * teammate blundering into it would hand the child the whole thing for
   * nothing, and this is meant to be the one moment in the game worth leaving
   * the ball for. `p.human` is world state, kept current by AI.applyDifficulty
   * every time control moves.
   * @param {object} world
   * @param {Array<object>} events - appended to
   */
  function _star(world, events) {
    /*
     * A goal is in flight: the star is neither offered, taken, nor timed out
     * until the restart. Physics keeps stepping through the slow-motion beat,
     * so a child running at the star could reach it while the ball sails in -
     * and the kickoff a second later would sweep the extra balls straight back
     * up, spending the only star of the match on nothing. Held instead, the
     * kickoff puts it back for another go.
     */
    for (const b of world.balls) if (b.scored) return;

    if (!world.star) {
      if (world.starAt < 0 || world.t < world.starAt) return;
      /*
       * Nobody out there who could fetch it, so there is no star.
       *
       * A keeper is held near their own goal by the line clamp and the star
       * lands in the middle third: measured, two keepers sprinting at a centre
       * star for its whole life get no closer than 1010 units of the 80 they
       * need. With both seats in goal - which is a way the children do play,
       * because it needs no running - the star would appear, expire, come back
       * after the next kickoff and appear again, none of it ever reachable.
       * A prize on screen that cannot be won is worse than no prize.
       */
      if (!_canFetch(world)) { world.starAt = -1; return; }
      /* Out in the middle somewhere: never tucked in a goalmouth, where it
         would be either a gift or unreachable depending on the end. */
      const x = CONFIG.pitchW * (0.25 + _rand() * 0.5);
      const y = CONFIG.pitchH * (0.18 + _rand() * 0.64);
      world.star = { x, y, until: world.t + CONFIG.starLifeMs / 1000 };
      world.starAt = -1;
      events.push({ type: 'star', x, y });
      return;
    }

    const s = world.star;
    for (const p of world.players) {
      if (!p.human) continue;
      if (Math.hypot(p.x - s.x, p.y - s.y) > CONFIG.starReach) continue;
      world.star = null;
      _burst(world, s.x, s.y);
      events.push({ type: 'starGot', id: p.id, team: p.team, x: s.x, y: s.y });
      return;
    }
    if (world.t > s.until) {
      world.star = null;
      events.push({ type: 'starGone', x: s.x, y: s.y });
    }
  }

  /** Is there a human-driven player on the pitch who could reach a star? */
  function _canFetch(world) {
    for (const p of world.players) if (p.human && p.role !== 'gk') return true;
    return false;
  }

  /**
   * The star breaks into balls.
   *
   * They come out of the star itself rather than off the centre spot, so the
   * thing a child just ran across the pitch for visibly becomes the thing that
   * happens. Spread evenly around a seeded starting angle, so a replay of the
   * same seed scatters them the same way.
   *
   * They are loose for the usual moment after a release, which stops the
   * collector from instantly owning all three.
   * @param {object} world
   * @param {number} x - where the star was
   * @param {number} y
   */
  function _burst(world, x, y) {
    const n = CONFIG.multiBallCount;
    const from = _rand() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const a = from + (i / n) * Math.PI * 2;
      const b = newBall(x, y);
      b.vx = Math.cos(a) * CONFIG.multiBallBurst;
      b.vy = Math.sin(a) * CONFIG.multiBallBurst;
      b.pickupLockUntil = world.t + CONFIG.looseBallMs / 1000;
      world.balls.push(b);
    }
    world.multiUntil = world.t + CONFIG.multiBallMs / 1000;
  }

  /** Take the extra balls away again when their time is up. */
  function _expireExtras(world, events) {
    if (!world.multiUntil || world.t < world.multiUntil) return;
    world.multiUntil = 0;
    if (world.balls.length < 2) return;
    const gone = world.balls.splice(1).map(b => ({ x: b.x, y: b.y }));
    events.push({ type: 'multiEnd', gone });
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
    /* A star nobody reached comes back after the restart. Losing the only
       star of the match to someone else's goal would make a rare thing rarer
       for no reason anyone watching could name. */
    if (world.star) {
      world.star = null;
      world.starAt = world.t + CONFIG.starRetryMs / 1000;
    }

    /* Whatever a star match added is gone; a kickoff is always one ball. */
    world.balls.length = 1;
    world.multiUntil = 0;
    const b = world.balls[0];
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

  /** The match ball, the one a kickoff puts on the centre spot. */
  function mainBall(world) { return world.balls[0]; }

  /** The player carrying a given ball, or null. */
  function carrierOf(world, ball) { return byId(world, ball.carrier); }

  /**
   * The ball a player is carrying, or null. Nobody can hold two at once, so
   * this is the question most callers actually mean by "has the ball".
   * @param {object} world
   * @param {number} id - player id
   * @returns {object|null}
   */
  function ballOf(world, id) {
    for (const b of world.balls) if (b.carrier === id) return b;
    return null;
  }

  /**
   * The ball closest to a point.
   * @param {object} world
   * @param {number} x
   * @param {number} y
   * @returns {object} never null - there is always a match ball
   */
  function nearestBall(world, x, y) {
    let best = world.balls[0], bestD = Infinity;
    for (const b of world.balls) {
      const d = Math.hypot(b.x - x, b.y - y);
      if (d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

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
    _moveBalls(world, dt, events);
    _resolvePossession(world, events);
    _star(world, events);
    _expireExtras(world, events);

    return events;
  }

  /* ─── Intents that release the ball ─── */

  function _applyBallIntents(world, intents, dt, events) {
    for (const b of world.balls) _ballIntent(world, b, intents, events);
  }

  /** Apply whatever this ball's carrier asked for. */
  function _ballIntent(world, b, intents, events) {
    const p = carrierOf(world, b);
    if (!p) return;
    const intent = intents[p.id];
    if (!intent) return;

    if (intent.shoot) {
      const s = intent.shoot;
      const len = Math.hypot(s.dx, s.dy) || 1;
      const power = CONFIG.shootPowerMin +
        (CONFIG.shootPowerMax - CONFIG.shootPowerMin) * Math.max(0, Math.min(1, s.power));
      _release(world, b, p, s.dx / len * power, s.dy / len * power);
      p.kickAt = world.t;
      /* charge rides along untouched: physics has no use for it, but it is the
         only thing that tells a wound-up kick from an AI clearance, and both
         arrive here at the same power. */
      /* A kick wound all the way up sets the ball alight. */
      const charge = s.charge || 0;
      /* Only a fireball is looked ahead for: the whole point of the look-ahead
         is the one shot worth slowing the world down for, and doing it on
         every kick would spend 300 steps of arithmetic several times a second
         to answer a question nobody asked. */
      let flight = null;
      if (charge >= 1) {
        b.fireUntil = world.t + CONFIG.ballFireMs / 1000;
        flight = _lookAhead(world, b);
      }
      events.push({ type: 'kick', id: p.id, power, x: b.x, y: b.y, charge, flight });
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
      _release(world, b, p, dx * CONFIG.passPower, dy * CONFIG.passPower);
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
      const dy = intent.my || (nearestBall(world, p.x, p.y).y - p.y);
      p.diveDir = dy >= 0 ? 1 : -1;
      events.push({ type: 'dive', id: p.id, x: p.x, y: p.y });
    }
  }

  /* A scratch ball for looking ahead, so a prediction allocates nothing. */
  const _probe = newBall(0, 0);
  const _probeEvents = [];
  const LOOK_DT = 1 / 60;
  const LOOK_MAX = 300;      /* 5s, longer than any shot stays alive */

  /**
   * How long this ball would take to reach the goal it is heading for, with
   * nobody touching it. null when it would not go in at all.
   *
   * Runs the real integrator over a scratch copy rather than a second copy of
   * the arithmetic, so friction, the touchlines and the goal mouth can never
   * drift apart from what actually happens on the pitch. The bounce generator
   * is saved and put back around it, because looking ahead must not change the
   * match - in a scene that scatters bounces, a prediction that consumed the
   * stream would alter every bounce that followed it.
   * @param {object} world
   * @param {object} b - the ball; not modified
   * @returns {number|null} seconds of flight, or null if it is off target
   */
  function _lookAhead(world, b) {
    const seed = _seed;
    Object.assign(_probe, b);
    _probe.carrier = null;
    _probe.scored = false;
    let t = 0;
    for (let i = 0; i < LOOK_MAX; i++) {
      _probeEvents.length = 0;
      _moveOne(world, _probe, LOOK_DT, _probeEvents);
      t += LOOK_DT;
      if (_probe.scored) { _seed = seed; return t; }
      if (Math.hypot(_probe.vx, _probe.vy) < 40) break;
    }
    _seed = seed;
    return null;
  }

  /** Let go of the ball with a velocity, and stop anyone re-collecting it at once. */
  function _release(world, b, p, vx, vy) {
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
      if (ballOf(world, p.id)) base *= CONFIG.carrierSpeedMult;
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
      if (p.role === 'gk' && !ballOf(world, p.id)) {
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

  function _moveBalls(world, dt, events) {
    for (const b of world.balls) _moveOne(world, b, dt, events);
  }

  function _moveOne(world, b, dt, events) {
    const R = CONFIG.ballRadius;
    const p = carrierOf(world, b);

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
  function _parry(world, b, gk, events) {
    const speed = Math.hypot(b.vx, b.vy);
    const out = attackDir(gk.team);                 /* away from the goal behind them */

    /*
     * It comes off the way it went on.
     *
     * The ball is reflected about the line from the keeper to it, the same as
     * a wall bounce: struck at their middle it comes straight back, catching
     * them on the edge it glances away. This used to send every parry out at
     * one fixed angle whatever the ball did on the way in, which is what made
     * it look as though the keeper had never touched it - the deflection bore
     * no relation to the hit.
     */
    let nx = b.x - gk.x, ny = b.y - gk.y;
    const d = Math.hypot(nx, ny) || 1;
    nx /= d; ny /= d;
    const dot = b.vx * nx + b.vy * ny;
    let rx = b.vx - 2 * dot * nx;
    let ry = b.vy - 2 * dot * ny;
    /* Never off into the net behind them, whatever the geometry says. */
    if (rx * out < 0) rx = -rx;
    const rl = Math.hypot(rx, ry) || 1;
    const v = Math.max(CONFIG.parryMinSpeed, speed * CONFIG.parryKeep);
    b.vx = rx / rl * v;
    b.vy = ry / rl * v;

    /* And it starts from the contact, not from wherever it happened to be
       inside pickupDist, so the rebound visibly comes off the keeper. */
    b.x = gk.x + nx * (CONFIG.playerRadius + CONFIG.ballRadius);
    b.y = gk.y + ny * (CONFIG.playerRadius + CONFIG.ballRadius);
    b.x = Math.max(CONFIG.ballRadius, Math.min(CONFIG.pitchW - CONFIG.ballRadius, b.x));
    b.y = Math.max(CONFIG.ballRadius, Math.min(CONFIG.pitchH - CONFIG.ballRadius, b.y));

    const side = ny >= 0 ? 1 : -1;                  /* which way they threw themselves */
    b.lastTouch = gk.id;
    b.pickupLockUntil = world.t + CONFIG.looseBallMs / 1000;
    b.fireUntil = world.t;
    gk.diveUntil = Math.max(gk.diveUntil, world.t + CONFIG.gkDiveMs / 1000);
    gk.diveDir = side;
    events.push({ type: 'parry', id: gk.id, team: gk.team, x: b.x, y: b.y });
  }

  function _resolvePossession(world, events) {
    /* After a goal nobody may collect that ball - it is flying into the net.
       The others carry on: in a star match the rest of the pitch is still
       live while one of them sails in. */
    for (const b of world.balls) if (!b.scored) _resolveOne(world, b, events);
  }

  function _resolveOne(world, b, events) {
    const holder = carrierOf(world, b);

    if (!holder) {
      if (world.t < b.pickupLockUntil) return;
      let best = null, bestD = CONFIG.pickupDist;
      for (const p of world.players) {
        /*
         * Hands full: nobody dribbles two balls at once.
         *
         * This takes a keeper who has collected one out of the running for the
         * others too, which is deliberate rather than a side effect - and it
         * costs less than it sounds. Their own AI punts 800ms after collecting,
         * so across 240 star matches a keeper's hands are full for 8-12% of
         * multi-ball and concede 6-12% of its goals: at or below the time
         * share, so holding is not measurably costing saves.
         */
        if (ballOf(world, p.id)) continue;
        const d = Math.hypot(p.x - b.x, p.y - b.y);
        if (d < bestD) { bestD = d; best = p; }
      }
      if (!best) return;
      const speed = Math.hypot(b.vx, b.vy);
      if (best.role === 'gk' && world.t < b.fireUntil) { _parry(world, b, best, events); return; }
      _take(world, b, best);
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
      if (ballOf(world, p.id)) continue;   /* already has one of their own */
      const d = Math.hypot(p.x - holder.x, p.y - holder.y);
      if (d < thiefD) { thiefD = d; thief = p; }
    }
    if (!thief) return;
    _take(world, b, thief);
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
  function _take(world, b, p) {
    b.carrier = p.id;
    b.lastTouch = p.id;
    b.vx = 0; b.vy = 0;
    b.stealLockUntil = world.t + CONFIG.stealImmunityMs / 1000;
  }

  return {
    seed, createWorld, newBall, planStar, kickoff, step,
    attackDir, ownGoalX, targetGoalX, inGoalMouth,
    byId, mainBall, carrierOf, ballOf, nearestBall, passTarget,
  };
})();

/* Node can require this file for the logic tests; browsers ignore the guard. */
if (typeof module !== 'undefined' && module.exports) module.exports = Physics;
