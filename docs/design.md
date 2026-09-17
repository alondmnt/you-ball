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

## the wind-up

a power kick is one accumulator with two ways to start it: the shoot key down on a keyboard, a finger held still on a screen. "still" means inside `dragDeadZonePx`, so a finger that steered away and came back counts - you never have to lift and press again. it also means you are not steering while you wind up, and that is the whole cost of the gesture.

`windUpMs` is what keeps a wind-up and a tap apart. under it a finger is still just a tap, so tap-to-pass survives a child who is slow letting go. it **belongs to the finger alone and is no part of the ramp**. a dedicated shoot key has nothing to disambiguate, so its meter moves from the first frame you press. a finger's meter stays dark until the gesture commits, because until then the reading would be power the player is about to not get - and then it appears at whatever it has already accumulated (0.37 at 240ms of a 650ms hold) rather than starting over.

it was in the ramp to begin with, which meant the first 240ms of every hold - over a third of it, once `holdMaxMs` came down - drew nothing at all on either hand, and that is exactly the part a child needs to see to learn that holding does anything.

`holdMaxMs` is time-to-full measured from first contact, whichever hand you are playing with, so one number tunes both and the same hold buys the same shot either way.

a wind-up that finds no ball to kick falls back to being a tap, and taps switch players. without that, holding still a beat too long would leave you stuck on the wrong player with nothing to show for it.

**the charge only runs while you have the ball.** without that gate the whole thing is defeated by holding the key down: you walk onto the ball already at full power and the meter never means anything. measured, leaning on the shoot key for seventy seconds: twelve fireballs before the gate, one after. `Input.setCharging(i, on, now)` is how game.js says so, and it restarts the clock, so gaining the ball mid-hold starts you at zero. input still knows nothing about teams or possession - only that this seat may charge now, which is the same shape as `setEnabled`.

### picking holdMaxMs

the charge clock and the steal immunity both start when you gain the ball, so they run together, and the share of carries that fill the meter is not a slope but three plateaus. measured over 30 matches a field:

| holdMaxMs | 450 | 500 | 550 | 600 | 650 | 700 | 750 | 800 | 850 | 900 | 1000 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| grass | 91% | 83% | 36% | 35% | 34% | 33% | 33% | 32% | 24% | 23% | 21% |
| moon | 87% | 79% | 27% | 25% | 23% | 22% | 22% | 21% | 15% | 14% | 13% |
| pool | 91% | 86% | 48% | 48% | 47% | 47% | 46% | 46% | 41% | 41% | 40% |
| ballpit | 95% | 87% | 33% | 31% | 30% | 29% | 28% | 27% | 23% | 22% | 21% |

at or under `stealImmunityMs` (500) a wind-up is **free**: nobody can touch you while it runs, so there is no mechanic. 500 to 550 is a 47 point cliff - that is the immunity wall. 550 to 800 is dead flat, one point per 50ms, so the constant moves freely inside it. 850 and up is a second plateau ten points lower.

so the choice is which plateau, not which number. 650 sits in the middle of the flat band: 150ms of being tackleable, which is what the wind-up costs, and clear of both cliff edges rather than perched on one. it was 900, which was on the low plateau for no benefit.

a live sweep of the constant could not separate 500 from 900 over seventy-second runs (3 to 8 fireballs at the same setting), so none of this comes from that.

the fields are not equal - a fireball is three times as likely in the pool as on the moon - and `holdMaxMs` is deliberately **not** a scene value. the difficulty of charging already tracks what a charge is worth: the pool has the ball dying on its way (`ballFriction` 0.968) and `shootRange` 560, so power is the scarce thing there, while the moon has `shootRange` 1100 and a ball that slides forever, so you can score without ever winding up. flattening it would cost four numbers to keep in sync and remove a difference the scenes exist to create.

### the meter

the ball is the meter. a ring round it fills as the wind-up goes, and at the top the ball catches fire and stays alight for `ballFireMs` after the kick. one mechanism says both how much you have and that you have all of it, which is the only way a child who cannot read a number knows the kick is ready, and it sits where their eyes already are.

