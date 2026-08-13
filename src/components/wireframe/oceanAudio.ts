/**
 * On-device generative chip-synth island music.
 * Pulse lead + arp, triangle bass. Scheduled live — no sample loop, no noise bed.
 */

const LOOKAHEAD = 0.12;
const TICK_MS = 30;

/** C island pentatonic (C D E G A) across two octaves */
const LEAD = [72, 74, 76, 79, 81, 84, 86, 88, 91, 93];

const VAMPS: number[][][] = [
  [
    [60, 64, 67],
    [65, 69, 72],
    [60, 64, 67],
    [67, 71, 74],
  ],
  [
    [60, 64, 67],
    [62, 65, 69],
    [64, 67, 71],
    [65, 69, 72],
  ],
  [
    [60, 64, 67, 70],
    [65, 69, 72],
    [67, 71, 74],
    [65, 69, 72],
  ],
];

type Graph = {
  ctx: AudioContext;
  master: GainNode;
  pulse25: PeriodicWave;
  pulse50: PeriodicWave;
  timer: number | null;
  next: number;
  step: number;
  beat: number;
  vamp: number;
  chord: number;
  barsLeft: number;
  degree: number;
  restLeft: number;
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
  const n = 32;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    imag[i] = (2 / (i * Math.PI)) * Math.sin(i * Math.PI * duty);
  }
  return ctx.createPeriodicWave(real, imag);
}

function chipNote(
  ctx: AudioContext,
  dest: AudioNode,
  wave: PeriodicWave | "triangle" | "square",
  midi: number,
  when: number,
  dur: number,
  peak: number,
  attack = 0.004,
) {
  const osc = ctx.createOscillator();
  if (wave === "triangle") osc.type = "triangle";
  else if (wave === "square") osc.type = "square";
  else osc.setPeriodicWave(wave);
  osc.frequency.setValueAtTime(midiHz(midi), when);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), when + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  osc.connect(g);
  g.connect(dest);
  osc.start(when);
  osc.stop(when + dur + 0.02);
  osc.onended = () => {
    osc.disconnect();
    g.disconnect();
  };
}

function ensure(): Graph | null {
  const Ctor = ctxCtor();
  if (!Ctor) return null;
  if (graph) return graph;
  const ctx = new Ctor({ latencyHint: "playback" });
  const master = ctx.createGain();
  master.gain.value = 0;
  master.connect(ctx.destination);
  graph = {
    ctx,
    master,
    pulse25: makePulse(ctx, 0.25),
    pulse50: makePulse(ctx, 0.5),
    timer: null,
    next: 0,
    step: 0,
    beat: 60 / 128,
    vamp: 0,
    chord: 0,
    barsLeft: 2,
    degree: 3,
    restLeft: 0,
  };
  return graph;
}

function chordNow(g: Graph): number[] {
  return VAMPS[g.vamp][g.chord % VAMPS[g.vamp].length];
}

function advance(g: Graph) {
  const when = g.next;
  const sixteenth = g.beat / 4;
  const step = g.step;
  const beat = step % 16;
  const ch = chordNow(g);

  // Triangle bass — roots on 1 & 3, octave jump island walk
  if (beat === 0 || beat === 8) {
    chipNote(g.ctx, g.master, "triangle", ch[0] - 12, when, sixteenth * 3.2, 0.22);
  } else if (beat === 4 || beat === 12) {
    const bass = Math.random() < 0.45 ? ch[0] - 5 : ch[0] - 12;
    chipNote(g.ctx, g.master, "triangle", bass, when, sixteenth * 2.4, 0.16);
  }

  // Pulse arp — 16ths, island offbeats louder
  {
    const idx = [0, 1, 2, 1][beat % 4]!;
    const note = ch[idx % ch.length]! + (beat % 8 < 4 ? 0 : 12);
    const vel = beat % 2 === 0 ? 0.035 : 0.07;
    chipNote(g.ctx, g.master, g.pulse50, note, when, sixteenth * 0.92, vel);
  }

  // Pulse lead — generative pentatonic phrases
  if (g.restLeft > 0) {
    g.restLeft -= 1;
  } else if (beat !== 1 && beat !== 9 && Math.random() < 0.58) {
    const hop = Math.random() < 0.18 ? 0 : Math.random() < 0.62 ? 1 : 2;
    g.degree += (Math.random() < 0.47 ? -1 : 1) * hop;
    if (g.degree < 0) g.degree = 1;
    if (g.degree > LEAD.length - 1) g.degree = LEAD.length - 2;
    const hold = Math.random() < 0.22 ? 2 : 1;
    chipNote(
      g.ctx,
      g.master,
      g.pulse25,
      LEAD[g.degree]!,
      when,
      sixteenth * (hold * 1.6),
      0.11,
    );
    if (hold === 2) g.restLeft = 1;
    if (Math.random() < 0.12) g.restLeft += 2 + ((Math.random() * 3) | 0);
  }

  // Woodblock tick (tiny square, not noise)
  if (beat === 4 || beat === 12) {
    chipNote(g.ctx, g.master, "square", 96, when, 0.03, 0.028, 0.001);
  }

  if (beat === 15) {
    g.barsLeft -= 1;
    if (g.barsLeft <= 0) {
      g.chord = (g.chord + 1) % VAMPS[g.vamp].length;
      if (g.chord === 0 && Math.random() < 0.5) {
        g.vamp = (Math.random() * VAMPS.length) | 0;
      }
      g.barsLeft = Math.random() < 0.35 ? 1 : 2;
    }
  }

  g.step += 1;
  g.next += sixteenth;
}

function tick() {
  const g = graph;
  if (!g || !wantOn) return;
  const horizon = g.ctx.currentTime + LOOKAHEAD;
  while (g.next < horizon) advance(g);
}

function start(g: Graph) {
  if (g.timer != null) return;
  g.next = g.ctx.currentTime + 0.05;
  g.step = 0;
  g.vamp = (Math.random() * VAMPS.length) | 0;
  g.chord = 0;
  g.barsLeft = 2;
  g.degree = 4;
  g.restLeft = 2;
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
  g.master.gain.setTargetAtTime(on ? 0.55 : 0, now, 0.28);
  if (on) start(g);
  else stop(g);
}

export function resumeOceanAudio(): void {
  if (graph && graph.ctx.state === "suspended") void graph.ctx.resume();
}
