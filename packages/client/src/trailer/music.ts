// The trailer's soundtrack, synthesised offline (no samples, nothing licensed): 128 BPM, A minor,
// Am–F–C–G. Sections follow story.ts: title hit, build, drop (loot, traps, arenas), break,
// second drop, end card.

export const BPM = 128;
export const BEAT = 60 / BPM;
export const BAR = BEAT * 4;

/** Section starts in bars. */
export const SECTION = {
  title: 0,
  build: 1,
  drop: 3,
  traps: 6,
  arenas: 9,
  brk: 13,
  drop2: 15,
  outro: 19,
  end: 22.5,
} as const;

const ROOTS = [57, 53, 48, 55]; // A3 F3 C3 G3 (MIDI), one per bar
const CHORDS = [
  [57, 60, 64],
  [57, 60, 65],
  [55, 60, 64],
  [55, 59, 62],
];
const LEAD2 = [76, 79, 81, 79, 76, 74, 72, 74, 77, 81, 79, 77, 76, 74, 71, 74]; // drop 2 answer
const LEAD = [76, 74, 72, 74, 76, 79, 76, 72, 77, 76, 72, 69, 72, 74, 71, 67]; // 16 eighths over 2 bars
const hz = (m: number) => 440 * 2 ** ((m - 69) / 12);