`Render.setCharge` is the only writer of the charge and `Render.ballFire` the only way to light it after the kick. while nothing is winding up the whole thing costs one comparison a frame. the fill is a custom property, which repaints, so it is only written when it has moved 2% - at 6x CPU throttle the ramp costs 0.8ms a frame for as long as it lasts, and the flame, being a transform animation, costs nothing measurable at all.

the charge (0..1) rides on the shoot intent and out again on the kick event. physics has no use for it and never reads it. it is carried because it is the only thing that separates a wound-up kick from an AI clearance, and **the two arrive at exactly the same power**: the AI shoots at 0.99 of the range as a matter of course, measured over 40 matches, so anything keyed on shot speed would fire on every clearance in the game.

## playing in goal

`inGoal` is one entry a seat, and pins that seat to its team's keeper. `_autoSwitch` leaves a pinned seat alone and a tap will not switch off it, which is the whole point: you chose the position.

it is per seat rather than one flag because the two humans in two-player are on opposite sides, so each picks their own place - and all four combinations are real, including both in goal, which is two children keeping while four AI play in front of them. only as many entries as there are live seats are ever read, so a choice left behind by a second player who is no longer playing cannot pin a keeper or widen the camera. an older save holds a single boolean, and `loadProgress` converts it: read as an array it would be silently false for everybody.

there is one screen, so the camera goes wide if **either** seat keeps. an out-field player sharing with a keeper loses their close-up, and there is no way round that short of splitting the screen.

the obvious design - hand the child the keeper the moment a shot comes in - was measured and dropped. over 40 matches a shot takes **457ms** from the foot to the goal line, and the keeper, having tracked the ball all along, still has a **157 unit** median gap to close in a 320 wide mouth. at tracking pace only 44% of those are reachable at all, with a median of **53ms too late**. the AI only copes because it dives at 720 units/s off its own prediction. a child's reaction time alone eats that window, so the switch would take control away at the worst moment and then let them concede. widening the trigger to "an opponent is in your third" buys 383ms more, no use either, because `shootRange` (700) is nearly as wide as a third (800) - they are in range almost as they arrive.

the fear that standing in goal would be boring is the other way round: a shot arrives at your goal every 12 seconds and an opponent enters your third every 7.

### the camera

a camera that chases the ball is right for an outfield player, who is always near it, and useless for a keeper, who is not. measured over 70s of playing in goal, the player the child was driving was on screen **0% of the time** - it sat at about screen x -500 the whole match, because `cameraViewW` is 1500 of a 2400 pitch and the camera only reaches the goal line when the ball is in the defensive third.

so `Pitch.setWideView` pulls the view out to `keeperViewW` (2610: the whole pitch and both nets) while you are in goal. that is the only way to hold a fixed point and the ball at once - clamping the camera to keep the keeper would have lost the ball instead. it costs zoom, 0.39 against 0.68, and buys **99%** on screen.

### the dive

the dive is the whole reason choosing the position works. it was AI-only: `ai.js` wrote `p.diveUntil` and `p.diveDir` straight onto the player, which is the one place the seam leaked - physics is supposed to be unable to tell an AI from a child. now both ask for it the same way, with `intent.dive`, and physics owns when a keeper is airborne.

it fires on the **press**, never the release: a shot is on the line in 457ms, and waiting for a key to come back up would spend most of that. on a screen a flick dives the way you flicked and a tap dives at the ball, which is as much control as one finger needs.

a dive with nothing held carries the direction it launched in, so a tap is enough on a screen where there is no stick left to hold. hold a direction and you steer it as usual - **taking that away cost 12% more goals conceded**, measured, because the keeper could no longer correct a prediction that had moved while the ball was in the air.

`gkRecoverMs` is the cost. without it the dive is a free speed button and the answer is always to hold it down: a child is then simply a fast keeper, flopping about for half the match. 400ms at `gkRecoverMult` of keeper pace afterwards makes when to dive a decision, and it costs the AI keeper nothing (2.4 goals a minute conceded before and after).

the keeper's line is a **wall from the inside, not a leash**. it lets go entirely while the keeper is carrying, so a child who collects the ball can charge upfield and leave the goal empty, and it only bites on a player who was on the right side of it a moment ago, so coming home from midfield is a run rather than a teleport. the AI keeper never leaves its area, so none of this changes how it plays.

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

