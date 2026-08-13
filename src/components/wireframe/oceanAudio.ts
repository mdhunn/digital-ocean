/**
 * On-device generative island music.
 * Steel pan + offbeat guitar chops + walking bass, scheduled live.
 * No sample loops. No noise beds. No filter-sweep drones.
 */

const LOOKAHEAD = 0.14;
const TICK_MS = 35;

const PAN_PARTIALS = [
  { ratio: 1, gain: 1 },
  { ratio: 2.008, gain: 0.42 },
  { ratio: 2.99, gain: 0.2 },
  { ratio: 4.03, gain: 0.1 },
  { ratio: 5.12, gain: 0.05 },
];

/** G major pentatonic — island steel */
const PAN_SCALE = [67, 69, 71, 74, 76, 79, 81, 83, 86, 88];

/** Island vamps in G — picked freshly, not a fixed loop */
const VAMPS: number[][][] = [
  [
    [55, 59, 62, 67],
    [60, 64, 67, 72],
    [55, 59, 62, 67],
    [62, 66, 69, 74],
  ],
  [
    [55, 59, 62, 67],
    [52, 55, 59, 64],
    [60, 64, 67, 72],
    [62, 66, 69, 74],
  ],
  [
    [55, 59, 62, 67],
    [60, 64, 67, 72],
    [62, 66, 69, 74],
    [60, 64, 67, 72],
  ],
];

type Graph = {
  ctx: AudioContext;
  master: GainNode;
  bus: GainNode;
  timer: number | null;
  next: number;
  beat: number;
  step: number;
  vamp: number;
  chord: number;
  barsLeft: number;
  degree: number;
  lastPan: number;
  phraseLeft: number;
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

function envGain(
  ctx: AudioContext,
  dest: AudioNode,
  when: number,
  peak: number,
  attack: number,
  dur: number,
): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), when + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  g.connect(dest);
  return g;
}

function playPan(
  ctx: AudioContext,
  dest: AudioNode,
  midi: number,
  when: number,
  vel: number,
) {
  const freq = midiHz(midi);
  const dur = 1.15 + Math.max(0, (76 - midi) * 0.035);
  const g = envGain(ctx, dest, when, 0.11 * vel, 0.006, dur);
  const pan = ctx.createStereoPanner();
  pan.pan.setValueAtTime((Math.random() - 0.5) * 0.45, when);
  pan.connect(g);
  for (const p of PAN_PARTIALS) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq * p.ratio, when);
    const pg = ctx.createGain();
    pg.gain.value = p.gain;
    osc.connect(pg);
    pg.connect(pan);
    osc.start(when);
    osc.stop(when + dur + 0.03);
    osc.onended = () => {
      osc.disconnect();
      pg.disconnect();
    };
  }
}

function playPluck(
  ctx: AudioContext,
  dest: AudioNode,
  midi: number,
  when: number,
  peak: number,
  dur: number,
  panAmt: number,
) {
  const osc = ctx.createOscillator();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(midiHz(midi), when);
  const g = envGain(ctx, dest, when, peak, 0.008, dur);
  const pan = ctx.createStereoPanner();
  pan.pan.setValueAtTime(panAmt, when);
  osc.connect(pan);
  pan.connect(g);
  osc.start(when);
  osc.stop(when + dur + 0.02);
  osc.onended = () => {
    osc.disconnect();
    pan.disconnect();
  };
}

function playBass(
  ctx: AudioContext,
  dest: AudioNode,
  midi: number,
  when: number,
) {
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(midiHz(midi), when);
  const g = envGain(ctx, dest, when, 0.09, 0.012, 0.38);
  osc.connect(g);
  osc.start(when);
  osc.stop(when + 0.42);
  osc.onended = () => osc.disconnect();
}

function playClick(ctx: AudioContext, dest: AudioNode, when: number, freq: number) {
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, when);
  const g = envGain(ctx, dest, when, 0.03, 0.002, 0.045);
  osc.connect(g);
  osc.start(when);
  osc.stop(when + 0.06);
  osc.onended = () => osc.disconnect();
}

function ensure(): Graph | null {
  const Ctor = ctxCtor();
  if (!Ctor) return null;
  if (graph) return graph;
  const ctx = new Ctor({ latencyHint: "playback" });
  const master = ctx.createGain();
  master.gain.value = 0;
  master.connect(ctx.destination);
  const bus = ctx.createGain();
  bus.gain.value = 1;
  bus.connect(master);
  graph = {
    ctx,
    master,
    bus,
    timer: null,
    next: 0,
    beat: 60 / 96,
    step: 0,
    vamp: 0,
    chord: 0,
    barsLeft: 2,
    degree: 3,
    lastPan: -8,
    phraseLeft: 4,
  };
  return graph;
}

function currentChord(g: Graph): number[] {
  return VAMPS[g.vamp][g.chord % VAMPS[g.vamp].length];
}

function advance(g: Graph) {
  const when = g.next;
  const step = g.step % 8;
  const chord = currentChord(g);

  if (step === 0 || step === 4) {
    playBass(g.ctx, g.bus, chord[0] - 12, when);
  }

  if (step === 2 || step === 3 || step === 6 || step === 7) {
    if (Math.random() < 0.86) {
      const n = chord[1 + ((Math.random() * 3) | 0)];
      playPluck(g.ctx, g.bus, n, when, 0.045, 0.16, step < 4 ? -0.25 : 0.28);
      if (Math.random() < 0.55) {
        playPluck(g.ctx, g.bus, n + 7, when + 0.012, 0.022, 0.12, 0.15);
      }
    }
  }

  if (step === 2 || step === 6) {
    playClick(g.ctx, g.bus, when, 980 + Math.random() * 80);
  }
  if (step === 0 && Math.random() < 0.4) {
    playClick(g.ctx, g.bus, when, 640);
  }

  g.phraseLeft -= 1;
  if (g.phraseLeft <= 0) {
    g.phraseLeft = 3 + ((Math.random() * 5) | 0);
    g.lastPan = -4;
  } else if (step !== 1 && step !== 5 && g.step - g.lastPan >= 1) {
    if (Math.random() < 0.62) {
      const hop = Math.random() < 0.2 ? 0 : Math.random() < 0.6 ? 1 : 2;
      g.degree += (Math.random() < 0.46 ? -1 : 1) * hop;
      if (g.degree < 0) g.degree = 1;
      if (g.degree > PAN_SCALE.length - 1) g.degree = PAN_SCALE.length - 2;
      playPan(g.ctx, g.bus, PAN_SCALE[g.degree], when, 0.7 + Math.random() * 0.35);
      g.lastPan = g.step;
    }
  }

  if (step === 7) {
    g.barsLeft -= 1;
    if (g.barsLeft <= 0) {
      g.chord = (g.chord + 1) % VAMPS[g.vamp].length;
      if (g.chord === 0 && Math.random() < 0.55) {
        g.vamp = (Math.random() * VAMPS.length) | 0;
      }
      g.barsLeft = Math.random() < 0.3 ? 1 : 2;
    }
  }

  g.step += 1;
  g.next += g.beat * 0.5;
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
  g.step = 0;
  g.vamp = (Math.random() * VAMPS.length) | 0;
  g.chord = 0;
  g.barsLeft = 2;
  g.degree = 3;
  g.lastPan = -8;
  g.phraseLeft = 5;
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
  g.master.gain.setTargetAtTime(on ? 0.68 : 0, now, 0.35);
  if (on) start(g);
  else stop(g);
}

export function resumeOceanAudio(): void {
  if (graph && graph.ctx.state === "suspended") void graph.ctx.resume();
}
