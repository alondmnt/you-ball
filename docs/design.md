# you-ball - system design

how the thing is actually built. [plan.md](plan.md) is the design as agreed; this is the design as it stands after stages 0-4, including the places the build departed from the plan and why.

## the one invariant

`physics.js`, `ai.js` and `match.js` contain no DOM access, no `Date.now()`, and no `Math.random()`. everything they need comes in as arguments; everything they produce goes out as return values and events.

that seam buys three things: the renderer can be replaced (a real 3D camera later would touch `render.js` and `pitch.js` only), the logic is testable without a browser (`node test/logic.js`), and a match replays identically from the same AI seed. it is checked mechanically:

```
grep -nE '\b(document|window|indexedDB|requestAnimationFrame)\b' js/physics.js js/ai.js js/match.js
```

that should stay empty.

## coordinates

```
x  0 ──────────────── goal to goal ──────────────── 2400
y  0  near touchline (bottom of screen, full size, in front)
   900 far touchline (top of screen, 15% smaller, behind)
```

projection, in `pitch.js`:

```js
sx    = x * zoom
sy    = pitchTop + (pitchH - y) * depthStep
scale = 1 - (y / pitchH) * depthShrink
z     = round(pitchH - y)
```

**this differs from plan.md.** the plan wrote `sy = pitchTop + y * depthStep` and `z-index = round(y)`, which contradicts its own two other statements: that `scale = 1 - (y/pitchH)*depthShrink` (so y=0 is the *largest*, i.e. nearest) and that the near touchline is at the bottom of the layout diagram. y = 0 is the near touchline, so it has to render at the bottom and in front. the y term is inverted in both `sy` and `z`.

the camera is not subtracted per entity. `#world`, `#pitch-markings` and `#fx` are each translated by `-camX * zoom`, and `#crowd` by a third of that, which is where the parallax comes from. one transform per layer per frame instead of one subtraction per entity, and identical arithmetic.

the camera clamp overscans by `goalDepth * 1.5` at each end. clamped exactly to the pitch, the nets - which sit behind the goal line - were never visible.

## the loop

`game.js` runs a fixed 60Hz logic step inside `requestAnimationFrame` with an accumulator, capped at 5 steps per frame. a tab that was hidden for a minute drops its backlog rather than trying to simulate a minute of soccer in one frame. the game also pauses on `visibilitychange`.

each step:

```
Match.timeScale()  ->  0 frozen | 0.25 slow-motion | 1 play
  if > 0:  auto-switch -> build intents (AI, then humans on top) -> Physics.step
  always:  Match.update  ->  react to events (audio, effects)
```

render happens once per frame, not once per step, and reads whatever the world currently says.

## state

```js
world = {
  t,                                    // accumulated seconds of play
  players: [ { id, team, index, role, x, y, vx, vy, facing,
               kickAt, stunUntil, diveUntil, diveDir,
               human, speedMult, ai } ],
  ball:    { x, y, vx, vy, carrier, stealLockUntil, pickupLockUntil, lastTouch, scored },
}

match = { phase, phaseLeft, score, clock, scorer, winner, restartTeam }
```

player ids are array indices, assigned in `Physics.createWorld`.

the pure modules mutate `world` in place and return an events array rather than returning a new world. reallocating eight players sixty times a second buys nothing, and the property the seam needs - no rendering in there - is unaffected. plan.md says "take state, return state"; this is the same seam with less garbage.

every timestamp is `world.t`, never wall-clock. steal immunity, the loose-ball window and the kick pose are all "is `world.t` past this number", which is what makes a step deterministic.

## animation

each character is six `<img>` slots on pivots, plus two extra head images so all three faces sit in the DOM at once. state is a single CSS class on the root; keyframes are transforms only, so it all stays on the compositor. the only per-frame JS write to a character is the root's transform.