export function renderMusic(ctx: BaseAudioContext, dest: AudioNode): void {
  // Everything goes through a gate: half a beat of silence right before each drop makes it land.
  const out = ctx.createGain();
  out.connect(dest);
  const bus = ctx.createGain();
  bus.gain.value = 0.9;
  // Side-chain feel: the music bus ducks on every kick in the drops.
  const duck = ctx.createGain();
  bus.connect(duck).connect(out);
  const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const nd = noiseBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

  // A simple echo for the break and the final hit.
  const delay = ctx.createDelay(1);
  delay.delayTime.value = BEAT * 0.75;
  const fb = ctx.createGain();
  fb.gain.value = 0.25;
  const wet = ctx.createGain();
  wet.gain.value = 0.2;
  delay.connect(fb).connect(delay);
  delay.connect(wet).connect(out);

  const at = (bar: number, beat = 0) => bar * BAR + beat * BEAT;

  const kick = (t: number, vol = 1) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.4);
    duck.gain.setValueAtTime(1, t);
    duck.gain.linearRampToValueAtTime(0.4, t + 0.004);
    duck.gain.linearRampToValueAtTime(1, t + 0.22);
  };
  const noise = (
    t: number,
    dur: number,
    vol: number,
    type: BiquadFilterType,
    freq: number,
    dest: AudioNode = bus,
  ) => {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f).connect(g).connect(dest);
    s.start(t, Math.random());
    s.stop(t + dur + 0.05);
  };
  const clap = (t: number, vol = 0.5) => {
    for (const d of [0, 0.012, 0.024]) noise(t + d, 0.14, vol, 'bandpass', 1500);
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 190;
    g.gain.setValueAtTime(vol * 0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    o.connect(g).connect(bus);
    o.start(t);
    o.stop(t + 0.1);
  };
  const hat = (t: number, vol = 0.12, open = false) => noise(t, open ? 0.18 : 0.04, vol, 'highpass', 7000);
  const crash = (t: number, vol = 0.35) => noise(t, 1.8, vol, 'highpass', 4500);

  /** Detuned saw stack through a low-pass: chords, bass and the lead all use it. */
  const synth = (
    t: number,
    dur: number,
    notes: number[],
    o: {
      vol: number;
      cutoff: number;
      type?: OscillatorType;
      detune?: number;
      voices?: number;
      echo?: boolean;
    },
  ) => {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(o.cutoff, t);
    f.Q.value = 2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(o.vol, t + 0.01);
    g.gain.setValueAtTime(o.vol, t + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    f.connect(g).connect(bus);
    if (o.echo) g.connect(delay);
    const voices = o.voices ?? 3;
    for (const n of notes)
      for (let v = 0; v < voices; v++) {
        const osc = ctx.createOscillator();
        osc.type = o.type ?? 'sawtooth';
        osc.frequency.value = hz(n);
        osc.detune.value = voices > 1 ? (v - (voices - 1) / 2) * (o.detune ?? 14) : 0;
        osc.connect(f);
        osc.start(t);
        osc.stop(t + dur + 0.05);
      }
    return f;
  };

  // Title (bar 0): the trailer opens on one big hit, then it rings out.
  kick(at(SECTION.title), 1);
  crash(at(SECTION.title), 0.34);
  noise(at(SECTION.title), 0.9, 0.22, 'lowpass', 300);
  synth(at(SECTION.title), BAR, [45, ...CHORDS[0]!.map((n) => n + 12)], {
    vol: 0.07,
    cutoff: 2400,
    voices: 4,
    detune: 20,
    echo: true,
  });
  // Build (bars 1-2): kick on every beat, the chords opening up, then a riser and a snare roll.
  for (let b: number = SECTION.build; b < SECTION.drop; b++) {
    const f = synth(at(b), BAR, CHORDS[b % 4]!, { vol: 0.07, cutoff: 600 + b * 300, voices: 3 });
    f.frequency.linearRampToValueAtTime(900 + b * 450, at(b + 1));
    for (let i = 0; i < 8; i++) hat(at(b, i / 2), 0.08);
    for (let i = 0; i < 4; i++) kick(at(b, i), b === SECTION.drop - 1 ? 0.6 : 0.45);
    for (let i = 0; i < 4; i++)
      synth(at(b, i), BEAT * 0.5, [ROOTS[b % 4]! - 12], { vol: 0.1, cutoff: 300, voices: 1 });
  }
  // Riser: noise sweeping up through the last bar, and a snare roll speeding up.
  {
    const t = at(SECTION.drop - 1);
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    s.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 3;
    f.frequency.setValueAtTime(300, t);
    f.frequency.exponentialRampToValueAtTime(9000, t + BAR);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.02, t);
    g.gain.linearRampToValueAtTime(0.35, t + BAR);
    g.gain.linearRampToValueAtTime(0, t + BAR + 0.02);
    s.connect(f).connect(g).connect(bus);
    s.start(t);
    s.stop(t + BAR + 0.05);
    for (let i = 0; i < 16; i++) clap(at(SECTION.drop - 1, i / 4), 0.12 + i * 0.02);
  }

  // Drops: four on the floor, claps on 2 and 4, off-beat hats, pumping bass, chord stabs, lead.
  /** `dark`: the traps part: no lead, a growling detuned bass instead. */
  const drop = (from: number, to: number, lead: boolean, dark = false, melody = LEAD) => {
    for (let b = from; b < to; b++) {
      const ch = CHORDS[b % 4]!;
      const root = ROOTS[b % 4]!;
      if (b === from) crash(at(b));
      for (let i = 0; i < 4; i++) {
        kick(at(b, i));
        hat(at(b, i + 0.5), 0.14, i % 2 === 1);
        hat(at(b, i + 0.25), 0.03);
        hat(at(b, i + 0.75), 0.03);
        synth(at(b, i + 0.5), BEAT * 0.45, [root - 12], {
          vol: dark ? 0.2 : 0.16,
          cutoff: dark ? 500 : 700,
          voices: dark ? 3 : 2,
          detune: dark ? 30 : 8,
        });
      }
      clap(at(b, 1));
      clap(at(b, 3));
      for (const s of [0, 1.5, 3])
        synth(
          at(b, s),
          BEAT * 0.9,
          ch.map((n) => n + 12),
          { vol: 0.045, cutoff: 3200, voices: 3, detune: 18 },
        );
      if (lead)
        for (let i = 0; i < 8; i++) {
          const n = melody[((b - from) % 2) * 8 + i]!;
          synth(at(b, i / 2), BEAT * 0.42, [n], {
            vol: 0.05,
            cutoff: 4200,
            type: 'square',
            voices: 2,
            detune: 6,
            echo: true,
          });
        }
    }
  };
  drop(SECTION.drop, SECTION.traps, true);
  drop(SECTION.traps, SECTION.arenas, false, true);
  drop(SECTION.arenas, SECTION.brk, true);

  // Break: one hit on the cut, then pads only, a clap roll on the last beats to lead back in.
  kick(at(SECTION.brk), 0.9);
  crash(at(SECTION.brk), 0.3);
  for (let b: number = SECTION.brk; b < SECTION.drop2; b++) {
    synth(
      at(b),
      BAR,
      CHORDS[b % 4]!.map((n) => n + 12),
      { vol: 0.036, cutoff: 1400, voices: 4, detune: 22, echo: true },
    );
    synth(at(b), BAR, [ROOTS[b % 4]! - 12], { vol: 0.064, cutoff: 250, voices: 1 });
  }
  for (let i = 0; i < 8; i++) clap(at(SECTION.drop2 - 1, 2 + i / 4), 0.1 + i * 0.04);

  drop(SECTION.drop2, SECTION.drop2 + 2, true);
  drop(SECTION.drop2 + 2, SECTION.outro, true, false, LEAD2);

  // The gaps before the drops.
  for (const b of [SECTION.drop, SECTION.drop2]) {
    const t = at(b);
    out.gain.setValueAtTime(1, t - BEAT * 0.5);
    out.gain.linearRampToValueAtTime(0, t - BEAT * 0.5 + 0.01);
    out.gain.setValueAtTime(0, t - 0.002);
    out.gain.linearRampToValueAtTime(1, t);
  }

  // End card: the crate whistles down through the first beat (no silent gap after the drop), lands on
  // beat 1 (a thud), bursts open on beat 2 (the big hit), then rings out.
  {
    const t0 = at(SECTION.outro);
    const sw = ctx.createBufferSource();
    sw.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 4;
    f.frequency.setValueAtTime(6000, t0);
    f.frequency.exponentialRampToValueAtTime(200, t0 + BEAT);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.1, t0);
    g.gain.linearRampToValueAtTime(0.03, t0 + BEAT);
    sw.connect(f).connect(g).connect(bus);
    sw.start(t0);
    sw.stop(t0 + BEAT + 0.02);
  }
  kick(at(SECTION.outro), 0.9); // the cut to the end card
  crash(at(SECTION.outro), 0.25);
  const land = at(SECTION.outro, 1);
  kick(land, 0.6);
  noise(land, 0.3, 0.2, 'lowpass', 300);
  const hit = at(SECTION.outro, 2);
  kick(hit, 0.95);
  crash(hit, 0.38);
  noise(hit, 2.5, 0.2, 'lowpass', 400);
  synth(hit, BAR * 3, [45, 57, 60, 64, 69], { vol: 0.07, cutoff: 3000, voices: 4, detune: 20, echo: true });
  synth(at(SECTION.outro + 2), BAR * 1.5, [45, 52, 57], { vol: 0.06, cutoff: 900, voices: 3, detune: 14 });
}

