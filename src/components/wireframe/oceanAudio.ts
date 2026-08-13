/**
 * Cheerful, soothing chip-synth island score.
 * Generated on device from C-major diatonic harmony.
 * No sample loop. No noise bed. No filter sweep.
 *
 * Theory:
 *   Ionian (C major). Progressions I–IV–V–IV, I–V–vi–IV, I–vi–IV–V.
 *   Bass: root / fifth. Arp: chord tones only.
 *   Lead: chord tones on strong beats, stepwise passing tones on weak.
 */

const LOOKAHEAD = 0.14;
const TICK_MS = 35;
const BPM = 100;
const EIGHTH = 60 / BPM / 2;

const TONIC = 60; // C4
const MAJOR = [0, 2, 4, 5, 7, 9, 11];

const DEGREES: Record<string, number[]> = {
  I: [0, 4, 7],
  IV: [5, 9, 12],
  V: [7, 11, 14],
  vi: [9, 12, 16],
};

const PROGRESSIONS: string[][] = [
  ["I", "IV", "I", "V"],
  ["I", "IV", "V", "IV"],
  ["I", "V", "vi", "IV"],
  ["I", "vi", "IV", "V"],
];

type Graph = {
  ctx: AudioContext;
  master: GainNode;
  tone: GainNode;
  pulseSoft: PeriodicWave;
  pulseBright: PeriodicWave;
  timer: number | null;
  next: number;
  eighth: number;
  prog: number;
  bar: number;
  lastLead: number;
  phraseLeft: number;
  question: boolean;
};

let graph: Graph | null = null;
let wantOn = false;

function midiHz(n: number): number {
  return 440 * 2 ** ((n - 69) / 12);
}

function ctxCtor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  return (
    window.AudioContext ||
    (window as Window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext ||
    null
  );
}

function makePulse(ctx: AudioContext, duty: number): PeriodicWave {
  const n = 24;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    imag[i] = (2 / (i * Math.PI)) * Math.sin(i * Math.PI * duty);
  }
  return ctx.createPeriodicWave(real, imag);
}

function play(
  ctx: AudioContext,
  dest: AudioNode,
  wave: PeriodicWave | "triangle",
  midi: number,
  when: number,
  dur: number,
  peak: number,
  attack = 0.008,
) {
  const osc = ctx.createOscillator();
  if (wave === "triangle") osc.type = "triangle";
  else osc.setPeriodicWave(wave);
  osc.frequency.setValueAtTime(midiHz(midi), when);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), when + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  osc.connect(g);
  g.connect(dest);
  osc.start(when);
  osc.stop(when + dur + 0.03);
  osc.onended = () => {
    osc.disconnect();
    g.disconnect();
  };
}

function nearest(pool: number[], from: number): number {
  let best = pool[0]!;
  let dist = 99;
  for (const n of pool) {
    const d = Math.abs(n - from);
    if (d < dist) {
      dist = d;
      best = n;
    }
  }
  return best;
}

function scalePitch(degree: number, octave: number): number {
  const o = Math.floor(degree / 7);
  const i = ((degree % 7) + 7) % 7;
  return TONIC + octave * 12 + MAJOR[i]! + o * 12;
}

function chordTones(name: string, octave: number): number[] {
  return DEGREES[name]!.map((s) => TONIC + octave * 12 + s);
}

function currentChord(g: Graph): string {
  return PROGRESSIONS[g.prog]![g.bar % 4]!;
}

function pickLead(g: Graph, strong: boolean, resolve: boolean): number {
  const name = currentChord(g);
  const tones = [...chordTones(name, 1), ...chordTones(name, 2).slice(0, 2)];
  if (resolve) {
    const home = g.question
      ? [TONIC + 19, TONIC + 14] // G / D — half cadence
      : [TONIC + 24, TONIC + 16, TONIC + 12]; // C / E / C — authentic
    return nearest(home, g.lastLead);
  }
  if (strong) {
    const options = tones.filter((n) => Math.abs(n - g.lastLead) <= 7);
    const pool = options.length ? options : tones;
    return pool[(Math.random() * pool.length) | 0]!;
  }
  const pc = (n: number) => ((n - TONIC) % 12 + 12) % 12;
  const neighbors = [g.lastLead - 2, g.lastLead - 1, g.lastLead + 1, g.lastLead + 2].filter(
    (n) => MAJOR.includes(pc(n)),
  );
  if (neighbors.length === 0) return nearest(tones, g.lastLead);
  return neighbors[(Math.random() * neighbors.length) | 0]!;
}