**this differs from plan.md.** the plan says the face swap is `src` on the head image. it is instead three stacked images with CSS picking one, because swapping `src` at the exact moment of a goal can land on an undecoded image - a blank head on the one frame that matters most.

animation state is derived from the world every frame, not remembered. a player is kicking because their `kickAt` is recent. `Character.setAnim` is idempotent so the renderer can call it every frame, and it runs no timers.

## possession

touching the ball takes it, and it sticks to the carrier's foot. an opponent within `stealDist` takes it, unless the carrier's immunity window is still open.

a tackle **knocks the dispossessed player clear and stuns them** for `tackleStunMs`.

**this is not in plan.md, and the game does not work without it.** with plain contact-steals, two equal-speed players standing on each other trade the ball every 500ms forever. an AI-vs-AI match produced 169 steals, 0 kicks and 0 goals in ninety seconds: the ball never left midfield. the knockback is what lets the new carrier get away, and it also gives a tackle some weight.

`carrierSpeedMult` (0.93) keeps a chase from being hopeless. the separation radius has to stay under `stealDist`, or contact could never happen at all.

## music

A rock song, synthesised note by note. Nothing is sampled, so it costs no
download and no decode.

**Length.** A part is sixteen bars - four four-bar phrases with an arc through
them - and two parts alternate, so an exact repeat is 58 seconds apart. At 132
BPM a four-bar loop would come round twelve times in a 90 second match, which is
wallpaper; this comes round once. The part is the one thing that may only change
on a phrase line, because it is song structure rather than a reaction to the
game. Eight-bar parts in an AABA form give the same 32 bars before a repeat, so
the choice between them is about the length of the musical sentence, not about
repetition.

**The riff.** The first version had the bass playing straight eighths, every
eighth, for the whole part, with the same figure in all sixteen bars. The chords
moved but the rhythm and contour never did, so the ear heard one bar repeating
under a changing progression rather than a sixteen-bar sentence.

Each part carries a `cell`: which sixteenths of the bar the riff lands on. Bass
and guitar both play it, which is what a band locking onto a figure sounds like,
while the drums hold a straight pulse underneath.

```
home   x.x.x.x.x.x.x.x.   driving eighths, accented on one and three
kick   x.....x.x.....x.

away   x...x.x.x...x.x.   one, two-and, three, four-and: heavier, and it
kick   x.........x.....   breathes where home does not
```

An intermediate version put hits on the "a" of one and three. That read as
unpredictable rather than syncopated - it fixed the no-rests problem and
overshot. Both cells are now square on the beat and symmetrical across the half
bar, which is what lets a melody sit on top: the riff's job is to be the floor.

The home/away contrast is still rhythmic as well as modal, which is a stronger
cue than mode alone. `turn` swaps the cell on the last bar of each four-bar
phrase and a snare fill goes with it, so the seams are audible.

**The melody.** The reference song has no tune in it - it is riff and shout -
which works over three minutes and is thin under a whole match. So this departs
from it deliberately.

The melody does not run the whole way, and where it stops is the point. Part A's
first sentence is riff and hook only; the melody enters at bar nine and then owns
all of part B. That gives it somewhere to arrive, and it means the hook and the
melody never compete for the top - the hook answers the riff on bars 3 and 7,
then hands over.

The tune is one figure stated four times - two short notes into a long one,
answered each time by a fall back down - with bars 10 and 11 repeating the
figure a third higher. Saying a thing and then saying it again from somewhere
else is the oldest way there is of making a line stick. The first version moved
by step through the pentatonic with the same rhythm in every bar: singable, and
nothing. No leap, no repeat, no high point.

It plays on a **lead voice**: a detuned sawtooth pair driven into its own
overdrive, rolled off like a speaker cabinet, with vibrato that fades in on any
note held long enough to want it. That started as a pair of clean triangles,
which was too polite to be remembered - it sat inside the band instead of on
top of it. Drive, sustain and pitch that is never completely still are what
separate a lead line from a beep.

