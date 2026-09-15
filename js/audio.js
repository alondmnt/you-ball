/**
 * Audio - Web Audio synthesis. Every sound is generated; there are no files to
 * load, so nothing delays the first kick.
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
  }

  /** Resume a context suspended by a sleep or a tab switch. */
  function resume() {
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }

  function isMuted() { return muted; }
  function setMuted(on) { muted = !!on; }

  /**
   * One note with a click-free envelope.
   * @param {number} freq - Hz
   * @param {number} start - delay from now, seconds
   * @param {number} dur - seconds
   * @param {string} type - oscillator type
   * @param {number} vol - peak gain
   * @param {number} [endFreq] - glide to this frequency over the note
   */
  function _note(freq, start, dur, type, vol, endFreq) {
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime + start;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(Math.max(1, endFreq), t + dur);
    gain.gain.setValueAtTime(0.001, t);
    gain.gain.linearRampToValueAtTime(vol || 0.12, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain).connect(master);
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
   */
  function _noise(start, dur, freq, vol, filterType, endFreq) {
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime + start;
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
    src.connect(filter).connect(gain).connect(master);
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

  return { unlock, resume, play, isMuted, setMuted };
})();
