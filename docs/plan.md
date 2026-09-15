# you-ball - build plan (v1)

## context

a father-and-child project. **you-ball**: a cute, simple soccer game for 5-10 year olds where the players are built from any images you like - a photo for the head, a drawing for the torso, whatever for the limbs. each character has three face images (idle / GOAL / sad) so the team reacts to the match.

same stack as car-doctor and boo-boss: vanilla JS, DOM + CSS animations, Web Audio synthesis, localStorage, IIFE modules loaded as plain `<script>` tags in a fixed order, no build step, no dependencies, GitHub Pages. two things are new for us:

1. **user-uploaded images** - stored on-device in IndexedDB as blobs (localStorage is ~5-10MB and base64-inflates images; a few photo-quality parts per character would blow through it)
2. **a real-time game loop** - a moving ball, 8 characters, collisions, AI. car-doctor was sequential, boo-boss was real-time but low-frequency. this one runs at 60Hz.

## decisions so far

- **platform**: browser, landscape only. tablet + desktop first, phone secondary (a pitch is wide; portrait doesn't work)
- **teams**: 1 goalkeeper + 3 field players per side. both GKs are always AI. the human controls one field player at a time
- **camera**: side-on elevated view (mario strikers-like). goals left and right, whole pitch depth visible, camera pans horizontally following the ball. mild depth scaling - players near the bottom touchline slightly larger. no true 3D, no camera orbit - flat images only look right face-on, so the view never rotates around them
- **character rig**: paper doll - head, torso, two arms, two legs, each a separate `<img>` on a pivot. the head slot has three variants: `idle`, `goal`, `sad`
- **customisation**: any slot can be overridden with an uploaded image; anything not overridden falls back to a built-in illustrated part (cute, simple, inline SVG), so an empty character is playable immediately
- **pitch rules**: walled pitch. ball bounces off all four sides. no out of bounds, no throw-ins, no corners, no offside, no fouls. contact steals the ball. (this is what strikers does and it removes most of soccer's rulebook in one decision)
- **rendering stays decoupled from game logic** - physics, ai and match state never touch the DOM. if we ever want a real 3D camera, the renderer is the only thing that changes

## visual layout

```
┌──────────────────────────────────────────────────────────────┐
│  [🙂 2]  [⏱ 0:48]  [3 😐]                     [🔊] [✏️] [↻]  │  top bar
├──────────────────────────────────────────────────────────────┤
│░░░░░░░░░░░░░░░░░░░░░░░░ crowd / stands ░░░░░░░░░░░░░░░░░░░░░░│  parallax strip
│ ┌────────────────────────────────────────────────────────┐   │
│ ║        🧍                         🧍                    ║   │  far touchline
│ ║  🥅         🧍        ⚽              🧍         🥅      ║   │  (players ~15%
│ ║                 🧍                       🧍             ║   │   smaller)
│ ║        🧍                            🧍                 ║   │  near touchline
│ └────────────────────────────────────────────────────────┘   │
│      ← camera pans left/right following the ball →           │
└──────────────────────────────────────────────────────────────┘
```

- **world coordinates**: `x` runs goal to goal (0..PITCH_W), `y` runs near touchline to far touchline (0..PITCH_H). the pitch is wider than the screen; the camera window slides along `x`
- **screen mapping**: `sx = (x - camX) * zoom`, `sy = pitchTop + y * depthStep`, `scale = 1 - (y / PITCH_H) * DEPTH_SHRINK` (default 0.15), `z-index = round(y)`. the trapezoid is subtle - it's for feel, not simulation
- **camera**: lerps toward ball `x`, clamped so the goal mouth stays on screen at each end. **zoom punch** (quick scale to ~1.3 and back) + brief slow-mo on goals. **screen shake** on hard wall hits
- **scene**: grass to start. the pitch background, wall style and crowd strip are one CSS class on the pitch container (`scene-grass`), so new scenes in stage 5 are a CSS block + a config value, not a code change
- **top bar**: score shown as each team's current face (the GOAL face after scoring, sad face after conceding, idle otherwise) - the kid reads the mood, not the number, though the number is there too. ✏️ opens the editor

## characters

### rig

```
        [head]          pivot: bottom-centre (neck)
     [arm_l][torso][arm_r]   arms pivot: top (shoulder)
        [leg_l][leg_r]       legs pivot: top (hip)
```

each part is an `<img>` absolutely positioned inside a character `<div>`, with `transform-origin` at its pivot. the root `<div>` gets `translate3d(sx, sy, 0) scale(s)` per frame and `scaleX(-1)` when facing left. animation is CSS classes on the root:

| class | what moves | face |
|---|---|---|
| `idle` | slow breath bob | idle |
| `run` | legs alternate ±35°, arms opposite, slight lean | idle |
| `kick` | one leg swings forward, arm counterbalance | idle |
| `celebrate` | dance - jump, both arms up, hip wiggle, spin | goal |
| `sad` | shoulders droop, head tilts, arms hang | sad |
| `sad-dance` | the `celebrate` dance at half energy, drooped head | sad |
| `dive` | GK only - full-body tilt toward ball side | idle |

the face swap is just `src` on the head `<img>`, driven by the same class. no per-frame JS animation of limbs - CSS keyframes only, transforms only, so it stays on the compositor.

### asset slots

| slot | fallback if empty |
|---|---|
| `head_idle` | built-in illustrated head - a small set of cute variants (round, freckles, big eyes, etc.), picked at random per default character |
| `head_goal` | `head_idle` |
| `head_sad` | `head_idle` |
| `torso` | built-in torso in team colour |
| `arm` | built-in arm (used for both sides, mirrored) |
| `leg` | built-in leg (both sides) |
| `arm_l` / `arm_r` / `leg_l` / `leg_r` | override `arm` / `leg` individually if you want asymmetric parts |

8 slots is a lot to fill × 8 characters on the pitch. the design assumes **most slots stay default** - a custom head on a default body is the 90% case. the `arm`/`leg` shortcuts exist so a full custom body is 4 uploads, not 6.

### roster and teams

- a **roster** of saved characters (name + slot overrides). build once, reuse anywhere
- a **team** is 4 roster picks (GK + 3) plus a colour. the same character can appear more than once - the team colour tints default parts via CSS variable, and a small colour badge/armband sits on the torso so custom torsos still read as a team
- **the ball is also an image slot.** default ball; any image works. (his face as the ball is almost certainly the first thing that happens)

## the editor

kid-first, no text:

1. tap a character silhouette → slots glow
2. tap a slot → native file picker (`<input type="file" accept="image/*">` - camera on tablet, files on desktop)
3. adjust: the image appears inside the slot frame; drag to position, pinch (or wheel) to scale; tap ✓
4. **✏️ paper mode** toggle: for drawings on paper - white-ish pixels become transparent via a threshold pass on canvas. cheap and effective for crayon on white paper. off by default for photos
5. preview: the character does its `run` cycle live in the editor as you edit

**import pipeline**: file → `Image` → canvas at slot aspect → crop to frame → downscale to max 256px on the long side → optional paper mode → `canvas.toBlob('image/png')` → IndexedDB. 256px is plenty at screen size and keeps 8 characters × 8 slots small and fast to render.

**storage**: IndexedDB database `youBall_assets`, object store `parts` keyed by `${characterId}:${slot}`. blobs are read once at match start and turned into object URLs; URLs are revoked when the match ends. roster metadata, teams and progress live in localStorage under `youBall_progress` like the other games.

**nothing leaves the device.** faces of real children are involved - no upload, no sharing feature that transmits images anywhere. export/import (a downloadable JSON with base64 parts) can come later so a character built on the tablet can move to the desktop, but it is a file the parent moves by hand, never a network call.

## game loop

fixed 60Hz logic step inside `requestAnimationFrame` with an accumulator; render reads world state and writes transforms + classes. logic modules (`physics`, `ai`, `match`) are pure - they take state, return state, no DOM.

### ball

position, velocity, friction (exponential decay), wall bounce with restitution, small shadow ellipse for depth. goal detection: ball `x` past the end wall AND `y` within the goal mouth → goal. otherwise the end wall is a wall.

### possession

strikers-style, not loose dribbling - much easier for small hands:

- **touching the ball takes it.** the ball snaps to the carrier's foot and moves with them
- **shoot** releases it with velocity in the aim direction. power scales with flick speed / hold duration
- **pass** releases it toward the nearest teammate in the facing half
- **steal**: an opponent touching the carrier takes the ball. the new carrier gets 0.5s immunity so it doesn't ping-pong. no fouls, no cards - contact is the whole tackle system
- GK catching a shot = possession → GK punts toward a teammate after a beat

### controls

- **touch (tablet)** - one finger:
  - touch and drag → relative joystick from the touch-down point. controlled player runs that way
  - flick (fast release) → shoot in the flick direction (power = flick speed)
  - tap (no drag) → pass, or if you don't have the ball, switch to the teammate nearest the ball
  - **auto-switch**: when the opposition has the ball, control jumps to your field player nearest the ball. the kid never has to think about who they are
- **keyboard (desktop)**: arrows or WASD move, space shoot (hold for power), shift pass. **second key set = local two-player** - one on arrows, one on WASD. this is the dad-vs-kid mode and it's cheap once input is intent-based
- input produces **intents** (`move: {dx, dy}`, `shoot: {dx, dy, power}`, `pass`, `switch`); the AI produces the same intents for the players it controls. physics doesn't know who's human

### AI

deliberately dumb and tunable:

- **carrier**: run toward the opponent goal; shoot when within `SHOOT_RANGE` and the lane is roughly clear; pass if an opponent is closer than `PRESSURE_DIST`
- **nearest teammate to ball** (when not in possession): chase it
- **other field players**: hold a formation slot offset toward the ball's `x`, jitter a bit so they don't look robotic
- **GK**: track ball `y` within the goal area; `dive` toward the ball when a shot is inbound and fast. GK saves are mostly about how fast it tracks - that's the difficulty dial
- difficulty = a handful of multipliers in config (AI run speed, GK tracking speed, shoot accuracy noise)

### match

`splash → editor | match` at top level; within a match: `kickoff → play → goal → kickoff … → fulltime`

- default: **first to 3 goals or 90 seconds**, whichever first. both in config
- on goal: slow-mo + zoom punch, **fireworks** over the pitch, **everyone dances** - the scoring team `celebrate` with GOAL faces, the conceding team also dances but with `sad` faces (his call: everyone dances). comic-bubble "GOAL!" burst, crowd cheer synth. ~3s, then kickoff
- fulltime: winning team lines up and celebrates, losing team sad, rematch / edit / home buttons
- pause when the tab loses focus

## juice (the strikers feel without 3D)

- zoom punch + 200ms slow-mo on goals
- screen shake on hard wall hits and steals
- ball trail (a few fading clones) on powerful shots
- fireworks on goals (CSS particle bursts, 3-4 colours), parallax crowd strip that bounces along
- synth: kick thump, wall bonk, whistle, crowd swell, sad trombone-ish on conceding. same Web Audio approach as boo-boss
- **face-driven feedback everywhere**: the score bar, the editor preview, the fulltime screen - the uploaded faces are the emotional channel, so lean on them

## module structure

```
index.html            — shell: splash, editor, match containers; loads scripts in order
css/style.css         — layout, top bar, editor, pitch
css/characters.css    — rig layout, pivots, all animation keyframes
js/config.js          — every tunable value
js/storage.js         — localStorage progress + IndexedDB parts (get/put/delete, object URL lifecycle)
js/assets.js          — slot definitions, built-in default parts, import pipeline (crop/downscale/paper mode)
js/character.js       — builds a rig <div> from a character record; sets animation class + face
js/editor.js          — customisation screen (roster, slots, adjust, preview)
js/pitch.js           — world→screen mapping, camera (lerp, clamp, punch, shake), pitch + crowd DOM
js/physics.js         — pure: ball, movement, possession, steal, walls, goal detection
js/ai.js              — pure: produces intents for AI-controlled players
js/input.js           — touch + keyboard → intents for human players
js/match.js           — pure: match state machine, score, timer, event list
js/render.js          — reads world + match state, writes transforms/classes/score bar
js/audio.js           — Web Audio synth
js/game.js            — bootstrap, screen switching, the loop
```

each file is one IIFE exposing one namespace. `physics.js`, `ai.js`, `match.js` have no DOM access - that seam is what makes the renderer swappable and the logic testable in a plain script.

## config

```js
const CONFIG = {
  // pitch (world units)
  pitchW: 2400, pitchH: 900, goalMouth: 320, depthShrink: 0.15,
  // match
  goalsToWin: 3, matchSeconds: 90, goalPauseMs: 2500,
  // movement
  playerSpeed: 380, aiSpeedMult: 0.85, gkTrackSpeed: 300,
  shootPowerMin: 500, shootPowerMax: 1400, ballFriction: 0.985, wallBounce: 0.7,
  stealImmunityMs: 500, shootRange: 700, pressureDist: 160,
  // feel
  zoomPunch: 1.3, slowMoMs: 200, shakePx: 6,
  // assets
  partMaxPx: 256, paperThreshold: 235,
  // teams
  teamColours: ['#e63946', '#457b9d'],
  // scenes
  scene: 'grass',            // stage 5: 'moon', 'candy', 'backyard', …
};
```

## tinkerability - honest scope

**safe to change without a session** (config.js, plain values): speeds, match length, goals to win, colours, how hard the AI is, how big the zoom punch is, image size cap.

**safe to do in the game itself**: everything in the editor - characters, teams, ball.

**needs a Claude Code session**: new animation states, new controls, new AI behaviours, power-ups, new pitch themes, export/import.

## the user journey - read this to him

*this is what the finished game feels like, in his terms. read it aloud, then ask the questions in the next section.*

---

you open you-ball and there's a grass pitch waiting. but first - you get to make your player.

you tap the pencil. a blank little soccer player stands there, waiting. you tap its head. the camera opens. you take a photo of your own face - or dad's face, or the dog's face, or a drawing you made. you make it bigger or smaller so it fits. tap the tick. now the little player has your face, and it's already running on the spot, ready to go.

you can do the same for the body, the arms, the legs. or you can leave them as they are - your face on a cartoon body is already funny. you can also make two more faces: your GOAL face (the one you pull when you score) and your sad face (for when the other team scores). the player will use them at the right moments.

you can make lots of players. put them in a team. pick a colour. you can even change the ball - the ball can be anyone's face.

then you play. your team is on the pitch with the other team. you drag your finger and your player runs where you point. when you touch the ball, it sticks to your feet and comes with you. flick your finger and you shoot - a fast flick is a hard shot. the other team tries to bump into you and take the ball. you can bump into them and take it back. there are walls all around, so the ball never goes out - it just bounces.

when you score, everything goes slow, the picture zooms in, fireworks go off over the pitch, and everyone dances - your team with their GOAL faces on, the other team too, but with their sad faces. the crowd goes wild. then you kick off again.

first team to three goals wins, or whoever's ahead when the clock runs out. the winners line up and dance. then you can play again, or go back and change your team.

and if dad plays too, he gets the keyboard and you get the screen - or the other way round - and it's you against him.

---

## design decisions for him - resolved

1. **name**: **you-ball** (repo `you-ball`, storage keys `youBall_*`)
2. **on a goal**: fireworks + everyone dances
3. **pitch**: grass first; more scenes in stage 5
4. **default heads**: illustrated, cute

next questions to read aloud, one or two per session (car-doctor pattern):
- whose head goes on the first character?
- what colour are the two teams?
- what sound does the ball make when you kick it?

## build stages

### stage 0 - the spike *(proves the concept)*

one default character on the pitch, a ball, one empty goal. drag to move, flick to kick, ball bounces off walls, scores → GOAL face + zoom punch + cheer. no AI, no editor, no match state.

**purpose** - answer four questions on the actual tablet:
1. does the paper doll read well at match scale, including when facing left?
2. does drag + flick feel right for small fingers? (tune dead zones, flick threshold)
3. does the depth scaling look like a pitch or like a mistake?
4. does 48 animating `<img>`s hold 60fps on the target device? (fake 8 characters running for this test)

### stage 1 - a face on the pitch
- editor with one slot (`head_idle`): pick, adjust, save to IndexedDB, appears on the character
- persistence across reload
- import pipeline incl. downscale

### stage 2 - a match
- 4v4, AI teammates + opponents, both GKs
- possession, steal, pass, auto-switch
- score, timer, kickoff, fulltime screen
- `sad` face on conceding, `celebrate` on scoring

### stage 3 - the full editor
- all slots + three faces, paper mode
- roster, teams, team colour + badge, ball image
- editor live preview

### stage 4 - feel + two players
- juice list above
- local two-player on keyboard
- difficulty presets

### stage 5 - his ideas
- new scenes (his list so far is open - moon, candy, backyard were only examples), weather
- power shot (charge → screen flash → unstoppable), items
- export / import a character or team as a file
- anything from the design questions read aloud

## risks and open questions

- **controls are the biggest unknown.** drag + flick is a proposal; stage 0 exists to test it with his hands, not ours. fallback: on-screen virtual joystick + one big shoot button
- **landscape only** - a rotate-your-device prompt is needed in portrait
- **storage is per device, per browser.** a team built on the tablet doesn't appear on the desktop until export/import (stage 5). say so in the README so it isn't read as a bug
- **photos mirror when facing left.** almost certainly fine for kids; if it bothers anyone, a per-character "don't mirror the head" flag is a one-liner
- **performance** - DOM should be fine at this count with transform-only animation, but measure in stage 0 before committing to the rig density
- **privacy** - real children's faces. on-device only, and keep it that way when adding features
