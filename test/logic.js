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

/* Run the whole AI-vs-AI match and collect everything that happened. */
function simulate(maxSeconds) {
  AI.seed(12345);
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

console.log('\n-- determinism --');
{
  const a = simulate(400), b = simulate(400);
  ok('the same seed replays the same match',
     JSON.stringify(a.match.score) === JSON.stringify(b.match.score) && a.steps === b.steps,
     a.match.score + ' / ' + b.match.score);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