The lead has its own waveshaper rather than sharing the rhythm guitar's. One
amp for both is what a band actually does, but a shaper distorts the sum of
whatever reaches it, so the melody's level would bend the rhythm guitar's tone
every time the tune moved.

Away has no melody, the same way it has no hook: your team gets a tune, theirs
gets a riff and a drone. The melody keys off the *key* and not only the texture,
so no line ever plays over chords it was not written for.

The guitar plays root and fifth with no third in it, so the chord roots are
modeless. The mode comes from the bass line and from the notes the hook picks
out, which is why home and away can share roots and still sound nothing alike.
It also halves the data: a bar is one root plus one pitch per cell hit.

**Two axes, two speeds.** A *progression* (home: Em Em C D up to the four,
away: Em Em F F then Am G F Em down onto it) and a *texture* (the layer set: which drum pattern, whether the hook and the chant
and the drone play, whether the guitar stabs or chugs or holds). They are
separate because they need different reaction times:

| | follows | why |
|---|---|---|
| texture | the ball, within about half a second | it is what you actually hear change, and rock arrangements drop and add layers anywhere |
| progression | possession that has lasted a couple of seconds | a chord change every 1.2s establishes nothing |

Both progressions share one key centre, one tempo and one grid, and every part
is the same length, so any join works and a key change keeps its place in the
bar. Nothing has to wait for a phrase boundary except the part itself.

**The reaction time is measured, not guessed.** Over eight AI-vs-AI matches a
possession spell has a median length of ~500ms. That kills the obvious rule:
"the same team has held it for N" either never fires (N > 700ms: the away
theme appeared once a minute) or fires constantly (N < 600ms: 35 times a
minute). Two attempts went in before the measurement - a plain hold timer, then
a momentum bias that charged while a team kept the ball - and both were late
for exactly this reason.

What works is a floor on the *rate* of change rather than on how long
possession has to be held. Taking the ball registers at once; a second change
has to wait out `layerDwellBeats`. Losing the ball to nobody is the asymmetric
case and waits `looseMs`, because the ball is loose during every pass.

Measured, at 2 beats of dwell: the music answers a turnover in a median of
604ms, with the texture changing about 40 times a minute. The trade-off is one
config value, and it is close to linear:

| texture dwell | heard latency (median) | texture changes / min |
|---|---|---|
| 1 beat | 327ms | 53 |
| 2 beats | 604ms | 41 |
| 3 beats | 975ms | 33 |
| 4 beats | 1327ms | 28 |

**The scheduler** is the standard Web Audio lookahead: a 50ms `setTimeout`
queues the next 200ms of notes at sample-accurate times. boo-boss schedules its
whole 64-beat loop in one go, which is less code but would leave a possession
change inaudible for twenty seconds - the exact thing this feature exists to
do. The timer reschedules even while the context is suspended, so it recovers
by itself when a tablet wakes, and it restarts on a phrase line rather than
replaying the minute it missed.

Every voice of one step shares a single reading of `ctx.currentTime`. Letting
each voice read the clock itself measured 10.8ms of spread within a beat, which
smears the attack; sharing one reading leaves exactly the 5.5ms of deliberate
swing and nothing else.

**Cost**: 2.15ms of script per second at 6x CPU throttle, measured on an idle
splash screen so nothing else is in the sample. Against the renderer's load it
is below the noise floor. The music has its own gain bus with a limiter on it,
because eight layers landing on one downbeat sum past full scale; the effects
stay off that bus so they always cut through.

**The goal motifs** are quoted out of the music rather than written beside it.
The original was a C major arpeggio, which shared nothing with an E minor
anthem but the tuning. A goal for home carries the hook's B-D-E on up to G4,
B4 and the octave, with the crowd behind it; a goal for away walks the Phrygian
line the away theme is built on, Am G F Em, and settles on F against E. Same
music either way, one going up and one coming down. They play into the master
bus and not the music bus, because the music is ducked for exactly that moment.