**The long notes are long enough to reach the next one**, including across a
barline. A held note is a rest in a melody; silence is a break. The version
after that one left two full beats of nothing between statements, which turned
one arc into a row of fragments - the notes were right and the line was not
there. The only gap left in the whole part is an eighth note before the
statement returns, which is a breath and is meant to be heard as one.

A note may run past its own bar. Nothing downstream cares, because by the time
it reaches the voice a length is just seconds, but the next bar must not start
before it ends or the lead plays two notes at once. The validator checks that,
and checks the largest silence in the line, because "is this one line or four
fragments" is exactly the kind of thing that is obvious by ear and invisible in
a table of notes.

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

**Both keys carry a melody**, and that was a correction. The first version gave
the tune to home only - your team has a song, theirs has a riff and a drone -
which reads well as a design sentence and fails in play. Possession turns over
every few seconds in this game; a melody that belongs to one team is a melody
you hear for a fifth of a match. Measured: 15% of playing time, against a
ceiling of 61%, arriving in scattered fragments. Nothing is memorable on those
terms.

So a tackle now changes the tune instead of removing it, and the change is the
drama. Away's line uses the same figure, so it is recognisably the same song,
but where home's figure climbs a major third away's stays put, and it leans on
the F natural that home never touches. Putting that flat second in the melody
says the away idea far louder than the chords underneath ever did.

Measured out of the synth rather than read off the tables: home's figure climbs
4.2 semitones and away's moves -0.3; away's line sits 2.6 semitones lower on
average and 15% of its notes are the F, against none of home's. The overall
proportion of rising intervals is the same in both (37% and 36%), so "away
falls where home climbs" was an overstatement of mine - it does not fall, it
refuses to climb.

One rule while writing it, and the validator enforces it: no B over an F chord.
B against F is a tritone, which is a different kind of nasty from the one that
theme wants.

The verse keeps the tune too. Stripping the band back is the point of a verse;
stripping the voice out as well was a misreading of the loud-quiet-loud this is
modelled on, where the quiet part is a vocal over a bass riff.

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

difficulty is three multipliers and nothing else: AI run speed, keeper tracking speed, shot aim noise. **they apply to every AI on the pitch**, and only the player a human is driving is exempt, so the two teams are always built to the same spec.

it briefly described the opposition alone, exempting your whole side, and the gap that opened was not subtle. over 30 matches a row, playing in goal:

| | your side | opposition | your possession |
|---|---|---|---|
| exempting your side, easy | 0.73 | **0.00** | 38% |
| exempting your side, normal | 4.57 | **0.07** | 45% |
| exempting your side, hard | 2.67 | 2.27 | 51% |
| levelled, easy | 1.60 | 1.57 | 50% |
| levelled, normal | 2.77 | 2.43 | 50% |
| levelled, hard | 2.53 | 2.53 | 51% |

two things in that table beyond the obvious. at hard the old rule was already nearly level, because `aiSpeed` is 1.00 there and `shootNoise` 0.8 actually made the opposition aim *better* than your side - so anything that still felt lopsided on hard was never this. and on easy your side had **less** of the ball than the opposition did, because opponents too slow to hold their formation end up bunched in their own box, where they block shots without ever threatening: the weakest setting produced the lowest conversion, 7% against 42% on normal.

the rule was changed away from levelling once before, on the grounds that a levelled easy put your own keeper at 60% tracking and conceded more than the slower opponents saved. that does not reproduce: at easy the opposition scores 0.00 a match under either rule, because opponents that slow cannot shoot straight either, so nothing punishes a weak keeper. if it ever comes back, `gkTrack` is the dial, not this rule.

a caveat on how any of this is measured: a simulated human is an AI player left at full, which models a keeper reasonably (a keeper's edge is tracking speed) and a striker badly (the exemption hands them clean aim while every AI on the pitch carries 1.5x error). the out-field rows of any such table are not worth reading.

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
| `input.js` | CONFIG, Pitch | players, teams, possession, whether a charge has a ball to kick |
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
