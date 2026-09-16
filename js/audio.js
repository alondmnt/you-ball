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

    /**
     * A goal. Two motifs, both quoted straight out of the music, so whichever
     * one you hear it belongs to the same song - the old fanfare was a C major
     * arpeggio, which shared nothing with an E minor anthem but the tuning.
     *
     * Home carries the hook's own B-D-E on up past where the hook stops, and
     * lands on the octave with the crowd behind it. Away walks the Phrygian
     * line the away theme is built on, Am G F Em, and settles on F against E -
     * the whole away idea in two notes. It is the same music either way; one
     * goes up and one comes down.
     *
     * These play into the master bus, not the music bus, because the music is
     * ducked for exactly this moment.
     *
     * @param {string} [side] - 'home' or 'away'; home if omitted
     */
    goal(side) {
      if (side === 'away') {
        ['A3', 'G3', 'F3', 'E3'].forEach((n, i) => {
          _note(HZ[n], i * 0.14, 0.32, 'sawtooth', 0.10);
          _note(HZ[n] / 2, i * 0.14, 0.36, 'sine', 0.085);
        });
        _note(HZ.F3, 0.58, 1.0, 'sawtooth', 0.095);
        _note(HZ.E3, 0.58, 1.0, 'sawtooth', 0.085);
        _note(HZ.E2, 0.58, 1.1, 'sine', 0.10);
        /* A groan rather than a cheer: the same noise swept down, not up. */
        _noise(0, 1.5, 900, 0.11, 'bandpass', 300);
        return;
      }
      ['B3', 'D4', 'E4', 'G4', 'B4'].forEach((n, i) => {
        _note(HZ[n], i * 0.075, 0.26, 'square', 0.095);
        _note(HZ[n] * 2, i * 0.075, 0.18, 'sine', 0.03);
      });
      _note(HZ.E5, 0.375, 0.75, 'square', 0.11);
      _note(HZ.E4, 0.375, 0.8, 'sawtooth', 0.07);
      _note(HZ.E2, 0.375, 0.9, 'sine', 0.10);
      effects.crowd();
    },

    /** Crowd swell - noise swept up through a bandpass, like a stand standing. */
    crowd() {
      _noise(0, 1.6, 420, 0.13, 'bandpass', 1500);
      _noise(0.12, 1.3, 900, 0.07, 'bandpass', 2000);
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
   * The anthem: an eight bar rock loop, synthesised note by note, that follows
   * the ball.
   *
   * Nothing is sampled and nothing is quoted. The debt to the terrace rock
   * this game is dressed after is its *shape* - a near silent verse, a loud
   * chorus, and a hook that is a rhythm rather than a tune - not any
   * particular song's notes. The riff below is ours.
   *
   * Two keys share one grid, one tempo and one key centre, and each has two
   * sixteen bar parts that alternate. At this tempo a four bar loop would come
   * round twelve times in one match; this comes round once.
   *
   *   home  bright, and it climbs      - Em Em C D, then up to the four
   *   away  the flat second, all menace - Em Em F F, then Am G F Em down onto it
   *
   * and three textures play over whichever is running:
   *
   *   home   full kit, power chord stabs, the hook, the melody, a crowd chant
   *   away   half time drums, a chugging guitar, a drone, and no tune at all
   *   loose  the same riff with most of it taken out. This is the verse, and
   *          it is what makes the chorus land.
   *
   * Within a part the top line hands over once: riff and hook answers for the
   * first sentence, then the melody enters at bar nine and owns part B. The
   * riff stays square underneath, so the two are counterweights.
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
  const BARS = 16;                    /* one part: four four-bar phrases with an arc */
  const PHRASE_STEPS = STEPS_PER_BAR * BARS;

  /*
   * One bar of bass is eight eighth notes; null is a rest. The wiggle at the
   * end of each bar is what stops a root note pulse from becoming wallpaper.
   */
  /*
   * Two keys, two parts each. A part is sixteen bars - four four-bar phrases
   * with an arc through them - and the form alternates the parts, so nothing
   * comes round again inside half a minute.
   *
   * Each part carries a `cell`: which sixteenths of a bar the riff lands on.
   * This is the thing that makes it a riff rather than a chord progression
   * with a pedal under it. The bass and the guitar both play the cell, which
   * is what a band locking onto a figure sounds like, while the drums hold a
   * straight pulse so the syncopation has something to push against.
   *
   *   home  [0 2 4 6 | 8 10 12 14]  driving eighths, accented on one and three
   *   away  [0 4 6 8 | 12 14]       one, two-and, three, four-and: heavier,
   *                                 and it breathes where home does not
   *
   * Both are square on the beat and symmetrical across the half bar. An
   * earlier version put hits on the "a" of one and three, which read as
   * unpredictable rather than syncopated: with a melody over the top, the
   * riff's job is to be the floor, not to compete.
   *
   * `turn` replaces the cell on the last bar of each four-bar phrase, so the
   * joints are audible. `bass` lists one pitch per cell hit, so a bar has as
   * many notes as the cell has holes left over.
   *
   * The guitar plays root and fifth with no third in it, so the chord roots
   * are modeless. The mode comes from the bass line and from the notes the
   * hook picks out, which is why home and away can share roots and still
   * sound nothing like each other. Both keys carry a melody, so a tackle
   * changes the tune rather than taking it away.
   */
  const PHRASE = {
    home: {
      /* The anthem. Em Em C D, said again with a different landing, lifted to
         the four, then walked home. */
      a: {
        cell: [0, 2, 4, 6, 8, 10, 12, 14],
        turn: [0, 2, 4, 6, 8, 12, 14, 15],
        chord: ['E3', 'E3', 'C4', 'D4', 'E3', 'E3', 'C4', 'G3',
                'A3', 'A3', 'C4', 'D4', 'E3', 'E3', 'D4', 'E3'],
        bass: [
          ['E2', 'E2', 'E2', 'E2', 'E2', 'E2', 'G2', 'E2'],
          ['E2', 'E2', 'E2', 'E2', 'E2', 'G2', 'A2', 'B2'],
          ['C3', 'C3', 'C3', 'C3', 'C3', 'C3', 'B2', 'C3'],
          ['D3', 'D3', 'D3', 'D3', 'D3', 'C3', 'B2', 'A2'],
          ['E2', 'E2', 'E2', 'E2', 'E2', 'E2', 'G2', 'E2'],
          ['E2', 'E2', 'E2', 'E2', 'E2', 'G2', 'A2', 'B2'],
          ['C3', 'C3', 'C3', 'C3', 'C3', 'C3', 'D3', 'C3'],
          ['G2', 'G2', 'G2', 'G2', 'G2', 'A2', 'B2', 'C3'],
          ['A2', 'A2', 'A2', 'A2', 'A2', 'A2', 'G2', 'A2'],
          ['A2', 'A2', 'A2', 'A2', 'A2', 'C3', 'B2', 'A2'],
          ['C3', 'C3', 'C3', 'C3', 'C3', 'C3', 'B2', 'C3'],
          ['D3', 'D3', 'D3', 'D3', 'D3', 'C3', 'B2', 'A2'],
          ['E2', 'E2', 'E2', 'E2', 'E2', 'E2', 'G2', 'E2'],
          ['E2', 'E2', 'E2', 'E2', 'E2', 'G2', 'A2', 'B2'],
          ['D3', 'D3', 'D3', 'D3', 'D3', 'D3', 'C3', 'D3'],
          ['E2', 'E2', 'E2', 'G2', 'A2', 'B2', 'D3', 'B2'],
        ],
      },
      /* The other half of the song: it sits up on the four and finishes on
         two bars of D that can only resolve one way. */
      b: {
        cell: [0, 2, 4, 6, 8, 10, 12, 14],
        turn: [0, 2, 4, 6, 8, 12, 14, 15],
        chord: ['A3', 'A3', 'E3', 'E3', 'C4', 'C4', 'D4', 'D4',
                'A3', 'A3', 'E3', 'G3', 'C4', 'C4', 'D4', 'D4'],
        bass: [
          ['A2', 'A2', 'A2', 'A2', 'A2', 'A2', 'G2', 'A2'],
          ['A2', 'A2', 'A2', 'A2', 'A2', 'C3', 'B2', 'A2'],
          ['E2', 'E2', 'E2', 'E2', 'E2', 'E2', 'G2', 'E2'],
          ['E2', 'E2', 'E2', 'E2', 'E2', 'G2', 'A2', 'B2'],
          ['C3', 'C3', 'C3', 'C3', 'C3', 'C3', 'B2', 'C3'],
          ['C3', 'C3', 'C3', 'C3', 'C3', 'D3', 'C3', 'B2'],
          ['D3', 'D3', 'D3', 'D3', 'D3', 'D3', 'C3', 'D3'],
          ['D3', 'D3', 'D3', 'D3', 'D3', 'C3', 'B2', 'A2'],
          ['A2', 'A2', 'A2', 'A2', 'A2', 'A2', 'G2', 'A2'],
          ['A2', 'A2', 'A2', 'A2', 'A2', 'C3', 'B2', 'A2'],
          ['E2', 'E2', 'E2', 'E2', 'E2', 'E2', 'G2', 'E2'],
          ['G2', 'G2', 'G2', 'G2', 'G2', 'A2', 'B2', 'C3'],
          ['C3', 'C3', 'C3', 'C3', 'C3', 'C3', 'B2', 'C3'],
          ['C3', 'C3', 'C3', 'C3', 'C3', 'D3', 'C3', 'B2'],
          ['D3', 'D3', 'D3', 'D3', 'D3', 'D3', 'C3', 'D3'],
          ['D3', 'D3', 'D3', 'D3', 'D3', 'C3', 'B2', 'D3'],
        ],
      },
    },
    away: {
      /* The flat second vamps, then Am G F Em walks down onto it. The third
         phrase alternates E and F bar by bar rather than repeating the first,
         which is tighter and leaves nothing to settle into. */
      a: {
        cell: [0, 4, 6, 8, 12, 14],
        turn: [0, 4, 6, 8, 12, 15],
        chord: ['E3', 'E3', 'F3', 'F3', 'A3', 'G3', 'F3', 'E3',
                'E3', 'F3', 'E3', 'F3', 'C4', 'D4', 'F3', 'E3'],
        bass: [
          ['E2', 'E2', 'E2', 'E2', 'E2', 'F2'],
          ['E2', 'E2', 'E2', 'E2', 'F2', 'E2'],
          ['F2', 'F2', 'F2', 'F2', 'F2', 'E2'],
          ['F2', 'F2', 'F2', 'E2', 'F2', 'G2'],
          ['A2', 'A2', 'A2', 'A2', 'A2', 'G2'],
          ['G2', 'G2', 'G2', 'G2', 'G2', 'F2'],
          ['F2', 'F2', 'F2', 'F2', 'F2', 'E2'],
          ['E2', 'E2', 'E2', 'E2', 'F2', 'E2'],
          ['E2', 'E2', 'E2', 'E2', 'E2', 'F2'],
          ['F2', 'F2', 'F2', 'F2', 'E2', 'F2'],
          ['E2', 'E2', 'E2', 'E2', 'E2', 'F2'],
          ['F2', 'F2', 'F2', 'E2', 'F2', 'G2'],
          ['C3', 'C3', 'C3', 'C3', 'C3', 'B2'],
          ['D3', 'D3', 'D3', 'D3', 'C3', 'B2'],
          ['F2', 'F2', 'F2', 'F2', 'F2', 'E2'],
          ['E2', 'E2', 'E2', 'E2', 'F2', 'E2'],
        ],
      },
      /* Away's other half climbs away from the root instead of hanging on it,
         so the return to that F against E lands harder. */
      b: {
        cell: [0, 4, 6, 8, 12, 14],
        turn: [0, 4, 6, 8, 12, 15],
        chord: ['C4', 'C4', 'D4', 'D4', 'A3', 'A3', 'F3', 'F3',
                'C4', 'C4', 'D4', 'D4', 'A3', 'G3', 'F3', 'E3'],
        bass: [
          ['C3', 'C3', 'C3', 'C3', 'C3', 'B2'],
          ['C3', 'C3', 'C3', 'C3', 'D3', 'C3'],
          ['D3', 'D3', 'D3', 'D3', 'D3', 'C3'],
          ['D3', 'D3', 'D3', 'C3', 'B2', 'A2'],
          ['A2', 'A2', 'A2', 'A2', 'A2', 'G2'],
          ['A2', 'A2', 'A2', 'A2', 'G2', 'A2'],
          ['F2', 'F2', 'F2', 'F2', 'F2', 'E2'],
          ['F2', 'F2', 'F2', 'E2', 'F2', 'G2'],
          ['C3', 'C3', 'C3', 'C3', 'C3', 'B2'],
          ['C3', 'C3', 'C3', 'C3', 'D3', 'C3'],
          ['D3', 'D3', 'D3', 'D3', 'D3', 'C3'],
          ['D3', 'D3', 'D3', 'C3', 'B2', 'A2'],
          ['A2', 'A2', 'A2', 'A2', 'A2', 'G2'],
          ['G2', 'G2', 'G2', 'G2', 'G2', 'F2'],
          ['F2', 'F2', 'F2', 'F2', 'F2', 'E2'],
          ['E2', 'E2', 'E2', 'E2', 'F2', 'E2'],
        ],
      },
    },
  };

  /*
   * The song form: which part each pass of the phrase plays. Two sixteen bar
   * parts alternating means nothing repeats exactly inside 58 seconds, which
   * is most of a match.
   */
  const FORM = ['a', 'b'];

  /*
   * The verse plays the same riff with most of it taken out - every fourth hit
   * of the cell - which is why it can drop in over either part without a join.
   */
  const VERSE_EVERY = 4;

  /*
   * The hook answers at the end of every other bar, never on top of the riff:
   * a lead that runs the whole way wears out inside one match, and the empty
   * bars are what make it a hook. Over eight bars it has its own arc - call,
   * answer, a higher lift, then back down.
   * [step within the bar, note, length in sixteenths]
   */
  /*
   * The hook answers the riff at the end of the first sentence's phrases, and
   * then gets out of the way: from bar nine the melody has the top.
   * [step within the bar, note, length in sixteenths]
   */
  const HOOK = {
    a: {
      3: [[8, 'B3', 2], [10, 'D4', 2], [12, 'E4', 4]],
      7: [[8, 'D4', 4], [12, 'B3', 2], [14, 'A3', 2]],
    },
    b: {},
  };

  /*
   * The melody. Song 2 has no tune in it, which is fine over three minutes and
   * thin under a whole match, so this departs from the reference deliberately.
   *
   * It does not run the whole way. Part A's first sentence is riff and hook
   * only, which is what gives the melody somewhere to arrive; it enters at bar
   * nine and then owns all of part B. Under it the riff stays square, so the
   * two are counterweights rather than competitors.
   *
   * Pentatonic (E G A B D) with the C from the chords, inside an octave and a
   * bit, and built on one repeated figure rather than a walk through the
   * scale - see the tables. Away has no melody at all, the same way it has no
   * hook: your team gets a tune, theirs gets a riff and a drone.
   */
  const MELODY = {
    home: {
      /*
       * One figure, stated four times. Two short notes into a long one -
       * "da-da-DAAA" - answered each time by a fall back down. Bars 10 and 11
       * are the same shape a third higher, which is the oldest way there is of
       * making a line stick: say it, then say it again from somewhere else.
       * Over the eight bars it climbs from E4 to E5 and comes back down.
       *
       * The long notes are long enough to reach the next one, including over
       * a barline: a held note is a rest in a melody, silence is a break. An
       * earlier version let the line stop for two full beats between
       * statements, which turned one arc into a row of fragments. The only
       * gaps left are an eighth note before a statement returns, which is a
       * breath and is meant to be heard as one.
       *
       * A note may run past its own bar. Nothing downstream cares - the length
       * is just seconds by the time it reaches the voice - but the next bar
       * must not start before it ends, or the lead plays two notes at once.
       */
      a: {
        8: [[4, 'E4', 2], [6, 'G4', 2], [8, 'B4', 8]],          /* the figure */
        9: [[0, 'B4', 4], [4, 'A4', 2], [6, 'G4', 14]],         /* answers, ties over */
        10: [[4, 'G4', 2], [6, 'B4', 2], [8, 'D5', 8]],         /* again, a third up */
        11: [[0, 'D5', 4], [4, 'B4', 2], [6, 'A4', 10]],
        12: [[0, 'E5', 3], [3, 'D5', 3], [6, 'B4', 2], [8, 'A4', 8]],  /* the top */
        13: [[0, 'G4', 4], [4, 'A4', 2], [6, 'B4', 14]],        /* ties over */
        14: [[4, 'A4', 2], [6, 'G4', 2], [8, 'E4', 8]],         /* the figure, home */
        15: [[0, 'D4', 4], [4, 'E4', 14]],                      /* into part B */
      },
      /* Part B takes the same figure up an octave's worth of attitude: it
         reaches E5 in its first bar instead of building to it, which is what
         makes it the chorus rather than more verse. */
      b: {
        0: [[4, 'A4', 2], [6, 'C5', 2], [8, 'E5', 8]],
        1: [[0, 'E5', 4], [4, 'D5', 2], [6, 'C5', 14]],
        2: [[4, 'B4', 2], [6, 'D5', 2], [8, 'E5', 8]],
        3: [[0, 'E5', 4], [4, 'D5', 2], [6, 'B4', 10]],
        4: [[0, 'C5', 3], [3, 'B4', 3], [6, 'A4', 2], [8, 'G4', 8]],
        5: [[0, 'G4', 4], [4, 'A4', 2], [6, 'C5', 14]],
        6: [[4, 'D5', 2], [6, 'E5', 2], [8, 'D5', 8]],
        7: [[0, 'D5', 4], [4, 'B4', 2], [6, 'A4', 12]],         /* breath here */
        8: [[4, 'A4', 2], [6, 'C5', 2], [8, 'E5', 8]],
        9: [[0, 'E5', 4], [4, 'D5', 2], [6, 'C5', 14]],
        10: [[4, 'B4', 2], [6, 'D5', 2], [8, 'E5', 8]],
        11: [[0, 'E5', 4], [4, 'D5', 2], [6, 'B4', 10]],
        12: [[0, 'C5', 3], [3, 'B4', 3], [6, 'A4', 2], [8, 'G4', 8]],
        13: [[0, 'G4', 4], [4, 'A4', 2], [6, 'B4', 14]],
        14: [[4, 'A4', 2], [6, 'B4', 2], [8, 'D5', 8]],
        15: [[0, 'D5', 4], [4, 'B4', 2], [6, 'E4', 10]],
      },
    },
    /*
     * The away tune. Possession turns over every few seconds - that is the
     * nature of this game - and a melody that belongs to one team is therefore
     * a melody you hear about a fifth of the time, which is not enough to
     * remember anything by. So both keys carry a line, and a tackle switches
     * the tune instead of removing it. The change is the drama.
     *
     * Same figure - two short notes into a long one - so it is recognisably
     * the same song, but where home's figure climbs a major third this one
     * stays put (measured: home +4.2 semitones, away -0.3), and it leans on
     * the F natural that home never touches. That flat second against E is the
     * whole away idea, and putting it in the tune says it far louder than the
     * chords underneath ever did.
     *
     * One rule while writing it: no B over an F chord. B against F is a
     * tritone, which is a different kind of nasty from the one we want.
     */
    away: {
      a: {
        8: [[4, 'B4', 2], [6, 'A4', 2], [8, 'E4', 8]],          /* falls to the root */
        9: [[0, 'E4', 4], [4, 'F4', 2], [6, 'A4', 14]],         /* the flat second */
        10: [[4, 'A4', 2], [6, 'G4', 2], [8, 'E4', 8]],
        11: [[0, 'E4', 4], [4, 'F4', 2], [6, 'C5', 10]],
        12: [[0, 'C5', 3], [3, 'B4', 3], [6, 'A4', 2], [8, 'G4', 8]],
        13: [[0, 'A4', 4], [4, 'G4', 2], [6, 'F4', 14]],
        14: [[4, 'F4', 2], [6, 'E4', 2], [8, 'F4', 8]],         /* F against E */
        15: [[0, 'F4', 4], [4, 'E4', 14]],                      /* Phrygian cadence */
      },
      b: {
        0: [[4, 'G4', 2], [6, 'A4', 2], [8, 'C5', 8]],
        1: [[0, 'C5', 4], [4, 'B4', 2], [6, 'G4', 14]],
        2: [[4, 'A4', 2], [6, 'C5', 2], [8, 'D5', 8]],
        3: [[0, 'D5', 4], [4, 'C5', 2], [6, 'A4', 10]],
        4: [[0, 'C5', 3], [3, 'B4', 3], [6, 'A4', 2], [8, 'E4', 8]],
        5: [[0, 'E4', 4], [4, 'G4', 2], [6, 'A4', 14]],
        6: [[4, 'C5', 2], [6, 'A4', 2], [8, 'F4', 8]],
        7: [[0, 'F4', 4], [4, 'E4', 2], [6, 'F4', 12]],         /* breath */
        8: [[4, 'G4', 2], [6, 'A4', 2], [8, 'C5', 8]],
        9: [[0, 'C5', 4], [4, 'B4', 2], [6, 'G4', 14]],
        10: [[4, 'A4', 2], [6, 'C5', 2], [8, 'D5', 8]],
        11: [[0, 'D5', 4], [4, 'C5', 2], [6, 'A4', 10]],
        12: [[0, 'C5', 3], [3, 'B4', 3], [6, 'A4', 2], [8, 'G4', 8]],
        13: [[0, 'G4', 4], [4, 'A4', 2], [6, 'B4', 14]],
        14: [[4, 'A4', 2], [6, 'G4', 2], [8, 'F4', 8]],
        15: [[0, 'F4', 4], [4, 'E4', 10]],
      },
    },
  };

  /* Which sixteenths each drum pattern lands on. */
  const KICK = { drive: [0, 6, 8, 14], sparse: [0, 8], half: [0, 10] };
  const SNARE = { backbeat: [4, 12], half: [8] };
  const HAT = {
    quarters: [0, 4, 8, 12],
    eighths: [0, 2, 4, 6, 8, 10, 12, 14],
    sixteenths: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  };
  const FILL = [14, 15];             /* two extra snares into the phrase turn */
  const CHANT = [0, 8];              /* a shout on the downbeat of each half */

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
          guitar: 'stab', hook: true, melody: true, chant: true, drone: false }
      : theme === 'away'
        ? { kick: 'half', snare: 'half', hat: 'quarters', bass: 'full',
            guitar: 'chug', hook: false, melody: true, chant: false, drone: true }
        /* The verse keeps the tune. Stripping the band back is the point of
           it; stripping the voice out as well left the melody sounding for
           fifteen per cent of a match, which is not enough to remember
           anything by - and a quiet verse under a vocal is what the loud-
           quiet-loud this is modelled on actually does. */
        : { kick: 'sparse', snare: null, hat: 'eighths', bass: 'sparse',
            guitar: 'hold', hook: false, melody: true, chant: false, drone: false };

    layers.shine = diff > 0;
    if (diff < 0) layers.hat = HAT_UP[layers.hat];

    /* A goal owns the room: the motif and the fireworks land in the same two
       seconds, and the music would only fight them. It comes back up under the
       KICK OFF banner rather than at the whistle, so the return is a build
       instead of a snap. */
    const duck = phase === 'slowmo' || phase === 'goal';

    return { team, key, want, wantFor, looseFor, sinceSwing, theme, layers, duck };
  }

  /* ─── The music graph ─── */

  let _mBus = null;      /* everything musical, so it can duck in one place */
  let _dist = null;      /* one shared amp: guitars distort into it together */
  let _lead = null;      /* the lead's own amp, so it does not load theirs */
  let _mTimer = null;
  let _mOn = false;      /* the scheduler is running */
  let _mWanted = false;  /* the game wants music, even if mute says otherwise */
  let _mNext = 0;        /* context time of the next sixteenth */
  let _mStep = 0;        /* position in the phrase, 0..PHRASE_STEPS-1 */
  let _mState = null;    /* the latest arrangement from arrange() */
  let _mKey = 'home';    /* which progression is running, latched at the beat */
  let _mPart = FORM[0];  /* which part of the song, latched at the phrase line */
  let _mPass = 0;        /* how many phrases have gone by, to walk the form */
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

    /* The lead: less drive than the rhythm guitar, so it stays a singing tone
       rather than a wall, then a lowpass standing in for a speaker cabinet. */
    _lead = ctx.createWaveShaper();
    _lead.curve = _distCurve(4.5);
    _lead.oversample = '2x';
    const cab = ctx.createBiquadFilter();
    cab.type = 'lowpass';
    cab.frequency.value = 3400;
    cab.Q.value = 1.1;
    _lead.connect(cab).connect(_mBus);
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

  /**
   * The lead voice. A detuned sawtooth pair, driven into its own overdrive and
   * then rolled off like a speaker cabinet, with vibrato that fades in on any
   * note held long enough to need it.
   *
   * This started as a pair of triangles through a gentle lowpass, which was
   * too polite to be remembered: it sat inside the band instead of on top of
   * it. A tune that has to stick needs the three things a lead player does -
   * drive, sustain, and pitch that is never completely still.
   *
   * It runs through its own shaper rather than the rhythm guitar's. One amp
   * for both is what a band actually does, but the shaper sums whatever
   * reaches it, so the lead's level would bend the rhythm guitar's distortion
   * every time the melody moved.
   */
  function _leadVoice(freq, t, dur, vol) {
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, t);
    gain.gain.linearRampToValueAtTime(vol, t + 0.018);
    gain.gain.setValueAtTime(vol, t + dur * 0.78);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    gain.connect(_lead);

    const oscs = [];
    for (const det of [1, 1.0055]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq * det, t);
      osc.connect(gain);
      osc.start(t);
      osc.stop(t + dur);
      oscs.push(osc);
    }

    /* Only on held notes: vibrato on a passing eighth is a warble, not a
       lead. It fades in, the way a player leans into a note they are sitting
       on rather than shaking it from the moment it sounds. */
    if (dur > 0.3) {
      const lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      lfo.type = 'sine';
      lfo.frequency.setValueAtTime(5.5, t);
      depth.gain.setValueAtTime(0, t);
      depth.gain.linearRampToValueAtTime(freq * 0.013, t + dur * 0.6);
      lfo.connect(depth);
      for (const osc of oscs) depth.connect(osc.frequency);
      lfo.start(t);
      lfo.stop(t + dur);
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

    /* The part is the one thing that may only turn over at a phrase line: it
       is song structure, not a reaction to the game, and it runs on its own
       clock. Every part is the same length and sits on the same grid, so a
       key change mid part keeps its place in the bar. */
    if (step === 0) { _mPart = FORM[_mPass % FORM.length]; _mPass++; }

    /* Key and layers latch on the beat instead. Waiting for the bar line cost
       up to 1.8s, which reads as the music lagging the game; a chord arriving
       on beat three is ordinary in a rock arrangement. How often each is
       *allowed* to change is arrange's business, not the scheduler's. */
    if (s % 4 === 0) {
      _mKey = (_mState && _mState.key === 1) ? 'away' : 'home';
      _mLayers = (_mState && _mState.layers) || null;
    }
    const lay = _mLayers;
    if (!lay) return;

    /* Push the offbeat sixteenths late, which is the difference between a
       band and a drum machine. */
    const at = when + ((s % 4 === 2) ? m.swing * beat : 0);
    const phrase = PHRASE[_mKey][_mPart];
    /* The last bar of every four-bar phrase turns: a different cell and a
       snare fill, so the seams are audible. */
    const turning = bar % 4 === 3;
    const cell = turning ? phrase.turn : phrase.cell;

    if (lay.kick && KICK[lay.kick].indexOf(s) >= 0) {
      _note(128, 0, 0.14, 'sine', L.kick, 44, _mBus, at);
    }
    if (lay.snare && SNARE[lay.snare].indexOf(s) >= 0) {
      _noise(0, 0.13, 1900, L.snare, 'bandpass', 900, _mBus, at);
      _note(196, 0, 0.09, 'triangle', L.snare * 0.5, 150, _mBus, at);
    }
    /* A fill into every phrase turn, so sixteen bars have joints you can hear
       rather than one pattern running for half a minute. */
    if (lay.snare && turning && FILL.indexOf(s) >= 0) {
      _noise(0, 0.09, 2200, L.snare * (s === 15 ? 1 : 0.7), 'bandpass', 1100, _mBus, at);
    }
    if (lay.hat && HAT[lay.hat].indexOf(s) >= 0) {
      /* Lean on the downbeat so a run of sixteenths still has a pulse. */
      const v = L.hat * (s % 4 === 0 ? 1 : 0.62);
      _noise(0, 0.028, 7600, v, 'highpass', 6200, _mBus, at);
    }
    /* Bass and guitar both play the cell. A band locking onto one figure is
       what a riff is; the drums keep the straight pulse underneath so the
       syncopation has something to push against. */
    const idx = cell.indexOf(s);
    if (idx >= 0) {
      const root = HZ[phrase.chord[bar]];
      const accent = idx % VERSE_EVERY === 0;      /* the hits the riff leans on */
      const verse = lay.bass === 'sparse';
      if (lay.bass && (!verse || accent)) {
        const note = phrase.bass[bar][idx];
        if (note) _bassVoice(HZ[note], at, sixteenth * (verse ? 3.2 : 1.6), L.bass);
      }
      if (lay.guitar === 'stab') {
        /* The accented hits ring, the rest are clipped - which is a guitarist
           letting one chord through and muting the others. */
        _guitarVoice(root, at, sixteenth * (accent ? 3.4 : 1.3),
                     L.stab * (accent ? 1 : 0.7), lay.shine);
      } else if (lay.guitar === 'chug') {
        _guitarVoice(root, at, sixteenth * 0.85, L.chug, false);
      } else if (lay.guitar === 'hold' && accent) {
        _guitarVoice(root, at, sixteenth * 2.6, L.chug * 0.8, false);
      }
    }
    const hook = HOOK[_mPart][bar];
    if (lay.hook && hook) {
      for (const [step16, note, len] of hook) {
        if (step16 === s) _note(HZ[note], 0, sixteenth * len * 0.92, 'square', L.hook, null, _mBus, at);
      }
    }
    /* The melody belongs to the home key as well as the home texture: with the
       key on away there is no line written for those chords, so it rests. */
    const tune = lay.melody && MELODY[_mKey] && MELODY[_mKey][_mPart];
    if (tune && tune[bar]) {
      for (const [step16, note, len] of tune[bar]) {
        if (step16 === s) _leadVoice(HZ[note], at, sixteenth * len * 0.95, L.melody);
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
    _mPass = 0;
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
