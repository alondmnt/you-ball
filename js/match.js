/**
 * Match - the state machine, the score and the clock.
 *
 * kickoff -> play -> goal -> kickoff -> … -> fulltime
 *
 * No DOM, no Date.now(). The caller passes elapsed seconds in and gets match
 * events out; how long a celebration takes is a config value, not a timer.
 *
 * Match owns the kickoff reset, so it calls Physics.kickoff. Both modules are
 * DOM-free, so that dependency costs nothing and keeps game.js from having to
 * know the restart rules.
 */
const Match = (() => {

  /** Phases the loop treats differently. */
  const PHASE = {
    KICKOFF: 'kickoff',   /* frozen, the banner is up */
    PLAY: 'play',         /* the world steps at full speed */
    SLOWMO: 'slowmo',     /* the world steps slowly, the ball sails in */
    GOAL: 'goal',         /* frozen, everybody dances */
    FULLTIME: 'fulltime', /* frozen, the card is up */
  };

  /**
   * A fresh match at 0-0 with the full clock.
   * @returns {object} match state
   */
  function create() {
    return {
      phase: PHASE.KICKOFF,
      phaseLeft: CONFIG.kickoffPauseMs / 1000,
      score: [0, 0],
      clock: CONFIG.matchSeconds,   /* seconds remaining */
      scorer: null,                 /* team that scored the most recent goal */
      winner: null,                 /* 0, 1, or null for a draw */
      restartTeam: 0,               /* who takes the next kickoff */
    };
  }

  /**
   * Start the match: put everyone in formation and count down to the first
   * whistle.
   * @param {object} match
   * @param {object} world
   * @param {number} [firstTeam] - who kicks off
   */
  function begin(match, world, firstTeam) {
    match.phase = PHASE.KICKOFF;
    match.phaseLeft = CONFIG.kickoffPauseMs / 1000;
    match.restartTeam = firstTeam || 0;
    Physics.kickoff(world, match.restartTeam);
  }

  /** How fast the world should step in the current phase. 0 means frozen. */
  function timeScale(match) {
    if (match.phase === PHASE.PLAY) return 1;
    if (match.phase === PHASE.SLOWMO) return CONFIG.slowMoScale;
    return 0;
  }

  /** True while the human should be able to steer. */
  function isLive(match) { return match.phase === PHASE.PLAY; }

  /**
   * Advance the match one step.
   * @param {object} match
   * @param {object} world
   * @param {number} dt - real seconds elapsed, not scaled
   * @param {Array<object>} worldEvents - what Physics.step produced, if it ran
   * @returns {Array<object>} match events: goal, kickoff, fulltime
   */
  function update(match, world, dt, worldEvents) {
    const out = [];

    /* A goal interrupts whatever phase we were in. */
    const goal = worldEvents && worldEvents.find(e => e.type === 'goal');
    if (goal && match.phase === PHASE.PLAY) {
      match.score[goal.team]++;
      match.scorer = goal.team;
      match.restartTeam = goal.team === 0 ? 1 : 0;   /* the conceding team restarts */
      match.phase = PHASE.SLOWMO;
      match.phaseLeft = CONFIG.slowMoMs / 1000;
      out.push({ type: 'goal', team: goal.team, score: match.score.slice(), x: goal.x, y: goal.y });
      return out;
    }

    if (match.phase === PHASE.PLAY) {
      match.clock -= dt;
      if (match.clock <= 0) {
        match.clock = 0;
        _finish(match, out);
      }
      return out;
    }

    match.phaseLeft -= dt;
    if (match.phaseLeft > 0) return out;

    switch (match.phase) {
      case PHASE.KICKOFF:
        match.phase = PHASE.PLAY;
        out.push({ type: 'whistle' });
        break;

      case PHASE.SLOWMO:
        /* The ball is in. Freeze it and let everybody dance. */
        match.phase = PHASE.GOAL;
        match.phaseLeft = CONFIG.goalPauseMs / 1000;
        for (const b of world.balls) { b.vx = 0; b.vy = 0; }
        out.push({ type: 'celebrate', team: match.scorer });
        break;

      case PHASE.GOAL:
        if (match.score[match.scorer] >= CONFIG.goalsToWin) {
          _finish(match, out);
        } else {
          match.phase = PHASE.KICKOFF;
          match.phaseLeft = CONFIG.kickoffPauseMs / 1000;
          match.scorer = null;
          Physics.kickoff(world, match.restartTeam);
          out.push({ type: 'kickoff', team: match.restartTeam });
        }
        break;

      default:
        match.phaseLeft = 0;   /* fulltime just sits there */
    }
    return out;
  }

  /** End the match and work out who won. */
  function _finish(match, out) {
    match.phase = PHASE.FULLTIME;
    match.phaseLeft = 0;
    match.winner = match.score[0] === match.score[1] ? null : (match.score[0] > match.score[1] ? 0 : 1);
    out.push({ type: 'fulltime', winner: match.winner, score: match.score.slice() });
  }

  /**
   * The clock as m:ss.
   * @param {object} match
   * @returns {string}
   */
  function clockText(match) {
    const total = Math.max(0, Math.ceil(match.clock));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  /**
   * Which face a team wears in the score bar right now: the GOAL face after
   * scoring, the sad face after conceding, idle otherwise.
   * @param {object} match
   * @param {number} team
   * @returns {'idle'|'goal'|'sad'}
   */
  function teamMood(match, team) {
    if (match.phase === PHASE.FULLTIME) {
      if (match.winner === null) return 'idle';
      return match.winner === team ? 'goal' : 'sad';
    }
    if (match.scorer === null) return 'idle';
    return match.scorer === team ? 'goal' : 'sad';
  }

  return { PHASE, create, begin, update, timeScale, isLive, clockText, teamMood };
})();

/* Node can require this file for the logic tests; browsers ignore the guard. */
if (typeof module !== 'undefined' && module.exports) module.exports = Match;