This also fixed a plain bug: a sad slide used to play 800ms after *every* goal,
including the ones you scored.

**The arrangement rule is pure.** `Audio.arrange(prev, input, dt)` takes
possession, match phase and the score, and returns the texture, the key and
whether to duck. No context, no clock, no randomness - the same seam as
physics/ai/match, which is why the hysteresis, the goal duck and the scoreline
layers are all tested in `test/logic.js` rather than judged by ear.

## AI

four behaviours, picked per player per step: keeper, carrier, chaser (one field player per team, the nearest to the ball), and everyone else holding a formation slot that slides with the ball.

the carrier order is **settle, then shoot, then pass**, and a pass must gain `aiMinPassGain` up the pitch. checking pressure first - which is how plan.md words it - means passing on every touch, because a chaser is always inside `pressureDist`. the ball went round in a circle and no one ever reached shooting range.

difficulty is three multipliers and nothing else: AI run speed, keeper tracking speed, shot aim noise.

## storage

- **localStorage** `youBall_progress` - roster, teams, colours, settings. corrupt data starts fresh; missing keys fill from defaults so an older save still loads.
- **IndexedDB** `youBall_assets` / `parts`, keyed `${characterId}:${slot}` - the imported images. localStorage would not do: it is 5-10MB and base64 inflates a blob by a third.

IndexedDB is unavailable on a `file://` origin in chrome. every read resolves to null instead of throwing, the game falls back to the built-in parts, and the editor says so. the README tells you to serve over http.

blobs become object URLs at match start and are revoked on teardown, so a character that has been on the pitch does not keep a decoded image alive forever.

`Assets.SLOTS` is the single table both the editor and the rig read, so an imported image cannot be a different aspect from the frame it lands in. the fallback chain (`head_goal` → `head_idle`, `arm_l` → `arm`) means one upload can furnish several slots.

## the editor

three areas, and they do different jobs. the top strip is the **roster**, a pool of characters that exist independently of any team. the middle is the character you are editing, with its slots and a live preview. the bottom two rows are the **teams**, four places each.

tapping a team place opens a picker of roster faces, drawn in that team's kit. that replaced an earlier model where a place silently took whichever roster card was selected, which is a mode with nothing on screen to announce it. the picker also offers **nobody** (the place falls back to a built-in player) and **new** (make a character and assign them in one go).

exactly one assignment happens automatically: a brand new save gets one character in the home team's first field place, which is the player the human drives at kickoff, so making a face and pressing play shows it. the earlier version dropped every new character into a free place in *both* teams, which made the two rows mirror each other and the editor read as though it edited both sides at once.

nothing needs assigning for a match to run. `_buildTeams` in `game.js` fills any empty place with a generated built-in character.

## scenes

a scene is a CSS class on `#pitch` plus a set of value overrides in `CONFIG.scenes`. `CONFIG.applyScene` restores the baseline and lays the chosen set on top; `game.js` calls it alongside `Pitch.setScene` at match start. no module branches on which scene is playing.

the overrides are not cosmetic. a kid asks to play on the moon because of what the moon does, so each scene moves the values that carry the feeling: ball friction, wall bounce, player acceleration. moon and pool are deliberate opposites, so playing one after the other teaches that the choice matters.

the AI values move with them, and that is the part that breaks quietly. its shooting range assumes a ball that travels a certain distance, so a scene that changes the ball's roll has to change the range too, or nobody ever shoots. `test/logic.js` runs six AI-vs-AI matches per scene and fails if a scene stops producing goals.

### effects

each scene names the effects it wants in `CONFIG.fx`; the vocabulary (`dust`, `ripple`, `splash`, plus `ballBob`) lives in `render.js`. a scene chooses, it does not describe. so adding a scene still costs no code, and only a genuinely new kind of effect does.

