/**
 * CONFIG - every tunable value in one place.
 *
 * Safe to edit by hand without a code session: speeds, match length, goals to
 * win, colours, how hard the AI is, how big the zoom punch is, the image size
 * cap. Anything here is a plain number, string or array.
 *
 * The one function in this file is applyScene, at the bottom. It swaps between
 * the value sets in `scenes`, and it lives here so a scene's numbers and the
 * switch that applies them stay in one place.
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
  /* How fast you have to be going sideways before you turn round. This was
     effectively 3% of top speed, so a player running up the pitch with any
     sideways drift flipped constantly - and because the ball is held at
     facing * carryOffset, every flip teleported it across their body. */
  facingFlipSpeed: 110,
  /* How quickly the ball crosses when you do turn, as a fraction closed per
     second. A turn is real, but it should sweep rather than jump. */
  carryTurnRate: 14,
  /* Two thresholds for the run animation, not one. With a single threshold a
     player decelerating through it flips between run and idle frame by frame,
     and because every change restarts the CSS animation from its first
     keyframe, the legs snap back each time. Measured at one frame per state
     at worst - which is exactly what "jittery, but not lagging" looks like. */
  runEnterSpeed: 90,
  runExitSpeed: 22,
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
  bounceScatter: 0,      // radians of random deflection off a wall. 0 is a
                         // clean reflection; the ball pool scene turns it up
  ballFireMs: 1100,      // how long a fully wound kick leaves the ball alight
  stealImmunityMs: 500,  // a fresh carrier cannot be robbed for this long
  looseBallMs: 180,      // after a shot/pass, nobody can pick the ball up
  carrierSpeedMult: 0.93,// carrying the ball slows you slightly, so a chase is
                         // not hopeless and a converging defender can cut you off
  // Being tackled costs you a moment. Without this, two equal-speed players
  // stand on each other and trade the ball every half second forever - the ball
  // never leaves midfield and nobody ever gets a shot away.
  tackleStunMs: 400,     // the dispossessed player cannot steer for this long
  tackleClearance: 1.3,  // …and is pushed back to this multiple of stealDist

  /* ─── AI ─── */
  shootRange: 700,
  pressureDist: 160,
  aiJitter: 60,          // how far a formation slot wanders, world units
  aiReactionMs: 140,     // how often an AI player re-decides
  aiSettleMs: 350,       // an AI carrier runs with the ball this long before it
                         // will consider passing - without it, possession is a
                         // hot potato and nobody ever reaches shooting range
  aiMinPassGain: 180,    // a pass must move the ball this far up the pitch,
                         // which is what stops two players passing in a loop
  aiPointBlank: 340,     // this close to goal, shoot whatever is in the way
  shootNoise: 0.10,      // radians of aim error on an AI shot
  gkReach: 190,          // how far a keeper will stray from its line

  /* ─── Difficulty presets (multiply the values above) ─── */
  /*
   * Difficulty describes the OPPOSITION only - see AI.applyDifficulty. Your
   * own teammates and keeper always play at full.
   *
   * These three numbers are how fast the other side runs, how fast their
   * keeper tracks a shot, and how much aim error their shots carry. Simulation
   * can tell us the dial moves monotonically; it cannot tell us where a real
   * child lands, because a slower AI is still a good player and a kid is not.
   * So these are set to be forgiving, and the last word is a real match.
   */
  difficulty: 'normal',
  difficulties: {
    easy:   { aiSpeed: 0.66, gkTrack: 0.60, shootNoise: 2.2 },
    normal: { aiSpeed: 0.82, gkTrack: 0.78, shootNoise: 1.5 },
    hard:   { aiSpeed: 1.00, gkTrack: 1.05, shootNoise: 0.8 },
  },

  /* ─── Feel ─── */
  zoomPunch: 1.3,
  slowMoMs: 200,
  slowMoScale: 0.25,     // time runs at a quarter speed during the punch
  shakePx: 6,
  camLerp: 0.08,         // how quickly the camera catches the ball (0..1 per tick)
  trailMinSpeed: 900,    // ball trail appears above this speed

  /* ─── Music ─── */
  /*
   * The anthem. Tempo, balance and the rules that decide which layers play.
   * Every value here is safe to turn by ear without touching audio.js: the
   * scheduler reads them fresh on each beat.
   */
  music: {
    bpm: 132,
    gain: 0.42,          // the music bus, deliberately under the effects
    duckGain: 0.05,      // where the bus drops to for a goal celebration
    duckMs: 240,         // how long the duck and the recovery take
    /* Taking the ball swings the music at once - this is a fast game and the
       change is the whole point. What keeps that from strobing is a floor on
       how often it may happen: a possession spell lasts about half a second,
       so without minDwell the arrangement would flicker twice a second. The
       first change is always immediate; only a second one has to wait.

       Losing the ball to nobody is the asymmetric case. The ball is loose
       during every pass, so the verse only returns once it has stayed loose
       for looseMs.

       Texture and harmony move at different speeds. Dropping the hook and
       bringing in the drone is what you actually hear change, and it can
       happen a beat after the tackle. Moving the chord progression cannot: it
       needs a bar to mean anything. Splitting the two is what lets the music
       answer a turnover without losing the plot. */
    layerDwellBeats: 2,  // how long a texture holds before it may change again
    minDwellBeats: 6,    // and how long the harmony holds
    looseMs: 900,        // the ball must be nobody's this long to drop to the verse
    lookaheadMs: 200,    // how far ahead of the clock notes are queued
    tickMs: 50,          // how often the scheduler wakes up
    swing: 0.012,        // late-eighth push, in beats. 0 is dead straight
    /* Per-layer peak gain. Drop one to zero to mute that layer entirely. */
    layer: {
      kick:  0.50,
      snare: 0.22,
      hat:   0.045,
      bass:  0.20,
      chug:  0.085,
      stab:  0.13,
      hook:  0.10,
      melody: 0.105,   // driven now, so it carries further at a lower number
      chant: 0.11,
      drone: 0.06,
    },
  },

  /* ─── Assets ─── */
  partMaxPx: 256,        // long side of an imported part, in pixels
  paperThreshold: 235,   // pixels brighter than this go transparent in paper mode

  /* ─── Teams ─── */
  teamColours: ['#e63946', '#457b9d'],
  teamNames: ['home', 'away'],

  /* ─── Scenes ─── */
  /*
   * A scene is a CSS class on #pitch plus the overrides below. Nothing in the
   * game code branches on which scene is playing.
   *
   * These are not decoration. A kid asks to play on the moon because of what
   * the moon does, so each scene moves the handful of values that carry the
   * feeling: how far the ball rolls, how lively the walls are, how quickly a
   * player can change direction. Moon and pool are deliberate opposites.
   *
   * The AI values move too. Its shooting range assumes a ball that travels a
   * certain distance, so a scene that changes the ball's roll has to change
   * the range with it, or nobody scores. test/logic.js checks each scene.
   */
  scene: 'grass',
  /*
   * Which effects a scene emits, by name. The vocabulary lives in render.js
   * (dust, ripple, splash); a scene only chooses from it. So a new scene is
   * still CSS plus config, and only a genuinely new *kind* of effect costs a
   * code change.
   *   kick / wall / tackle  - one burst at that spot
   *   run          - while a player is moving, throttled
   *   ballBob      - world units the ball rides up and down by
   *   loose        - how many loose balls lie on the pitch and get shoved
   *                  about. Decoration only: they never touch the match.
   */
  fx: {},
  scenes: {
    /* The baseline. Every value above is already the grass value. */
    grass: {},

    /* Low gravity reads, in a game with no vertical axis, as nothing ever
       stopping: the ball slides on and players skate through their turns. */
    moon: {
      ballFriction: 0.994,
      wallBounce: 0.88,
      playerSpeed: 400,
      playerAccel: 1300,
      playerFriction: 0.94,
      tackleClearance: 1.9,
      shootRange: 1100,
      gkTrackSpeed: 340,
      pickupDist: 46,
      stealDist: 92,
      looseBallMs: 320,
      fx: { kick: 'dust', run: 'dust', wall: 'dust', tackle: 'dust' },
    },

    /* Water is the opposite: everything is heavy and nothing carries. You have
       to get close to score, because a shot dies on its way. */
    pool: {
      /* The weight is in the ball. A shot dies on its way, so you have to get
         closer to score, and the walls are soggy rather than springy. */
      ballFriction: 0.968,
      wallBounce: 0.34,
      shootPowerMin: 560,
      shootPowerMax: 1250,
      shootRange: 560,
      /* Players wade a little, but only a little. Slowing them further, or
         blunting their acceleration, made the pitch effectively too long: the
         AI could never work the ball into shooting range and every match
         finished nil-nil. Measured, not guessed - see test/logic.js. */
      playerSpeed: 350,
      playerFriction: 0.72,
      carrierSpeedMult: 0.90,
      stealDist: 72,
      fx: { kick: 'splash', run: 'ripple', wall: 'splash', tackle: 'splash', ballBob: 3 },
    },

    /* Springy and unpredictable. The scatter is what makes it a ball pool
       rather than a bouncy pitch. */
    ballpit: {
      ballFriction: 0.982,
      wallBounce: 0.92,
      bounceScatter: 0.22,
      playerSpeed: 320,
      playerAccel: 1500,
      playerFriction: 0.82,
      tackleClearance: 1.6,
      shootPowerMax: 1250,
      shootRange: 680,
      pickupDist: 44,
      stealDist: 88,
      looseBallMs: 320,
      fx: { loose: 190 },
    },
  },

  /* ─── Controls ─── */
  dragDeadZonePx: 14,    // finger travel before the joystick engages
  flickMaxMs: 220,       // a release within this long of the last move is a flick
  flickMinPx: 24,        // …and over this far, in the last few frames
  // Winding a kick up is one accumulator with two ways to start it: the shoot
  // key on a keyboard, a finger held still on a touch screen. windUpMs keeps a
  // wind-up and a tap apart - under it a finger is still just a tap, so
  // tap-to-pass survives a child who is slow letting go. It belongs to the
  // finger alone and is no part of the ramp: a shoot key has nothing to
  // disambiguate, so the meter moves from the first frame you press it.
  windUpMs: 240,         // touch: held this long before it counts as a wind-up
  holdMaxMs: 650,        // …and this long, from first contact, for full power.
                         // Has to stay clear of stealImmunityMs (500) or a
                         // wind-up is free, nobody being able to tackle you
                         // while it runs. Measured, 550-800 all behave the
                         // same, so this is picked for feel inside that band.
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

/**
 * Switch scene: restore every value any scene touches, then lay the chosen
 * scene's overrides on top.
 *
 * The baseline is captured the first time this runs, before anything has been
 * overridden, so switching scenes repeatedly always starts from the values as
 * written above rather than from whatever the last scene left behind.
 *
 * @param {string} name - a key of CONFIG.scenes; anything unknown falls back
 *   to grass
 * @returns {string} the scene actually applied
 */
CONFIG.applyScene = (() => {
  let baseline = null;
  return function applyScene(name) {
    const scenes = CONFIG.scenes || {};
    if (!baseline) {
      baseline = {};
      for (const set of Object.values(scenes)) {
        for (const key of Object.keys(set)) {
          if (!(key in baseline)) baseline[key] = CONFIG[key];
        }
      }
    }
    const chosen = scenes[name] ? name : 'grass';
    Object.assign(CONFIG, baseline, scenes[chosen]);
    CONFIG.scene = chosen;
    return chosen;
  };
})();
