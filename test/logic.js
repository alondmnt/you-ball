/**
 * Logic tests for the DOM-free modules.
 *
 *   node test/logic.js
 *
 * physics.js, ai.js and match.js never touch the DOM, so they run in a plain
 * node vm with nothing but Math and console. That is the whole point of the
 * seam: if a change here needs a browser to test, the seam has been broken.
 *
 * These are the checks a rendering bug cannot hide - a goal scores, the clock
 * expires, steal immunity holds, and the same seed replays the same match.
 */
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.join(__dirname, '..', 'js');
const ctx = vm.createContext({ Math, console, module: undefined });
for (const f of ['config.js', 'physics.js', 'ai.js', 'match.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
/* Top-level const in a vm context lives in the lexical scope, not on the
   sandbox object, so pull the namespaces out by evaluating them there. */
const { CONFIG, Physics, AI, Match } = vm.runInContext('({CONFIG, Physics, AI, Match})', ctx);

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
};
const DT = 1 / 60;

/**
 * Run a whole AI-vs-AI match and collect everything that happened.
 * @param {number} maxSeconds - give up after this much simulated time
 * @param {string} [scene] - which scene's values to play under
 * @param {number} [seed] - AI and bounce seed
 */
function simulate(maxSeconds, scene, seed) {
  CONFIG.applyScene(scene || 'grass');
  AI.seed(seed || 12345);
  if (Physics.seed) Physics.seed((seed || 12345) ^ 0x5bf03635);
  const world = Physics.createWorld();
  const match = Match.create();
  AI.applyDifficulty(world, []);
  Match.begin(match, world, 0);
  const intents = world.players.map(() => ({ mx: 0, my: 0, shoot: null, pass: false }));
  const log = [];
  let outOfBounds = 0, steps = 0;

  for (let t = 0; t < maxSeconds / DT; t++) {
    steps++;
    const scale = Match.timeScale(match);
    let worldEvents = [];
    if (scale > 0) {
      AI.think(world, new Set(), intents);
      worldEvents = Physics.step(world, intents, DT * scale);
    }
    for (const e of worldEvents) log.push(e);
    for (const e of Match.update(match, world, DT, worldEvents)) log.push(e);

    const b = world.ball;
    if (!b.scored && (b.x < -1 || b.x > CONFIG.pitchW + 1 || b.y < -1 || b.y > CONFIG.pitchH + 1)) outOfBounds++;
    for (const p of world.players) {
      if (p.x < 0 || p.x > CONFIG.pitchW || p.y < 0 || p.y > CONFIG.pitchH) outOfBounds++;
    }
    if (match.phase === Match.PHASE.FULLTIME) break;
  }
  return { world, match, log, outOfBounds, steps };
}

console.log('\n-- full match, AI vs AI --');
const r = simulate(400);
ok('match reaches full time', r.match.phase === Match.PHASE.FULLTIME, r.match.phase);
const goals = r.log.filter(e => e.type === 'goal' && e.score);
ok('goals are scored', goals.length > 0, goals.length + ' goals');
ok('score matches goal events', r.match.score[0] + r.match.score[1] === goals.length,
   JSON.stringify(r.match.score) + ' vs ' + goals.length);
ok('ball and players stay on the pitch', r.outOfBounds === 0, r.outOfBounds + ' violations');
ok('a win ends the match at goalsToWin',
   r.match.clock <= 0 || Math.max(...r.match.score) === CONFIG.goalsToWin,
   'clock=' + r.match.clock.toFixed(1) + ' score=' + r.match.score);
ok('every kickoff clears the scored flag',
   r.match.phase !== Match.PHASE.PLAY || r.world.ball.scored === false);
ok('kicks and pickups both happen',
   r.log.some(e => e.type === 'kick') && r.log.some(e => e.type === 'pickup'));
ok('exactly one goal event per goal (no re-scoring)',
   r.log.filter(e => e.type === 'goal' && e.by !== undefined).length === goals.length,
   r.log.filter(e => e.type === 'goal' && e.by !== undefined).length + ' physics vs ' + goals.length + ' match');

console.log('\n-- goal detection and walls --');
{
  const w = Physics.createWorld();
  const noIntents = w.players.map(() => ({ mx: 0, my: 0, shoot: null, pass: false }));
  for (const p of w.players) { p.x = 1200; p.y = 40; }        /* everyone out of the way */
  w.ball.carrier = null; w.ball.x = 300; w.ball.y = CONFIG.pitchH / 2;
  w.ball.vx = -1200; w.ball.vy = 0; w.ball.pickupLockUntil = 999;
  let got = null;
  for (let i = 0; i < 120 && !got; i++) got = Physics.step(w, noIntents, DT).find(e => e.type === 'goal');
  ok('a shot into the mouth scores', !!got && got.team === 1, got && got.team);
}
{
  const w = Physics.createWorld();
  const noIntents = w.players.map(() => ({ mx: 0, my: 0, shoot: null, pass: false }));
  for (const p of w.players) { p.x = 1200; p.y = 40; }
  w.ball.carrier = null; w.ball.x = 300; w.ball.y = 60;        /* well outside the mouth */
  w.ball.vx = -1200; w.ball.vy = 0; w.ball.pickupLockUntil = 999;
  const seen = [];
  for (let i = 0; i < 120; i++) seen.push(...Physics.step(w, noIntents, DT));
  ok('a shot outside the mouth bounces, never scores',
     !seen.some(e => e.type === 'goal') && seen.some(e => e.type === 'wall'));
  ok('the bounce reverses the ball', w.ball.vx > 0, w.ball.vx.toFixed(0));
}

console.log('\n-- possession --');
{
  const w = Physics.createWorld();
  const noIntents = w.players.map(() => ({ mx: 0, my: 0, shoot: null, pass: false }));
  const holder = w.players[3], thief = w.players[7];
  holder.x = 1200; holder.y = 450;
  thief.x = 1200 + CONFIG.stealDist * 0.5; thief.y = 450;
  for (const p of w.players) if (p !== holder && p !== thief) { p.x = 100; p.y = 40; }
  w.ball.carrier = holder.id; w.ball.stealLockUntil = w.t + CONFIG.stealImmunityMs / 1000;

  let stolenAt = null, carrierAtSteal = null;
  for (let i = 0; i < 90; i++) {
    const evs = Physics.step(w, noIntents, DT);
    if (!stolenAt && evs.some(e => e.type === 'steal')) { stolenAt = w.t; carrierAtSteal = w.ball.carrier; }
  }
  ok('steal immunity holds for its full window',
     stolenAt !== null && stolenAt >= CONFIG.stealImmunityMs / 1000,
     'stolen at ' + (stolenAt === null ? 'never' : stolenAt.toFixed(3) + 's'));
  ok('the steal hands the ball to the thief', carrierAtSteal === thief.id, String(carrierAtSteal));
}
{
  const w = Physics.createWorld();
  const intents = w.players.map(() => ({ mx: 0, my: 0, shoot: null, pass: false }));
  const p = w.players[3];
  p.x = 1200; p.y = 450; p.facing = 1;
  for (const q of w.players) if (q !== p) { q.x = 100; q.y = 40; }
  w.ball.carrier = p.id;
  intents[p.id].shoot = { dx: 1, dy: 0, power: 1 };
  const evs = Physics.step(w, intents, DT);
  ok('shooting releases the ball', w.ball.carrier === null && evs.some(e => e.type === 'kick'));
  ok('full power uses shootPowerMax',
     Math.abs(w.ball.vx) > CONFIG.shootPowerMax * 0.9, w.ball.vx.toFixed(0));
  intents[p.id].shoot = null;
  let reclaimed = -1;
  for (let i = 0; i < 60; i++) { Physics.step(w, intents, DT); if (w.ball.carrier !== null && reclaimed < 0) reclaimed = w.t; }
  ok('the shooter cannot instantly re-collect', reclaimed === -1 || reclaimed >= CONFIG.looseBallMs / 1000);
}

console.log('\n-- clock --');
{
  const w = Physics.createWorld();
  const m = Match.create();
  Match.begin(m, w, 0);
  let evs = [];
  for (let i = 0; i < (CONFIG.matchSeconds + 10) / DT; i++) {
    evs = Match.update(m, w, DT, []);
    if (m.phase === Match.PHASE.FULLTIME) break;
  }
  ok('a goalless match ends on the clock', m.phase === Match.PHASE.FULLTIME && m.clock === 0);
  ok('a goalless match is a draw', m.winner === null && evs.some(e => e.type === 'fulltime'));
  ok('clock text formats as m:ss', Match.clockText({ clock: 68 }) === '1:08', Match.clockText({ clock: 68 }));
}

console.log('\n-- every scene is playable --');
/*
 * A scene changes real physics, not just colours, so each one has to be
 * checked the way grass is. An early pool that slowed players and blunted
 * their acceleration made the pitch effectively too long: the AI never got
 * the ball into shooting range and every match finished nil-nil. That is
 * exactly the failure this catches, and it is invisible from a screenshot.
 */
{
  const RUNS = 6;
  /*
   * Pin difficulty neutral. It is an independent dial, and a multiplier
   * applied to both sides at once is not a configuration anyone plays - with
   * a human on the pitch it only ever touches the opposition. Leaving it in
   * made a scene check fail when the normal preset was softened, which says
   * nothing about the scene.
   */
  const wasDifficulty = CONFIG.difficulty;
  CONFIG.difficulties.__even = { aiSpeed: 1, gkTrack: 1, shootNoise: 1 };
  CONFIG.difficulty = '__even';
  for (const scene of Object.keys(CONFIG.scenes)) {
    let goals = 0, nilNil = 0, finished = 0;
    for (let i = 0; i < RUNS; i++) {
      const r = simulate(400, scene, 5000 + i * 7919);
      const total = r.match.score[0] + r.match.score[1];
      goals += total;
      if (total === 0) nilNil++;
      if (r.match.phase === Match.PHASE.FULLTIME) finished++;
      if (r.outOfBounds) { fail++; console.log(`  FAIL ${scene} let something off the pitch`); }
    }
    const perMatch = goals / RUNS;
    ok(`${scene}: every match finishes`, finished === RUNS, `${finished}/${RUNS}`);
    ok(`${scene}: goals get scored`, perMatch >= 1.0, perMatch.toFixed(1) + ' per match');
    ok(`${scene}: not a goalless scene`, nilNil <= 1, nilNil + ' of ' + RUNS + ' nil-nil');
  }
  CONFIG.applyScene('grass');
  CONFIG.difficulty = wasDifficulty;
  delete CONFIG.difficulties.__even;
}

console.log('\n-- difficulty --');
/*
 * Difficulty used to slow every AI player on the pitch, so turning it down
 * handicapped your own teammates and keeper as much as the opposition. These
 * check the rule directly rather than by scoreline.
 */
{
  const w = Physics.createWorld();
  CONFIG.difficulty = 'easy';
  AI.applyDifficulty(w, new Set([1]));          /* a human on team 0 */
  const ours = w.players.filter(p => p.team === 0);
  const theirs = w.players.filter(p => p.team === 1);
  ok('your own side is never handicapped by the difficulty',
     ours.every(p => p.speedMult === 1),
     ours.map(p => p.speedMult).join(','));
  ok('the opposition is', theirs.every(p => p.speedMult < 1),
     theirs.map(p => p.speedMult).join(','));
  ok('and their aim is loosened, yours is not',
     ours.every(p => p.aimNoise === CONFIG.shootNoise) && theirs.every(p => p.aimNoise > CONFIG.shootNoise));

  /* Harder than normal is the property that matters. Whether the opposition
     ends up above full speed is incidental and used to be asserted here,
     which broke the moment the presets were softened. */
  CONFIG.difficulty = 'normal';
  AI.applyDifficulty(w, new Set([1]));
  const oppOnNormal = w.players[5].speedMult;
  CONFIG.difficulty = 'hard';
  AI.applyDifficulty(w, new Set([1]));
  ok('hard makes the opposition quicker than normal does',
     w.players[5].speedMult > oppOnNormal,
     oppOnNormal + ' -> ' + w.players[5].speedMult);
  ok('your side is still untouched on hard',
     w.players.filter(p => p.team === 0).every(p => p.speedMult === 1));

  /* Two humans, one per side: nobody gets the multiplier. */
  AI.applyDifficulty(w, new Set([1, 5]));
  ok('two players means an even match', w.players.every(p => p.speedMult === 1));

  /* No human at all, as in the scene checks above: both sides get it. */
  AI.applyDifficulty(w, new Set());
  const hard = CONFIG.difficulties.hard;
  ok('with nobody human both sides get it',
     w.players.every(p => p.speedMult === (p.role === 'gk' ? hard.gkTrack : hard.aiSpeed)));

  const tiers = ['easy', 'normal', 'hard'].map(t => { CONFIG.difficulty = t; return CONFIG.difficulties[t]; });
  ok('the dial only ever goes one way',
     tiers[0].aiSpeed < tiers[1].aiSpeed && tiers[1].aiSpeed < tiers[2].aiSpeed &&
     tiers[0].gkTrack < tiers[1].gkTrack && tiers[1].gkTrack < tiers[2].gkTrack &&
     tiers[0].shootNoise > tiers[1].shootNoise && tiers[1].shootNoise > tiers[2].shootNoise);
  CONFIG.difficulty = 'normal';
}

console.log('\n-- determinism --');
{
  const a = simulate(400, 'grass', 12345), b = simulate(400, 'grass', 12345);
  ok('the same seed replays the same match',
     JSON.stringify(a.match.score) === JSON.stringify(b.match.score) && a.steps === b.steps,
     a.match.score + ' / ' + b.match.score);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