three things keep the particle count sane. running effects are throttled per player and capped per frame, because eight players kicking up dust continuously is noise rather than atmosphere. bursts scale quadratically with what caused them, so a footstep is a wisp and a full-power kick is a cloud, through the same emitter. and anyone who asked for reduced motion gets none of it.

the first version left 74 dust puffs alive at once; it now peaks at 25, and frame time sits at 16.7ms median in every scene. that measurement is a desktop upper bound, not a promise about the tablet.

a tackle is the one moment that fires everywhere: a soft ring and a few sparkles at the point the ball changes hands, plus whatever that scene throws up. the tackler reaches a hand down for the ball and the player who was robbed pirouettes on the spot for exactly as long as the stun keeps them from steering, so the pose and the rule agree. both are derived from timestamps on the player, the same way a kick is, so nothing runs a timer.

it was built harsher first: a shoulder charge, a backwards tumble, impact shards, screen shake, and the sad face. that reads as violence, which lands differently in a game where the players wear real family faces. the face was the worst of it - at sixty-odd steals a match it was appearing about once a second. **the sad face now belongs only to conceding a goal.** the rest was softened the same way: reach not charge, spin not fall, no shake, a swish rather than a thud.

none of the physics changed. the knockback and the stun are load-bearing and measured; only how they read did.

the ball pool's loose balls are the one effect with state. a hundred and thirty of them lie on the pitch, get shoved aside by anyone who runs through, and drift back on a spring. they live in `render.js` and never touch `physics.js`: they do not affect possession, the match ball or how a player moves, so the whole feature cannot change a result. the wading is already in that scene's tuned speed and friction.

a moving ball also nudges the ones around it, so a disturbance spreads instead of stopping at whoever caused it. two things had to be got right there. propagating at contact distance did nothing, because at this density the balls sit about 110 units apart and never touch, so the nudge carries over a sloshing radius rather than a collision one. and only a ball actually travelling passes it on: without that threshold the chain never dies, a ball drifting home nudges its neighbours, they nudge back, and the whole pit shimmers forever. measured at every one of 190 balls moving permanently before the threshold went in, and about 53 after.

what makes them affordable is that a ball at rest is skipped entirely, no maths and no DOM write, and only moving balls are propagation sources.

### never animate a size

depth is a `scale()` in the transform, never a width and a height. writing width/height per frame forces a layout per frame, and the first version of the loose balls did exactly that - along with the match ball and its shadow, which had done it in every scene since they were written. measured with chrome's cpu throttling at 6x, which is the closest stand-in available for an old tablet:

| | before | after |
|---|---|---|
| grass | 1.40ms | 0.80ms |
| ball pool | 3.00ms | 1.40ms |

every element is now built at a base size once and only transformed after, and z-index is written only when it changes.

there is also a one-shot step-down: if the median frame during play is slower than about 45fps, the pit is halved, once. it can only remove balls, so a fast device is never touched.

**a caveat worth keeping.** the report that prompted this was an ipad mini 4 feeling the weight, and that symptom could not be reproduced here - even at 20x cpu throttling the loop holds 60fps, because the javascript is genuinely small. so what an old tablet feels is more likely compositing and painting 190 elements in safari than script time, which cpu throttling does not simulate. the layout fix is measured and real; the step-down is a safety net aimed at a symptom we cannot see. `CONFIG.scenes.ballpit.fx.loose` is the knob if it needs turning down. the painted floor underneath was muted once they existed, because a floor at full strength competes with real balls and the match ball gets lost.

the pool's waterline is worth singling out: a band of pool colour across each character's lower legs did more to say "in the water" than the caustics, the ripples and the surface pattern combined. it is eight lines of CSS.

### what the measurements taught us

the first pool scene slowed players and blunted their acceleration, on the theory that water is heavy. every one of twelve matches finished nil-nil: the pitch stays the same size while everything on it gets slower, so the AI could never work the ball into shooting range before losing it. a one-value-at-a-time sweep showed no single override was fatal; low acceleration and a short steal immunity compounded into permanent churn.

