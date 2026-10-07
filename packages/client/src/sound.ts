import type { ArenaKind, BlastKind } from '@crateball/sim';
import type { GameEvent } from './events';

/**
 * Code-generated sound effects (WebAudio, no files), driven by `events.ts`.
 */
export interface Sound {
  unlock(): void;
  readonly muted: boolean;
  setMuted(m: boolean): void;
  play(e: GameEvent): void;
  /** Background bed for the arena (rain, volcano rumble, wind); null = silence. */
  setAmbient(kind: ArenaKind | null): void;
  /** For the debug panel: audio state and how many effects played. */
  debug(): { state: string; played: number; muted: boolean };
}

/** Rendering into a given context instead of the speakers (the trailer renders audio offline): effects
 * start at `now()` on that context's timeline and go to `out`. */
export interface SoundTarget {
  ctx: BaseAudioContext;
  out: AudioNode;
  now: () => number;
}

/** Shield break: glass shard pitches (Hz) and start times (s), unrelated and unevenly spaced. */
const BLOCK_SHARDS: ReadonlyArray<readonly [number, number]> = [
  [7200, 0.02],
  [5100, 0.045],
  [8400, 0.06],
  [6100, 0.095],
  [4600, 0.12],
  [7700, 0.155],
];

export function createSound(target?: SoundTarget): Sound {
  let ctx: BaseAudioContext | null = null;
  let master: GainNode | null = null;
  let noiseBuf: AudioBuffer | null = null;
  let muted = false;
  let played = 0;
  const now = () => (target ? target.now() : (ctx?.currentTime ?? 0));
  const open = (c: BaseAudioContext, out: AudioNode) => {
    ctx = c;
    master = c.createGain();
    master.gain.value = muted ? 0 : 0.5;
    master.connect(out);
    noiseBuf = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  };
  if (target) open(target.ctx, target.out);

  const tone = (type: OscillatorType, f0: number, f1: number, dur: number, vol: number, at = 0) => {
    if (!ctx || !master) return;
    const t = now() + at;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + dur + 0.02);
  };

  /** `q` 1 is the BiquadFilter default; a high one makes a narrow band (glassy shards). */
  const noise = (dur: number, vol: number, filter: BiquadFilterType, freq: number, at = 0, q = 1) => {
    if (!ctx || !master || !noiseBuf) return;
    const t = now() + at;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(master);
    src.start(t);
    src.stop(t + dur + 0.02);
  };

  /** A pea whistle: a sine with a fast flutter (the pea), a soft 12 ms attack and a 40 ms release. */
  const trill = (f: number, dur: number, vol: number, at = 0) => {
    if (!ctx || !master) return;
    const t = now() + at;
    const o = ctx.createOscillator();
    o.frequency.value = f;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 34;
    const fm = ctx.createGain();
    fm.gain.value = f * 0.035;
    lfo.connect(fm).connect(o.frequency);
    const trem = ctx.createGain();
    trem.gain.value = 0.75;
    const am = ctx.createGain();
    am.gain.value = 0.25;
    lfo.connect(am).connect(trem.gain);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.setValueAtTime(vol, t + Math.max(0.013, dur - 0.04));
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(trem).connect(g).connect(master);
    o.start(t);
    lfo.start(t);
    o.stop(t + dur + 0.02);
    lfo.stop(t + dur + 0.02);
  };

  /** Noise through a band-pass whose centre glides f0 → f1: zips and whooshes. 10 ms attack. */
  const sweep = (dur: number, vol: number, f0: number, f1: number, at = 0, q = 2) => {
    if (!ctx || !master || !noiseBuf) return;
    const t = now() + at;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(master);
    src.start(t);
    src.stop(t + dur + 0.02);
  };

  const sfx = {
    kick: (power: boolean) => {
      tone('sine', power ? 140 : 190, 45, power ? 0.2 : 0.12, power ? 1 : 0.7);
      noise(0.04, 0.3, 'highpass', 2000);
    },
    /** Referee's pea whistle: sine + 34 Hz flutter + breath. Long = peep, peep, peeeep. */
    whistle: (long: boolean) => {
      const blasts: Array<[number, number]> = long
        ? [
            [0, 0.17],
            [0.26, 0.17],
            [0.52, 0.5],
          ]
        : [[0, 0.3]];
      for (const [at, dur] of blasts) {
        trill(2750, dur, 0.2, at);
        noise(dur, 0.06, 'bandpass', 2750, at, 4);
      }
    },
    /** Ball into the net: a soft swish of netting, then a light crowd swell. */
    goal: () => {
      noise(0.35, 0.55, 'highpass', 3200);
      noise(0.5, 0.35, 'bandpass', 1400, 0.05);
      noise(1.4, 0.18, 'lowpass', 900, 0.15);
      tone('triangle', 784, 784, 0.18, 0.12, 0.25);
      tone('triangle', 1047, 1047, 0.3, 0.12, 0.38);
    },
    shot: (rocket = false) => {
      if (rocket) {
        // Launch thump, then a hissing whoosh.
        tone('sine', 140, 50, 0.25, 0.7);
        noise(0.7, 0.4, 'bandpass', 1800);
        return;
      }
      // A dry crack, a short low body, a 45 ms snap (not a laser "pew"), a little air after.
      noise(0.035, 1.8, 'bandpass', 2600, 0, 0.9);
      noise(0.09, 0.9, 'lowpass', 1100);
      tone('triangle', 520, 140, 0.045, 0.3);
      noise(0.12, 0.12, 'highpass', 4500, 0.02);
    },
    hit: (killed: boolean) => {
      tone('sawtooth', 240, 60, 0.16, 0.45);
      noise(0.08, 0.4, 'bandpass', 700);
      if (killed) tone('sine', 300, 40, 0.5, 0.6, 0.08);
    },
    item: (kind: BlastKind) => {
      switch (kind) {
        case 'mine':
        case 'erupt':
        case 'rocket':
          noise(0.8, 1, 'lowpass', 700);
          tone('sine', 130, 28, 0.6, 1);
          noise(0.25, 0.5, 'highpass', 1500);
          break;
        case 'ice':
          // Freezing over: a sharp crack and a low thud, ice crackling as it spreads, then a frosty hiss.
          // All noise, no pitched tones (pitched ones read as bells).
          noise(0.05, 0.8, 'highpass', 2500);
          tone('triangle', 180, 70, 0.12, 0.4);
          for (let i = 0; i < 6; i++)
            noise(0.025, 0.35 - i * 0.04, 'bandpass', 3000 + i * 700, 0.04 + i * 0.035);
          noise(0.45, 0.16, 'highpass', 6500, 0.05);
          break;
        case 'gun':
          noise(0.05, 0.6, 'bandpass', 3000);
          noise(0.05, 0.6, 'bandpass', 2000, 0.08);
          tone('square', 220, 180, 0.06, 0.15, 0.08);
          break;
        case 'save':
          // A gloved thud, then a short bright "got it".
          noise(0.06, 0.7, 'lowpass', 600);
          tone('triangle', 660, 880, 0.12, 0.3, 0.04);
          break;
        case 'block':
          // The shield pops and shatters: pop, crack, glass shards at uneven pitches and gaps (no ring).
          noise(0.03, 0.32, 'highpass', 3000);
          tone('triangle', 640, 170, 0.07, 0.32);
          for (const [i, [f, at]] of BLOCK_SHARDS.entries())
            noise(0.04, 0.5 - i * 0.06, 'bandpass', f, at, 10);
          break;
        case 'dizzy':
          // A woozy, wobbling slide down, then a hiccup.
          [520, 440, 360].forEach((f, i) => tone('sine', f, f * 0.82, 0.22, 0.28, i * 0.14));
          tone('triangle', 900, 1300, 0.07, 0.2, 0.5);
          break;
        case 'bazooka':
          // Heavy metal clunk.
          tone('square', 160, 120, 0.12, 0.3);
          noise(0.08, 0.5, 'bandpass', 900, 0.1);
          break;
        case 'warp':
          // Rising whoosh.
          tone('sine', 300, 1400, 0.22, 0.35);
          noise(0.18, 0.3, 'bandpass', 2500);
          break;
        // Each pickup has its own signature, so you hear which one you got.
        case 'boost':
          // Two quick upward zips.
          sweep(0.12, 2.4, 700, 4200, 0, 3);
          sweep(0.15, 2.0, 900, 5600, 0.08, 3);
          break;
        case 'shield':
          // A soft rising "vwom" with a shimmer on top.
          tone('sine', 170, 320, 0.3, 0.24);
          sweep(0.28, 0.6, 1800, 3600, 0.02, 4);
          break;
        case 'power':
          // A short charge-up, then a solid "loaded" thump.
          tone('triangle', 200, 620, 0.16, 0.22);
          tone('sine', 130, 55, 0.12, 0.3, 0.16);
          noise(0.05, 0.4, 'lowpass', 600, 0.16);
          break;
        case 'teleport':
          // Falling glides and a falling shimmer (the warp itself rises, so the two stay apart).
          tone('sine', 1500, 520, 0.16, 0.28);
          tone('sine', 1900, 700, 0.1, 0.14, 0.07);
          sweep(0.2, 0.4, 6000, 1400, 0, 4);
          break;
      }
    },
  };

  // Arena ambience: one looping, filtered noise bed per arena, cross-faded on change.
  let ambientKind: ArenaKind | null = null;
  let ambient: { src: AudioBufferSourceNode; gain: GainNode; lfo?: OscillatorNode } | null = null;
  const AMBIENT: Partial<
    Record<ArenaKind, { type: BiquadFilterType; freq: number; q: number; vol: number; lfo?: number }>
  > = {
    rain: { type: 'bandpass', freq: 1800, q: 0.4, vol: 0.12 },
    volcano: { type: 'lowpass', freq: 140, q: 0.7, vol: 0.35, lfo: 0.15 },
    wind: { type: 'bandpass', freq: 520, q: 1.2, vol: 0.14, lfo: 0.2 },
  };
  const setAmbient = (kind: ArenaKind | null) => {
    if (kind === ambientKind || !ctx || !master || !noiseBuf) return;
    ambientKind = kind;
    const t = now();
    if (ambient) {
      const old = ambient;
      old.gain.gain.setTargetAtTime(0, t, 0.4);
      old.src.stop(t + 2);
      old.lfo?.stop(t + 2);
      ambient = null;
    }
    const spec = kind ? AMBIENT[kind] : undefined;
    if (!spec) return;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = spec.type;
    f.frequency.value = spec.freq;
    f.Q.value = spec.q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.gain.setTargetAtTime(spec.vol, t, 0.6);
    src.connect(f).connect(gain).connect(master);
    let lfo: OscillatorNode | undefined;
    if (spec.lfo) {
      // Slow swell: gusts of wind, the volcano breathing.
      lfo = ctx.createOscillator();
      lfo.frequency.value = spec.lfo;
      const depth = ctx.createGain();
      depth.gain.value = spec.vol * 0.6;
      lfo.connect(depth).connect(gain.gain);
      lfo.start(t);
    }
    src.start(t);
    ambient = { src, gain, lfo };
  };

  return {
    setAmbient,
    get muted() {
      return muted;
    },
    setMuted(m) {
      muted = m;
      if (master) master.gain.value = m ? 0 : 0.5;
    },
    unlock() {
      if (ctx) {
        if (ctx instanceof AudioContext) void ctx.resume();
        return;
      }
      const live = new AudioContext();
      open(live, live.destination);
    },
    debug() {
      return { state: ctx?.state ?? 'not created', played, muted };
    },
    play(e) {
      played++;
      // A context can be created or left suspended (tab switch, OS audio route change): retry.
      if (ctx instanceof AudioContext && ctx.state !== 'running') void ctx.resume();
      switch (e.type) {
        case 'kick':
          sfx.kick(e.power);
          break;
        case 'shot':
          sfx.shot(e.rocket);
          break;
        case 'hit':
          sfx.hit(e.killed);
          break;
        case 'item':
          sfx.item(e.kind);
          break;
        case 'goal':
          sfx.goal();
          break;
        case 'whistle':
          sfx.whistle(e.long);
          break;
        case 'warn':
          // A rising rumble during the 1.5 s warning.
          tone('sawtooth', 50, 120, 1.4, 0.25);
          noise(1.4, 0.25, 'lowpass', 220);
          break;
        case 'splash':
          noise(0.18, e.mine ? 0.5 : 0.25, 'bandpass', 1100);
          noise(0.1, e.mine ? 0.3 : 0.15, 'highpass', 3500, 0.03);
          break;
        case 'sizzle':
          noise(0.35, e.mine ? 0.4 : 0.2, 'highpass', 4500);
          break;
        case 'scrape':
          noise(0.16, 0.12, 'highpass', 5000);
          break;
        case 'locked':
          // Two short high beeps: someone has you in their sights.
          tone('square', 1760, 1760, 0.06, 0.12);
          tone('square', 1760, 1760, 0.06, 0.12, 0.1);
          break;
      }
    },
  };
}