function ensure(): Graph | null {
  const Ctor = ctxCtor();
  if (!Ctor) return null;
  if (graph) return graph;
  const ctx = new Ctor({ latencyHint: "playback" });
  const master = ctx.createGain();
  master.gain.value = 0;
  master.connect(ctx.destination);
  // Static warmth — not a swept filter
  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = 2600;
  tone.Q.value = 0.4;
  tone.connect(master);
  graph = {
    ctx,
    master,
    tone,
    pulseSoft: makePulse(ctx, 0.5),
    pulseBright: makePulse(ctx, 0.25),
    timer: null,
    next: 0,
    eighth: 0,
    prog: 0,
    bar: 0,
    lastLead: TONIC + 24,
    phraseLeft: 4,
    question: true,
  };
  return graph;
}

function advance(g: Graph) {
  const when = g.next;
  const e = g.eighth % 8;
  const name = currentChord(g);
  const tones0 = chordTones(name, 0);
  const tones1 = chordTones(name, 1);
  const root = tones0[0]!;
  const fifth = tones0[2]!;

  // Triangle bass: root on 1, fifth on 3 (first-inversion color, still tonic/dominant)
  if (e === 0) {
    play(g.ctx, g.tone, "triangle", root - 12, when, EIGHTH * 3.4, 0.18, 0.012);
  } else if (e === 4) {
    play(g.ctx, g.tone, "triangle", fifth - 12, when, EIGHTH * 2.6, 0.13, 0.012);
  }

  // Island skank — offbeats, chord tones only
  if (e === 2 || e === 6) {
    play(g.ctx, g.tone, g.pulseSoft, tones1[1]!, when, EIGHTH * 0.55, 0.045, 0.006);
    play(g.ctx, g.tone, g.pulseSoft, tones1[0]!, when + 0.01, EIGHTH * 0.5, 0.03, 0.006);
  }

  // Broken-chord arp (1–3–5–3), voice-led
  if (e % 2 === 0) {
    const pattern = [0, 1, 2, 1][(e / 2) % 4]!;
    play(g.ctx, g.tone, g.pulseSoft, tones1[pattern]!, when, EIGHTH * 1.15, 0.038, 0.01);
  }

  // Soft pad on the bar: root + third
  if (e === 0) {
    play(g.ctx, g.tone, "triangle", tones1[0]!, when, EIGHTH * 7.5, 0.035, 0.08);
    play(g.ctx, g.tone, "triangle", tones1[1]!, when + 0.02, EIGHTH * 7.5, 0.028, 0.1);
  }

  // Lead phrases
  if (g.phraseLeft <= 0) {
    if (e === 0 || e === 4) {
      g.phraseLeft = 3 + ((Math.random() * 3) | 0);
      g.question = !g.question;
    }
  } else if (e !== 1 && e !== 5) {
    const strong = e === 0 || e === 4;
    const resolve = g.phraseLeft === 1;
    const note = pickLead(g, strong, resolve);
    g.lastLead = note;
    const hold = resolve || strong ? 2.1 : 1.15;
    play(g.ctx, g.tone, g.pulseBright, note, when, EIGHTH * hold, 0.09, 0.01);
    g.phraseLeft -= 1;
  }

  if (e === 7) {
    g.bar = (g.bar + 1) % 4;
    if (g.bar === 0) {
      // Stay on I-starting vamps more often; never jump mid-phrase
      if (Math.random() < 0.4) {
        g.prog = (Math.random() * PROGRESSIONS.length) | 0;
      }
    }
  }

  g.eighth += 1;
  g.next += EIGHTH;
}

function tick() {
  const g = graph;
  if (!g || !wantOn) return;
  const horizon = g.ctx.currentTime + LOOKAHEAD;
  while (g.next < horizon) advance(g);
}

function start(g: Graph) {
  if (g.timer != null) return;
  g.next = g.ctx.currentTime + 0.06;
  g.eighth = 0;
  g.prog = 1; // I–IV–V–IV island vamp
  g.bar = 0;
  g.lastLead = TONIC + 24;
  g.phraseLeft = 5;
  g.question = true;
  tick();
  g.timer = window.setInterval(tick, TICK_MS);
}

function stop(g: Graph) {
  if (g.timer != null) {
    window.clearInterval(g.timer);
    g.timer = null;
  }
}

export function unlockOceanAudio(): void {
  const g = ensure();
  if (!g) return;
  if (g.ctx.state === "suspended") void g.ctx.resume();
}

export function setOceanMusic(on: boolean): void {
  wantOn = on;
  unlockOceanAudio();
  const g = graph;
  if (!g) return;
  if (g.ctx.state === "suspended") void g.ctx.resume();
  const now = g.ctx.currentTime;
  g.master.gain.cancelScheduledValues(now);
  g.master.gain.setTargetAtTime(on ? 0.62 : 0, now, 0.4);
  if (on) start(g);
  else stop(g);
}

export function resumeOceanAudio(): void {
  if (graph && graph.ctx.state === "suspended") void graph.ctx.resume();
}