the fix was to put the weight in the **ball** and leave the players close to normal. water reads through the ball dying and the walls going soggy, which is also more fun to play than being slowed down.

two AI changes attempted along the way were reverted, because measurement said they made things worse:

- picking the pass target by furthest forward gain rather than nearest. inert, because of the next point.
- pushing the most advanced player ahead of the ball so there was someone to pass to. this collapsed grass from 4.2 goals a match to 0.3, as the AI leapfrogged the ball between two players and never shot.

a standing consequence: **every formation slot sits in its own defensive half**, so nobody is ever ahead of the carrier and the AI essentially never passes. it dribbles. that is fine at this level and the scene values are tuned around it, but it is the thing to fix first if the AI ever needs to look like a team.

`bounceScatter` was nearly cut. across twelve AI matches it fired twice, because the AI aims and keepers save. simulating a human who shoots without aiming raised it to eight to ten wall hits a match, which is the case it exists for.

## the seams, by file

| file | knows about | does not know about |
|---|---|---|
| `config.js` | nothing | everything |
| `storage.js` | CONFIG | game state |
| `assets.js` | CONFIG, canvas | characters, teams |
| `character.js` | Assets, Storage | the pitch, the match |
| `pitch.js` | CONFIG | players, the ball, the score |
| `physics.js` | CONFIG | the DOM, the match phase |
| `ai.js` | CONFIG, Physics | the DOM, who is human |
| `input.js` | CONFIG, Pitch | players, teams, possession |
| `match.js` | CONFIG, Physics | the DOM |
| `audio.js` | CONFIG | the world, the score bar, who is human |
| `render.js` | everything above | input, the loop |
| `editor.js` | Assets, Storage, Character | the match |
| `game.js` | everything | - |

`game.js` is the only module that knows a human exists. input produces intents, AI produces the same intents, and physics cannot tell them apart - which is why local two-player cost one extra key map and nothing else.

## departures from plan.md, collected

| what | why |
|---|---|
| scenes override physics, not just CSS | a moon that only looks different is a let-down; the plan left scenes as cosmetic |
| scenes emit named effects | dust and ripples need code that knows when to fire, so the promise "a scene is CSS plus a config value" widened deliberately rather than by accident |
| `sy` and `z` invert y | the plan's formula contradicts its own scale formula and layout diagram |
| three face images, CSS picks one | a `src` swap can show a blank head on the goal frame |
| camera moved from per-entity to per-layer | same arithmetic, fewer operations, free crowd parallax |
| camera overscans past each goal line | otherwise the nets are never on screen |
| pure modules mutate in place | no garbage per frame; the DOM-free property is untouched |
| `Match` calls `Physics.kickoff` | match owns the restart rules, and both are DOM-free |
| tackle knockback and stun | without it possession never leaves midfield (measured: 0 goals in 90s) |
| AI settles before passing, passes forward only | without it the AI passes on every touch and never shoots |
| a marker over the controlled player | auto-switch moves control constantly; the kid needs to see who they are |
| `test/logic.js` | cashes the plan's claim that the logic is testable in a plain script |
| music the plan never asked for | the plan listed effects only; both sibling games have a loop and this felt bare without one |
| the music reacts to possession | asked for during the build: the arrangement is the feature, not the loop |

## not built

stage 5 is partly done: the scenes above exist and the music does, weather does not. still open: weather, power shots and items, export/import a character or team as a file. an ocean scene is the natural home for weather, because a current that pushes the ball only makes sense somewhere without edges.

also outstanding from the plan's own risk list: the drag-and-flick controls are still a proposal that has not met the child's hands. dead zones (`dragDeadZonePx`), flick thresholds (`flickMaxMs`, `flickMinPx`) and the joystick radius are the dials. the fallback, if it does not survive contact, is an on-screen joystick and one big shoot button.
