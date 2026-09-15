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
| `render.js` | everything above | input, the loop |
| `editor.js` | Assets, Storage, Character | the match |
| `game.js` | everything | - |

`game.js` is the only module that knows a human exists. input produces intents, AI produces the same intents, and physics cannot tell them apart - which is why local two-player cost one extra key map and nothing else.

## departures from plan.md, collected

| what | why |
|---|---|
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

## not built

stage 5 is untouched and deliberately open: new scenes and weather, power shots and items, export/import a character or team as a file. `CONFIG.scene` sets one CSS class on the pitch container, so a new scene is a CSS block and a config value.

also outstanding from the plan's own risk list: the drag-and-flick controls are still a proposal that has not met the child's hands. dead zones (`dragDeadZonePx`), flick thresholds (`flickMaxMs`, `flickMinPx`) and the joystick radius are the dials. the fallback, if it does not survive contact, is an on-screen joystick and one big shoot button.