/** 16-bit PCM WAV of an AudioBuffer. */
export function toWav(buf: AudioBuffer): ArrayBuffer {
  const ch = buf.numberOfChannels;
  const n = buf.length;
  const data = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => data.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  data.setUint32(4, 36 + n * ch * 2, true);
  str(8, 'WAVEfmt ');
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, ch, true);
  data.setUint32(24, buf.sampleRate, true);
  data.setUint32(28, buf.sampleRate * ch * 2, true);
  data.setUint16(32, ch * 2, true);
  data.setUint16(34, 16, true);
  str(36, 'data');
  data.setUint32(40, n * ch * 2, true);
  const chans = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++)
    for (const c of chans) {
      const v = Math.max(-1, Math.min(1, c[i]!));
      data.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  return data.buffer;
}

/**
 * An accent on the music for a key moment of the footage (they all land on beats): a sub drop and a
 * crash for an explosion or a goal, a bright stab for the rest. Same timeline as renderMusic.
 */
export function impact(ctx: BaseAudioContext, out: AudioNode, t: number, big: boolean): void {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.frequency.setValueAtTime(big ? 120 : 600, t);
  o.frequency.exponentialRampToValueAtTime(big ? 30 : 900, t + (big ? 0.5 : 0.12));
  g.gain.setValueAtTime(big ? 0.9 : 0.12, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + (big ? 0.6 : 0.2));
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + 0.7);
  const len = Math.ceil(ctx.sampleRate * 1.2);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** (big ? 2 : 6);
  const n = ctx.createBufferSource();
  n.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = 'highpass';
  f.frequency.value = big ? 3500 : 6000;
  const ng = ctx.createGain();
  ng.gain.value = big ? 0.3 : 0.12;
  n.connect(f).connect(ng).connect(out);
  n.start(t);
}
