/**
 * Audio - Web Audio synthesis: the effect catalogue and the anthem. Every
 * sound is generated; there are no files to load, so nothing delays the first
 * kick and nothing is fetched from anywhere.
 *
 * Two halves. The top is one-shot effects, fired by name from game.js. The
 * bottom is the music: a four bar loop whose arrangement follows possession
 * and the scoreline, described in its own header down there.
 *
 * The AudioContext is created on the first user gesture (the splash tap), which
 * is what the autoplay policy requires, and resumed on any later gesture so it
 * survives the device going to sleep. Same approach as the other games.
 */
const Audio = (() => {
  let ctx = null;
  let unlocked = false;
  let muted = false;
  let master = null;

  /** Create the AudioContext. Call from inside a user gesture. */
  function unlock() {
    if (unlocked) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
    unlocked = true;
    _mStart();          /* music asked for before the first gesture starts now */
  }

  /** Resume a context suspended by a sleep or a tab switch. */
  function resume() {
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }

  function isMuted() { return muted; }

  /**
   * Mute or unmute everything. The music scheduler stops outright rather than
   * playing to a silent bus, so a muted game costs nothing to run.
   * @param {boolean} on
   */
  function setMuted(on) {
    muted = !!on;
    if (muted) _mStop(); else _mStart();
  }

  /**
   * One note with a click-free envelope.
   * @param {number} freq - Hz
   * @param {number} start - delay from now, seconds
   * @param {number} dur - seconds
   * @param {string} type - oscillator type
   * @param {number} vol - peak gain
   * @param {number} [endFreq] - glide to this frequency over the note
   * @param {AudioNode} [dest] - where to connect; the master bus by default
   * @param {number} [at] - absolute context time, overriding `start`. A one
   *   shot effect wants a delay from now; a sequencer wants this, because
   *   every voice of one beat has to share a single clock reading or the beat
   *   smears by however far the clock moved between them.
   */
  function _note(freq, start, dur, type, vol, endFreq, dest, at) {
    if (!ctx || ctx.state !== 'running') return;
    const t = at != null ? at : ctx.currentTime + start;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(Math.max(1, endFreq), t + dur);
    gain.gain.setValueAtTime(0.001, t);
    gain.gain.linearRampToValueAtTime(vol || 0.12, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain).connect(dest || master);
    osc.start(t);
    osc.stop(t + dur);
  }

  /**
   * A burst of filtered noise.
   * @param {number} start - delay from now, seconds
   * @param {number} dur - seconds
   * @param {number} freq - filter cutoff or centre, Hz
   * @param {number} vol - peak gain
   * @param {string} [filterType] - 'lowpass' (default) or 'bandpass'
   * @param {number} [endFreq] - sweep the filter to here
   * @param {AudioNode} [dest] - where to connect; the master bus by default
   * @param {number} [at] - absolute context time, overriding `start`; see _note
   */
  function _noise(start, dur, freq, vol, filterType, endFreq, dest, at) {
    if (!ctx || ctx.state !== 'running') return;
    const t = at != null ? at : ctx.currentTime + start;
    const n = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType || 'lowpass';
    filter.frequency.setValueAtTime(freq || 400, t);
    if (endFreq) filter.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), t + dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, t);
    gain.gain.linearRampToValueAtTime(vol || 0.08, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filter).connect(gain).connect(dest || master);
    src.start(t);
  }

  /* ─── Effects ─── */

  const effects = {
    /**
     * Boot the ball. A pitch-dropping thump plus a leather click; both scale
     * with power, so a tap and a screamer do not sound the same.
     * @param {number} [power] - 0..1
     */
    kick(power) {
      const p = Math.max(0.2, Math.min(1, power == null ? 0.7 : power));
      _note(170 + 90 * p, 0, 0.12 + 0.05 * p, 'sine', 0.16 + 0.12 * p, 55);
      _noise(0, 0.05, 2600, 0.09 * p, 'bandpass');
    },

    /** Ball off a wall - a short wooden bonk. */
    wall() {
      _note(240, 0, 0.07, 'triangle', 0.09, 150);
      _noise(0, 0.04, 1400, 0.05);
    },

    /** A tackle - the swish of the ball being nicked, not a body check. */
    steal() {
      _noise(0, 0.09, 1500, 0.05, 'bandpass', 3400);
      _note(520, 0.03, 0.08, 'sine', 0.07, 780);
    },

    /** Collecting a loose ball - a soft tick. */
    pickup() {
      _note(520, 0, 0.05, 'sine', 0.05);
    },

    /** A pass leaves the foot. */
    pass() {
      _note(300, 0, 0.07, 'triangle', 0.07, 420);
    },

    /** The keeper gets a hand to it. */
    save() {
      _noise(0, 0.13, 700, 0.11);
      _note(180, 0, 0.13, 'sine', 0.1, 120);
      _note(660, 0.06, 0.16, 'triangle', 0.06, 880);
    },

    /** Kickoff whistle - two harmonics with a little flutter. */
    whistle() {
      _note(1760, 0, 0.26, 'triangle', 0.1, 1900);
      _note(2640, 0, 0.26, 'sine', 0.045, 2800);
    },

    /** Full time - the same whistle, three times. */
    fulltime() {
      for (let i = 0; i < 3; i++) {
        _note(1760, i * 0.19, 0.16, 'triangle', 0.1);
        _note(2640, i * 0.19, 0.16, 'sine', 0.04);
      }
    },

    /** A goal: rising fanfare over a crowd swell. */
    goal() {
      const notes = [392, 523, 659, 784];
      notes.forEach((f, i) => {
        _note(f, i * 0.08, 0.3, 'triangle', 0.13);
        _note(f * 2, i * 0.08, 0.22, 'sine', 0.05);
      });
      effects.crowd();
    },

    /** Crowd swell - noise swept up through a bandpass, like a stand standing. */
    crowd() {
      _noise(0, 1.6, 420, 0.13, 'bandpass', 1500);
      _noise(0.12, 1.3, 900, 0.07, 'bandpass', 2000);
    },

    /** Conceding - a sad little slide down. */
    concede() {
      _note(330, 0, 0.26, 'sawtooth', 0.09, 247);
      _note(247, 0.24, 0.3, 'sawtooth', 0.09, 185);
      _note(185, 0.5, 0.5, 'sawtooth', 0.09, 139);
    },

    /** A button or a tap in the editor. */
    tap() {
      _note(660, 0, 0.05, 'sine', 0.07);
    },

    /** Saving an uploaded part - a bright confirming pling. */
    confirm() {
      _note(660, 0, 0.08, 'sine', 0.1);
      _note(990, 0.07, 0.14, 'sine', 0.08);
    },
  };

  /**
   * Play a named effect.
   * @param {string} name - a key of the effects catalogue
   * @param {*} [arg] - passed through (kick takes a power)
   */
  function play(name, arg) {
    if (!unlocked || muted) return;
    if (effects[name]) effects[name](arg);
  }

  /* ─── Music ─── */

  /*
   * The anthem: a four bar rock loop, synthesised note by note, that follows
   * the ball.
   *
   * Nothing is sampled and nothing is quoted. The debt to the terrace rock
   * this game is dressed after is its *shape* - a near silent verse, a loud
   * chorus, and a hook that is a rhythm rather than a tune - not any
   * particular song's notes. The riff below is ours.
   *
   * Two progressions share one grid, one tempo and one key centre:
   *
   *   home   Em Em C  D   - bright, and it climbs
   *   away   Em Em F  F   - the flat second, all menace
   *
   * and three textures play over whichever is running:
   *
   *   home   full kit, power chord stabs, the hook, a crowd chant
   *   away   half time drums, a chugging guitar, a drone, no hook
   *   loose  the same harmony with most of the notes taken out. This is the
   *          verse, and it is what makes the chorus land.
   *
   * The two move at different speeds on purpose. Texture is what you hear
   * change, so it answers a turnover within a beat. Harmony needs a bar or
   * two to mean anything, so it waits for possession to settle. Everything
   * lands on the same grid in the same key, so any join works.
   *
   * The scheduler is the standard Web Audio lookahead: a coarse setTimeout
   * wakes often enough to queue the next fraction of a second of notes at
   * sample accurate times. Queueing the whole loop in one go would be less
   * code, but then a change of possession would not be heard for twenty
   * seconds, which is the entire point of the feature.
   */

  /** Note names to frequencies. Written out so the riff below stays readable. */
  const HZ = {
    E2: 82.41, F2: 87.31, G2: 98.00, A2: 110.00, B2: 123.47, C3: 130.81,
    D3: 146.83, E3: 164.81, F3: 174.61, G3: 196.00, A3: 220.00, B3: 246.94,
    C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.00, A4: 440.00,
    B4: 493.88, C5: 523.25, D5: 587.33, E5: 659.26,
  };

  const STEPS_PER_BAR = 16;          /* the grid is sixteenths */
  const BARS = 4;
  const PHRASE_STEPS = STEPS_PER_BAR * BARS;

  /*
   * One bar of bass is eight eighth notes; null is a rest. The wiggle at the
   * end of each bar is what stops a root note pulse from becoming wallpaper.
   */
  const PHRASE = {
    home: {
      chord: ['E3', 'E3', 'C4', 'D4'],
      bass: [
        ['E2', 'E2', 'E2', 'E2', 'E2', 'E2', 'G2', 'E2'],
        ['E2', 'E2', 'E2', 'E2', 'G2', 'A2', 'B2', 'B2'],
        ['C3', 'C3', 'C3', 'C3', 'C3', 'C3', 'C3', 'B2'],
        ['D3', 'D3', 'D3', 'D3', 'D3', 'D3', 'C3', 'D3'],
      ],
    },
    away: {
      chord: ['E3', 'E3', 'F3', 'F3'],
      bass: [
        ['E2', 'E2', 'E2', 'E2', 'E2', 'E2', 'F2', 'E2'],
        ['E2', 'E2', 'E2', 'E2', 'E2', 'E2', 'F2', 'E2'],
        ['F2', 'F2', 'F2', 'F2', 'F2', 'F2', 'F2', 'F2'],
        ['F2', 'F2', 'F2', 'F2', 'E2', 'E2', 'F2', 'F2'],
      ],
    },
  };

  /*
   * The verse plays the same harmony with most of the notes taken out, which
   * is why it can drop in over either key without a join. Which of the eight
   * eighths in a bar survive:
   */
  const BASS_SPARSE = [0, 3, 5];

  /*
   * The hook. Bars 1 and 3 only: a lead that runs all four bars wears out
   * inside one match, and leaving two bars empty is what makes it a hook.
   * [step within the bar, note, length in sixteenths]
   */
  const HOOK = {
    1: [[8, 'B3', 2], [10, 'D4', 2], [12, 'E4', 4]],
    3: [[8, 'D4', 2], [10, 'B3', 2], [12, 'A3', 4]],
  };

  /* Which sixteenths each drum pattern lands on. */
  const KICK = { drive: [0, 6, 8, 14], sparse: [0, 8], half: [0, 10] };
  const SNARE = { backbeat: [4, 12], half: [8] };
  const HAT = {
    quarters: [0, 4, 8, 12],
    eighths: [0, 2, 4, 6, 8, 10, 12, 14],
    sixteenths: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  };
  const STAB = [0, 6, 8, 14];        /* syncopated, so the chorus pushes */
  const CHUG = [0, 2, 4, 6, 8, 10, 12, 14];
  const HOLD = [0, 4, 8, 12];        /* the verse guitar: a held breath, not a texture */
  const CHANT = [0, 2];              /* which bars get a shout, on the downbeat */

  /** One notch more drive on the hats, for a team that is behind. */
  const HAT_UP = { quarters: 'eighths', eighths: 'sixteenths', sixteenths: 'sixteenths' };

  /**
   * What the arrangement should be right now. Pure: no audio context, no
   * clock, no randomness, so the rules can be tested in node alongside the
   * physics.
   *
   * Taking the ball swings the theme immediately, because that change is the
   * feature. Two things stop it strobing: a swing holds for at least one bar
   * before another may happen, and the verse only comes back once the ball
   * has been nobody's for looseMs, since the ball is loose during every pass.
   *
   * Measured over real matches a possession spell runs about half a second,
   * which is why the floor is on the *rate* of change rather than on how long
   * possession has to be held. Waiting on the latter is what made this feel
   * late; the first change is now instant and only a second one is delayed.
   *
   * @param {object|null} prev - the last state this returned, or null to start
   * @param {object} input - {carrierTeam: 0|1|null, phase: string, score: number[]}
   * @param {number} dt - seconds since the previous call
   * @returns {object} {team, key, want, wantFor, looseFor, sinceSwing, theme,
   *   layers, duck}
   */
  function arrange(prev, input, dt) {
    const m = CONFIG.music;
    const carrier = (input && input.carrierTeam != null) ? input.carrierTeam : null;
    const score = (input && input.score) || [0, 0];
    const phase = (input && input.phase) || 'kickoff';
    const step = dt || 0;

    const beat = 60 / m.bpm;
    const layerDwell = m.layerDwellBeats * beat;
    const keyDwell = m.minDwellBeats * beat;

    let team = prev ? prev.team : null;       /* drives the texture, moves fast */
    let key = prev ? prev.key : 0;            /* drives the harmony, moves slowly */
    let want = prev ? prev.want : null;
    let wantFor = prev ? prev.wantFor : 0;
    let looseFor = prev ? prev.looseFor : 0;
    /* A fresh arrangement starts out free to change, so the first swing of a
       match is immediate and only a second one inside the dwell has to wait. */
    let sinceSwing = prev ? prev.sinceSwing + step : layerDwell;

    /* Somebody carrying it counts at once; nobody carrying it has to persist. */
    const before = want;
    if (carrier != null) { want = carrier; looseFor = 0; }
    else {
      looseFor += step;
      if (looseFor >= m.looseMs / 1000) want = null;
    }
    wantFor = want === before ? wantFor + step : 0;

    /* Texture is rate limited: it follows at once, then holds for a beat or
       two so a scrappy midfield cannot strobe it. */
    if (want !== team && sinceSwing >= layerDwell) { team = want; sinceSwing = 0; }
    /* Harmony is sustain limited instead: it waits for possession that has
       actually lasted, because a chord progression needs a bar or two to say
       anything. It only ever belongs to a team, never to a loose ball, so the
       verse drops in over whichever progression is already running. */
    if (want != null && want !== key && wantFor >= keyDwell) key = want;

    const theme = team === 0 ? 'home' : team === 1 ? 'away' : 'loose';

    /* The scoreline colours whoever is carrying, and only them: ahead sounds
       triumphant, behind sounds hurried, level sounds like neither. */
    let diff = 0;
    if (team === 0 || team === 1) diff = score[team] - score[team === 0 ? 1 : 0];

    const layers = theme === 'home'
      ? { kick: 'drive', snare: 'backbeat', hat: 'eighths', bass: 'full',
          guitar: 'stab', hook: true, chant: true, drone: false }
      : theme === 'away'
        ? { kick: 'half', snare: 'half', hat: 'quarters', bass: 'full',
            guitar: 'chug', hook: false, chant: false, drone: true }
        : { kick: 'sparse', snare: null, hat: 'eighths', bass: 'sparse',
            guitar: 'hold', hook: false, chant: false, drone: false };

    layers.shine = diff > 0;
    if (diff < 0) layers.hat = HAT_UP[layers.hat];

    /* A goal owns the room: the fanfare, the concede slide and the fireworks
       all land in the same two seconds, and the music would only fight them.
       It comes back up under the KICK OFF banner rather than at the whistle,
       so the return is a build instead of a snap. */
    const duck = phase === 'slowmo' || phase === 'goal';

    return { team, key, want, wantFor, looseFor, sinceSwing, theme, layers, duck };
  }

  /* ─── The music graph ─── */

  let _mBus = null;      /* everything musical, so it can duck in one place */
  let _dist = null;      /* one shared amp: guitars distort into it together */
  let _mTimer = null;
  let _mOn = false;      /* the scheduler is running */
  let _mWanted = false;  /* the game wants music, even if mute says otherwise */
  let _mNext = 0;        /* context time of the next sixteenth */
  let _mStep = 0;        /* position in the phrase, 0..PHRASE_STEPS-1 */
  let _mState = null;    /* the latest arrangement from arrange() */
  let _mKey = 'home';    /* which progression is running, latched at the beat */
  let _mLayers = null;   /* which layers play, latched at the beat */

  /**
   * A soft clipping curve. This is the whole guitar tone: a sawtooth through
   * it reads as a distorted power chord, and it costs one node for the lot.
   * @param {number} k - drive
   * @returns {Float32Array}
   */
  function _distCurve(k) {
    const n = 1024, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    return curve;
  }

  /** Build the music bus and the amp. Safe to call repeatedly. */
  function _mGraph() {
    if (_mBus || !ctx) return;
    _mBus = ctx.createGain();
    _mBus.gain.value = CONFIG.music.gain;
    /* A limiter on the music alone. Eight layers landing on the same downbeat
       sum past full scale, and the effects have to stay clear of the anthem
       anyway, so the glue belongs here and not on the master. */
    const limit = ctx.createDynamicsCompressor();
    limit.threshold.value = -10;
    limit.knee.value = 6;
    limit.ratio.value = 6;
    limit.attack.value = 0.005;
    limit.release.value = 0.15;
    _mBus.connect(limit).connect(master);
    _dist = ctx.createWaveShaper();
    _dist.curve = _distCurve(11);
    _dist.oversample = '2x';
    const amp = ctx.createGain();
    amp.gain.value = 0.5;   /* the shaper sums every guitar note, so pad it */
    _dist.connect(amp).connect(_mBus);
  }

  /** Seconds per sixteenth at the configured tempo. */
  function _stepDur() { return 60 / CONFIG.music.bpm / 4; }

  /**
   * A bass note: sawtooth through a lowpass, so it has body on a laptop and
   * still carries on a tablet speaker, where the fundamental barely exists.
   */
  function _bassVoice(freq, t, dur, vol) {
    const osc = ctx.createOscillator();
    const lp = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, t);
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(760, t);
    gain.gain.setValueAtTime(0.001, t);
    gain.gain.linearRampToValueAtTime(vol, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(lp).connect(gain).connect(_mBus);
    osc.start(t);
    osc.stop(t + dur);
  }

  /**
   * A power chord: root, fifth, and the octave when the carrying team is
   * ahead. Straight into the shared amp, which is what makes it a guitar.
   * @param {number} root - root frequency
   * @param {boolean} octave - add the octave on top
   */
  function _guitarVoice(root, t, dur, vol, octave) {
    const freqs = [root, root * 1.4983];   /* a just fifth beats less than 3/2 */
    if (octave) freqs.push(root * 2);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, t);
    gain.gain.linearRampToValueAtTime(vol, t + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    gain.connect(_dist);
    for (const f of freqs) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f, t);
      osc.connect(gain);
      osc.start(t);
      osc.stop(t + dur);
    }
  }

  /** A sustained detuned pair. The away theme's unease, held under the bar. */
  function _droneVoice(freq, t, dur, vol) {
    const lp = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(420, t);
    gain.gain.setValueAtTime(0.001, t);
    gain.gain.linearRampToValueAtTime(vol, t + 0.25);
    gain.gain.linearRampToValueAtTime(0.001, t + dur);
    lp.connect(gain).connect(_mBus);
    for (const f of [freq, freq * 1.008]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f, t);
      osc.connect(lp);
      osc.start(t);
      osc.stop(t + dur);
    }
  }

  /**
   * Put one sixteenth of the phrase on the clock.
   * @param {number} step - 0..PHRASE_STEPS-1
   * @param {number} when - context time the step lands on
   */
  function _emit(step, when) {
    const m = CONFIG.music;
    const L = m.layer;
    const bar = Math.floor(step / STEPS_PER_BAR);
    const s = step % STEPS_PER_BAR;
    const beat = 60 / m.bpm;
    const sixteenth = beat / 4;

    /* Both latch on the beat. Waiting for the bar line cost up to 1.8s, which
       reads as the music lagging the game; a chord arriving on beat three is
       ordinary in a rock arrangement, and both progressions are built on the
       same grid so the join always works. How often each is *allowed* to
       change is arrange's business, not the scheduler's. */
    if (s % 4 === 0) {
      _mKey = (_mState && _mState.key === 1) ? 'away' : 'home';
      _mLayers = (_mState && _mState.layers) || null;
    }
    const lay = _mLayers;
    if (!lay) return;

    /* Push the offbeat sixteenths late, which is the difference between a
       band and a drum machine. */
    const at = when + ((s % 4 === 2) ? m.swing * beat : 0);
    const phrase = PHRASE[_mKey];

    if (lay.kick && KICK[lay.kick].indexOf(s) >= 0) {
      _note(128, 0, 0.14, 'sine', L.kick, 44, _mBus, at);
    }
    if (lay.snare && SNARE[lay.snare].indexOf(s) >= 0) {
      _noise(0, 0.13, 1900, L.snare, 'bandpass', 900, _mBus, at);
      _note(196, 0, 0.09, 'triangle', L.snare * 0.5, 150, _mBus, at);
    }
    if (lay.hat && HAT[lay.hat].indexOf(s) >= 0) {
      /* Lean on the downbeat so a run of sixteenths still has a pulse. */
      const v = L.hat * (s % 4 === 0 ? 1 : 0.62);
      _noise(0, 0.028, 7600, v, 'highpass', 6200, _mBus, at);
    }
    if (lay.bass && s % 2 === 0) {
      const eighth = s / 2;
      const plays = lay.bass === 'sparse' ? BASS_SPARSE.indexOf(eighth) >= 0 : true;
      const note = phrase.bass[bar][eighth];
      if (plays && note) _bassVoice(HZ[note], at, sixteenth * (lay.bass === 'sparse' ? 3.2 : 1.7), L.bass);
    }
    if (lay.guitar === 'stab' && STAB.indexOf(s) >= 0) {
      _guitarVoice(HZ[phrase.chord[bar]], at, sixteenth * 3.4, L.stab, lay.shine);
    }
    if (lay.guitar === 'chug' && CHUG.indexOf(s) >= 0) {
      _guitarVoice(HZ[phrase.chord[bar]], at, sixteenth * 0.85, L.chug, false);
    }
    if (lay.guitar === 'hold' && HOLD.indexOf(s) >= 0) {
      _guitarVoice(HZ[phrase.chord[bar]], at, sixteenth * 2.6, L.chug * 0.8, false);
    }
    if (lay.hook && HOOK[bar]) {
      for (const [step16, note, len] of HOOK[bar]) {
        if (step16 === s) _note(HZ[note], 0, sixteenth * len * 0.92, 'square', L.hook, null, _mBus, at);
      }
    }
    if (lay.chant && s === 0 && CHANT.indexOf(bar) >= 0) {
      _noise(0, 0.42, 600, L.chant, 'bandpass', 1700, _mBus, at);
      _note(115, 0, 0.28, 'sawtooth', L.chant * 0.45, 92, _mBus, at);
    }
    if (lay.drone && s === 0) {
      _droneVoice(HZ[phrase.chord[bar]], at, beat * 4, L.drone);
    }
  }

  /**
   * Queue everything due inside the lookahead window, then sleep.
   *
   * The timer reschedules even while the context is suspended, so the loop
   * picks itself back up when a tablet wakes and resume() runs.
   */
  function _tick() {
    _mTimer = setTimeout(_tick, CONFIG.music.tickMs);
    if (!ctx || !_mOn || ctx.state !== 'running') return;
    /* A stalled timer must not try to play back the minute it missed. */
    if (_mNext < ctx.currentTime - 0.5) {
      _mNext = ctx.currentTime + 0.06;
      _mStep = 0;                        /* restart on a phrase line, not mid bar */
    }
    const ahead = CONFIG.music.lookaheadMs / 1000;
    while (_mNext < ctx.currentTime + ahead) {
      _emit(_mStep, _mNext);
      _mNext += _stepDur();
      _mStep = (_mStep + 1) % PHRASE_STEPS;
    }
  }

  /** Start the scheduler if it is wanted, unlocked and not muted. */
  function _mStart() {
    if (!ctx || _mOn || muted || !_mWanted) return;
    _mGraph();
    _mOn = true;
    _mNext = ctx.currentTime + 0.08;
    _mStep = 0;
    if (!_mState) _mState = arrange(null, {}, 0);
    if (ctx.state === 'suspended') ctx.resume();
    _tick();
  }

  /** Stop the scheduler and drop the timer. Queued notes ring out. */
  function _mStop() {
    _mOn = false;
    if (_mTimer) { clearTimeout(_mTimer); _mTimer = null; }
  }

  /** Play the anthem. Remembered, so unmuting later brings it back. */
  function startMusic() {
    _mWanted = true;
    _mStart();
  }

  /** Silence the anthem and forget that it was wanted. */
  function stopMusic() {
    _mWanted = false;
    _mStop();
    _mState = null;
  }

  /**
   * Tell the music where the match is. Called once a frame; cheap enough to
   * be, because the only work is the arrangement rule and, on the rare frame
   * the duck changes, one gain ramp.
   *
   * @param {object} input - {carrierTeam: 0|1|null, phase: string, score: number[]}
   * @param {number} dt - seconds since the last frame
   */
  function updateMusic(input, dt) {
    if (!_mWanted) return;
    const was = _mState;
    _mState = arrange(was, input, dt);
    if (_mBus && (!was || was.duck !== _mState.duck)) {
      const m = CONFIG.music;
      const to = _mState.duck ? m.duckGain : m.gain;
      _mBus.gain.cancelScheduledValues(ctx.currentTime);
      _mBus.gain.setValueAtTime(_mBus.gain.value, ctx.currentTime);
      _mBus.gain.linearRampToValueAtTime(to, ctx.currentTime + m.duckMs / 1000);
    }
  }

  return {
    unlock, resume, play, isMuted, setMuted,
    startMusic, stopMusic, updateMusic, arrange,
  };
})();

/* Node can require this file for the logic tests; browsers ignore the guard. */
if (typeof module !== 'undefined' && module.exports) module.exports = Audio;
