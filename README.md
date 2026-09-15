# you-ball

a soccer game for kids where the players are built from your own pictures. a photo for the head, a drawing for the body, whatever you like for the arms and legs. each character has three faces - normal, GOAL, and sad - so the whole team reacts to what is happening in the match.

## origins

a father-and-child project, in the same line as [car-doctor](../car-doctor) and [boo-boss](../boo-boss). the child's calls so far: everyone dances when a goal goes in (both teams, the conceding side with their sad faces on), grass first, illustrated default heads.

## how to play

pick **play** and you are on the pitch. you control one field player at a time - the one with the arrow over their head. control moves on its own: when your team has the ball you are whoever has it, and when they do not you are whoever is nearest it. both goalkeepers are always the computer.

touching the ball takes it, and it then sticks to your foot until you shoot, pass, or someone bumps into you and takes it. bumping into them takes it back. there is no tackle button - you just run into whoever has the ball. whoever loses it gets spun round and takes a moment to find their feet, so possession actually goes somewhere. nobody gets hurt and nobody gets a card, because there are no fouls.

the pitch is walled on all four sides. the ball never goes out, it just bounces. no throw-ins, no corners, no offside, no fouls.

first to three goals, or whoever is ahead when ninety seconds are up.

## controls

**touch** - one finger:

- drag from anywhere - the player runs the way you point
- flick and let go - shoot along the flick, a fast flick is a hard shot
- tap - pass, or if you do not have the ball, switch to whoever is nearest it

**keyboard**:

- arrow keys move, space shoots (hold it for more power), shift passes
- turn on two players in the editor and the second player gets WASD, F to shoot, G to pass

the keys are printed on the splash screen and under the two-player toggle in the editor, so nobody has to come here to find them. player one is the home team, player two the away team, and touch and the arrow keys are the same seat - so the kid can drag on the screen while you take WASD.

## where you play

four places, picked in the editor. they are not just different colours - each one plays differently.

| | what it looks like | what it feels like |
|---|---|---|
| 🌱 grass | a normal pitch | the ordinary game |
| 🌙 moon | grey dust, craters, stars | nothing ever stops. the ball slides on and on, players skate through their turns, the walls are springy |
| 🏊 pool | water, lane ropes, umbrellas | heavy. a shot dies on its way, so you have to get close to score, and the walls are soggy |
| 🔴 ball pool | a floor of coloured balls, padded walls | springy and unpredictable. the ball comes off a wall at an angle you did not expect |

on the moon, players kick up dust when they run and throw a cloud of it when they shoot. in the pool they push ripples out with every step, kicks throw droplets, and the ball bobs. the balls in the ball pool do not move yet.

a pool rather than an ocean, because the game is a walled pitch and the ball bounces off the edges. an ocean has no walls.

## making players

the pencil opens the editor.

1. tap **+** for a new character, or tap one you already made
2. tap a slot - face, GOAL face, sad face, body, arms, legs - and pick a picture. on a tablet that offers the camera
3. drag to move it and pinch or scroll to size it, then tap the tick
4. **✏️ paper** turns the white page behind a crayon drawing transparent. leave it off for photos
5. tap the character to cycle its three faces and watch them
6. tap a place in a team row and pick a face for it. the round place on the left is the goalkeeper, and every face is shown in that team's colours so you can see how they will look. **–** leaves the place to a built-in player, **+** makes a new character and puts them straight in
7. the ball is a picture slot too

anything you do not fill in stays as a built-in cartoon part, so a character is playable the moment you make it. a face on a default body is the usual case.

## privacy

**nothing leaves the device.** there is no upload, no account, no sharing feature, and no network call of any kind. pictures live in your browser's own storage on that one device. real children's faces are involved, and it stays that way.

the flip side: a team built on the tablet does not appear on the desktop. that is how it works, not a bug. moving characters between devices needs an export file, which is not built yet.

## run locally

no build step and no dependencies, but it does need to be served over http rather than opened as a file. chrome blocks IndexedDB on a `file://` page, and that is where the pictures live:

```
python3 -m http.server 8000
```

then open `http://localhost:8000`. opened as a plain file the game still plays, it just cannot save pictures, and the editor says so.

save data lives in localStorage under `youBall_progress`; pictures live in IndexedDB under `youBall_assets`.

## tuning

`js/config.js` is every number in one place - speeds, match length, goals to win, how hard the computer is, colours, how big the zoom punch is, the size images are stored at. plain values, safe to edit.

the scenes live there too, as a short list of overrides each. a new scene is a block of CSS and a handful of numbers, not a code change. if you change a scene's numbers, run the tests below: they check that each scene still produces goals, which is the thing that quietly breaks.

## tests

the game logic has no DOM in it, so it runs in plain node:

```
node test/logic.js
```

## tech

built with AI (Claude Code). vanilla JS, DOM and CSS animation, inline SVG, Web Audio synthesis, IndexedDB. modules load as plain `<script>` tags in a fixed order, each exposing one IIFE namespace. no framework, no bundler, no dependencies.

`physics.js`, `ai.js` and `match.js` never touch the DOM. that seam is what keeps the renderer swappable and the logic testable.

## design

see [docs/plan.md](docs/plan.md) for the original design and [docs/design.md](docs/design.md) for how it was actually built - the coordinate system, the module seams, and where the build departed from the plan and why.
