# you-ball

**[play it](https://alondmnt.com/you-ball/)**

a soccer game for kids where the players are built from your own pictures. a photo for the head, a drawing for the body, whatever you like for the arms and legs. each character has three faces - normal, GOAL, and sad - so the whole team reacts to what is happening in the match.

## origins

a father-and-child project, in the same line as [car-doctor](https://github.com/alondmnt/car-doctor) and [boo-boss](https://github.com/alondmnt/boo-boss). the child's calls so far: everyone dances when a goal goes in (both teams, the conceding side with their sad faces on), grass first, illustrated default heads.

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

on the moon, players kick up dust when they run and throw a cloud of it when they shoot. in the pool they push ripples out with every step, kicks throw droplets, and the ball bobs. in the ball pool the balls scatter when you run through them and roll back afterwards, and a hard shot ploughs a line through them.

a pool rather than an ocean, because the game is a walled pitch and the ball bounces off the edges. an ocean has no walls.

## the music

a rock song, synthesised note by note like every other sound, that follows the ball.

it is written in sixteen-bar parts - four four-bar phrases with an arc through them - and two parts alternate, so nothing comes round again inside about a minute. each team has its own pair: home is bright and climbs, away sits on a flat second and walks down onto it. both are in the same key at the same tempo, so possession can turn over mid-bar and the music just carries on.

each part has its own rhythm, played by the bass and the guitar together. home drives in eighths; away is heavier and leaves gaps, under a half-time drum beat. every fourth bar turns - a different figure and a snare fill - so you can hear the seams.

over the top there is a tune. it does not start straight away: the first half of a part is riff with an answering hook, then the melody comes in and carries the second half and the whole of the other part. it is written to be singable by the kid holding the tablet. the other team's music has no tune in it at all - just the riff and a drone.

three textures play over whichever part is running:

| | what you hear |
|---|---|
| your team has it | full kit, power chord stabs, the hook, a crowd shout |
| the other team has it | half time drums, a chugging guitar, a drone, no hook |
| nobody has it | the same harmony with most of the notes taken out. this is the verse, and it is what makes the rest land |

the scoreline colours whoever is carrying: a team in front gains an octave on the chords, a team behind gets double time hats. a goal ducks the music so the fanfare and the crowd have the room, and it comes back up under the KICK OFF banner.

texture and harmony move at different speeds on purpose. losing the ball changes the drums and drops the hook within about half a second, because that is the bit you actually hear. the chord progression waits for possession that has lasted a couple of seconds, because a progression needs a bar or two to say anything.

it is inspired by the loud-quiet-loud of terrace rock, but the riff is ours - nothing is sampled and nothing is quoted.

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

it is hosted at [alondmnt.com/you-ball](https://alondmnt.com/you-ball/), so you only need this for development.

no build step and no dependencies, but it does need to be served over http rather than opened as a file. chrome blocks IndexedDB on a `file://` page, and that is where the pictures live:

```
python3 -m http.server 8000
```

then open `http://localhost:8000`. to try it on a tablet on the same network, bind to every interface instead and open `http://<your-machine-ip>:8000` from the tablet:

```
python3 -m http.server 8000 --bind 0.0.0.0
``` opened as a plain file the game still plays, it just cannot save pictures, and the editor says so.

save data lives in localStorage under `youBall_progress`; pictures live in IndexedDB under `youBall_assets`.

## tuning

`js/config.js` is every number in one place - speeds, match length, goals to win, how hard the computer is, colours, how big the zoom punch is, the size images are stored at. plain values, safe to edit.

the music is in there too, under `music`: tempo, the balance of every layer (set one to zero to mute it), and how fast the arrangement answers the game. `layerDwellBeats` is the one to turn if it feels twitchy or sluggish - at 2 beats the music answers a tackle in about 600ms and changes texture around 40 times a minute; at 4 it is 1.3s and 28 times a minute.

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
