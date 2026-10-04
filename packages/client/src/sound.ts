import type { BlastKind } from '@crateball/sim';
import type { GameEvent } from './events';

/**
 * Code-generated sound effects (WebAudio, no files), driven by `events.ts`.
 */
export interface Sound {
  unlock(): void;
  readonly muted: boolean;
  setMuted(m: boolean): void;
  play(e: GameEvent): void;
  /** For the debug panel: audio state and how many effects played. */
  debug(): { state: string; played: number; muted: boolean };
}

export function createSound(): Sound {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let noiseBuf: AudioBuffer | null = null;
  let muted = false;
  let played = 0;

  const tone = (type: OscillatorType, f0: number, f1: number, dur: number, vol: number, at = 0) => {
    if (!ctx || !master) return;
    const t = ctx.currentTime + at;
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

  const noise = (dur: number, vol: number, filter: BiquadFilterType, freq: number, at = 0) => {
    if (!ctx || !master || !noiseBuf) return;
    const t = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
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
    whistle: (long: boolean) => {
      for (let i = 0; i < (long ? 3 : 1); i++) tone('square', 2900, 2700, long ? 0.35 : 0.25, 0.08, i * 0.45);
    },
    /** Ball into the net: a soft swish of netting, then a light crowd swell. */
    goal: () => {
      noise(0.35, 0.55, 'highpass', 3200);
      noise(0.5, 0.35, 'bandpass', 1400, 0.05);
      noise(1.4, 0.18, 'lowpass', 900, 0.15);
      tone('triangle', 784, 784, 0.18, 0.12, 0.25);
      tone('triangle', 1047, 1047, 0.3, 0.12, 0.38);
    },
    shot: () => {
      noise(0.09, 0.7, 'highpass', 1100);
      tone('square', 950, 110, 0.09, 0.22);
    },
    hit: (killed: boolean) => {
      tone('sawtooth', 240, 60, 0.16, 0.45);
      noise(0.08, 0.4, 'bandpass', 700);
      if (killed) tone('sine', 300, 40, 0.5, 0.6, 0.08);
    },
    item: (kind: BlastKind) => {
      switch (kind) {
        case 'mine':
          noise(0.8, 1, 'lowpass', 700);
          tone('sine', 130, 28, 0.6, 1);
          noise(0.25, 0.5, 'highpass', 1500);
          break;
        case 'ice':
          // Crack + glassy shimmer.
          noise(0.12, 0.6, 'highpass', 4000);
          [1500, 1900, 2400, 3000].forEach((f, i) => tone('sine', f, f * 1.15, 0.35, 0.22, i * 0.04));
          break;
        case 'gun':
          noise(0.05, 0.6, 'bandpass', 3000);
          noise(0.05, 0.6, 'bandpass', 2000, 0.08);
          tone('square', 220, 180, 0.06, 0.15, 0.08);
          break;
        case 'warp':
          // Rising whoosh.
          tone('sine', 300, 1400, 0.22, 0.35);
          noise(0.18, 0.3, 'bandpass', 2500);
          break;
        default:
          [440, 554, 659, 880].forEach((f, i) => tone('triangle', f, f, 0.12, 0.25, i * 0.05));
      }
    },
  };

  return {
    get muted() {
      return muted;
    },
    setMuted(m) {
      muted = m;
      if (master) master.gain.value = m ? 0 : 0.5;
    },
    unlock() {
      if (ctx) {
        void ctx.resume();
        return;
      }
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.5;
      master.connect(ctx.destination);
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    },
    debug() {
      return { state: ctx?.state ?? 'not created', played, muted };
    },
    play(e) {
      played++;
      // A context can be created or left suspended (tab switch, OS audio route change): retry.
      if (ctx && ctx.state !== 'running') void ctx.resume();
      switch (e.type) {
        case 'kick':
          sfx.kick(e.power);
          break;
        case 'shot':
          sfx.shot();
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
      }
    },
  };
}
