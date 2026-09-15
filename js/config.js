/**
 * CONFIG - every tunable value in one place.
 *
 * Safe to edit by hand without a code session: speeds, match length, goals to
 * win, colours, how hard the AI is, how big the zoom punch is, the image size
 * cap. Anything here is a plain number, string or array - no behaviour lives in
 * this file.
 *
 * World units: x runs goal to goal (0..pitchW), y runs near touchline to far
 * touchline (0..pitchH). y = 0 is the NEAR touchline - it renders at the bottom
 * of the screen, at full scale, in front of everything further up the pitch.
 */
const CONFIG = {

  /* ─── Pitch (world units) ─── */
  pitchW: 2400,          // goal line to goal line
  pitchH: 900,           // near touchline to far touchline
  goalMouth: 320,        // width of the goal opening, centred on pitchH / 2
  goalDepth: 70,         // how far the net sits behind the goal line
  depthShrink: 0.15,     // a player on the far touchline is 15% smaller
  cameraViewW: 1500,     // world units visible across the screen at zoom 1

  /* ─── Match ─── */
  goalsToWin: 3,
  matchSeconds: 90,
  goalPauseMs: 2800,     // celebration length before the next kickoff
  kickoffPauseMs: 1200,  // "KICK OFF" beat before play resumes

  /* ─── Sizes (world units) ─── */
  ballRadius: 16,
  playerRadius: 42,
  playerDrawH: 150,      // how tall a player is drawn, in world units
  ballDrawD: 46,         // how wide the ball is drawn - larger than its physics
                         // radius so a small screen still reads it clearly
  pickupDist: 58,        // ball within this of a player -> that player carries it
  stealDist: 76,         // opponent within this of the carrier -> steal
  carryOffset: 46,       // how far in front of the carrier the ball sits

  /* ─── Movement ─── */
  playerSpeed: 380,      // world units per second
  playerAccel: 2600,     // how fast a player reaches top speed
  playerFriction: 0.86,  // per-frame velocity decay when not pressing a direction
  aiSpeedMult: 0.85,
  gkTrackSpeed: 300,
  gkDiveSpeed: 720,

  /* ─── Ball ─── */
  shootPowerMin: 500,
  shootPowerMax: 1400,
  passPower: 820,
  puntPower: 900,
  ballFriction: 0.985,   // per 60Hz tick
  wallBounce: 0.7,
  stealImmunityMs: 500,  // a fresh carrier cannot be robbed for this long
  looseBallMs: 180,      // after a shot/pass, nobody can pick the ball up

  /* ─── AI ─── */
  shootRange: 700,
  pressureDist: 160,
  aiJitter: 60,          // how far a formation slot wanders, world units
  aiReactionMs: 140,     // how often an AI player re-decides
  shootNoise: 0.10,      // radians of aim error on an AI shot
  gkReach: 190,          // how far a keeper will stray from its line

  /* ─── Difficulty presets (multiply the values above) ─── */
  difficulty: 'normal',
  difficulties: {
    easy:   { aiSpeed: 0.72, gkTrack: 0.65, shootNoise: 2.0 },
    normal: { aiSpeed: 1.00, gkTrack: 1.00, shootNoise: 1.0 },
    hard:   { aiSpeed: 1.18, gkTrack: 1.35, shootNoise: 0.4 },
  },

  /* ─── Feel ─── */
  zoomPunch: 1.3,
  slowMoMs: 200,
  slowMoScale: 0.25,     // time runs at a quarter speed during the punch
  shakePx: 6,
  camLerp: 0.08,         // how quickly the camera catches the ball (0..1 per tick)
  trailMinSpeed: 900,    // ball trail appears above this speed

  /* ─── Assets ─── */
  partMaxPx: 256,        // long side of an imported part, in pixels
  paperThreshold: 235,   // pixels brighter than this go transparent in paper mode

  /* ─── Teams ─── */
  teamColours: ['#e63946', '#457b9d'],
  teamNames: ['home', 'away'],

  /* ─── Scenes ─── */
  scene: 'grass',        // one CSS class on #pitch - 'moon', 'candy', … later

  /* ─── Controls ─── */
  dragDeadZonePx: 14,    // finger travel before the joystick engages
  flickMaxMs: 220,       // a release within this long of the last move is a flick
  flickMinPx: 24,        // …and over this far, in the last few frames
  holdMaxMs: 900,        // keyboard shoot: hold this long for maximum power
  twoPlayer: false,      // true = WASD drives a second human on the away team

  /* ─── Formation ─── */
  /*
   * Slots for the team defending the x = 0 goal, in world units. The away team
   * uses the mirror (pitchW - x). Field slots slide along x with the ball; see
   * ai.js. Order is [gk, defender, midfielder, forward].
   */
  formation: [
    { x: 110,  y: 450 },
    { x: 560,  y: 240 },
    { x: 820,  y: 450 },
    { x: 1080, y: 680 },
  ],
  formationBallPull: 0.42,  // how far a slot drifts toward the ball's x
};
