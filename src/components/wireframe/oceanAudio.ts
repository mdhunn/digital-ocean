/**
 * Live generative reef score.
 * Oscillators + scheduled notes only — no sample loops, no noise beds.
 * Unlock + resume must happen inside a user gesture (the music toggle).
 */

const LOOKAHEAD = 0.12;
const SCHEDULE_MS = 40;

/** D major / lydian — bright water, not a drone rumble. */
const SCALE = [62, 64, 66, 69, 71, 73, 74, 76, 78, 81, 83, 86];

const CHORDS: number[][] = [
  [50, 57, 61, 64, 66], // Dmaj9
  [55, 59, 62, 66, 69], // Gmaj7
  [52, 59, 62, 66, 71], // Em9
  [57, 61, 64, 66, 69], // Aadd9
  [47, 54, 57, 61, 64], // Bm7
  [54, 57, 61, 66, 69], // F#m11
];

type OceanGraph = {
  ctx: AudioContext;
  master: GainNode;
  bus: GainNode;
  timer: number | null;
  nextTime: number;
  degree: number;
  chord: number;
  beatsUntilChord: number;
  beatsUntilMelody: number;
  beatsUntilBell: number;
  beatSec: number;
};

let graph: OceanGraph | null = null;
let wantOn = false;

function midiHz(n: number): number {
  return 440 * 2 ** ((n - 69) / 12);
}

function pick<T>(arr: readonly T[], i: number): T {
  return arr[((i % arr.length) + arr.length) % arr.length];
}

function getContextCtor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  return (
    window.AudioContext ||
    (window as Window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext ||
    null
  );
}

function tone(
  ctx: AudioContext,
  dest: AudioNode,
  {
    freq,
    when,
    dur,
    peak,
    attack,
    type = "sine",
    pan = 0,
  }: {
    freq: number;
    when: number;
    dur: number;
    peak: number;
    attack: number;
    type?: OscillatorType;
    pan?: number;
  },
) {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, when);

  const g = ctx.createGain();
  const a = Math.max(0.012, Math.min(attack, dur * 0.45));
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), when + a);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);

  const p = ctx.createStereoPanner();
  p.pan.setValueAtTime(Math.max(-1, Math.min(1, pan)), when);

  osc.connect(g);
  g.connect(p);
  p.connect(dest);
  osc.start(when);
  osc.stop(when + dur + 0.02);
  osc.onended = () => {
    osc.disconnect();
    g.disconnect();
    p.disconnect();
  };
}

function playChord(g: OceanGraph, when: number) {
  const notes = CHORDS[g.chord];
  const root = notes[0];
  const hold = g.beatSec * (10 + Math.random() * 4);

  tone(g.ctx, g.bus, {
    freq: midiHz(root),
    when,
    dur: hold,
    peak: 0.055,
    attack: 2.4,
    pan: -0.08,
  });

  notes.forEach((n, i) => {
    const spread = notes.length > 1 ? i / (notes.length - 1) : 0.5;
    tone(g.ctx, g.bus, {
      freq: midiHz(n),
      when: when + i * 0.045,
      dur: hold * (0.88 + Math.random() * 0.18),
      peak: 0.042 - i * 0.004,
      attack: 2.1 + i * 0.15,
      pan: -0.45 + spread * 0.9,
    });
  });
}

function playMelody(g: OceanGraph, when: number) {
  const step = Math.random() < 0.18 ? 0 : Math.random() < 0.55 ? 1 : 2;
  const dir = Math.random() < 0.48 ? -1 : 1;
  g.degree += dir * step;
  if (g.degree < 0) g.degree = 1;
  if (g.degree > SCALE.length - 1) g.degree = SCALE.length - 2;

  const note = SCALE[g.degree];
  const beats = pick([0.75, 1, 1, 1.5, 2, 2.5], (Math.random() * 6) | 0);
  const dur = g.beatSec * beats * 0.92;

  tone(g.ctx, g.bus, {
    freq: midiHz(note),
    when,
    dur,
    peak: 0.07,
    attack: 0.035,
    pan: (Math.random() - 0.5) * 0.5,
  });

  if (Math.random() < 0.35) {
    tone(g.ctx, g.bus, {
      freq: midiHz(note + (Math.random() < 0.5 ? 4 : 7)),
      when: when + 0.04,
      dur: dur * 0.7,
      peak: 0.028,
      attack: 0.05,
      pan: (Math.random() - 0.5) * 0.7,
    });
  }

  g.beatsUntilMelody = beats + (Math.random() < 0.22 ? 0.5 : 0);
}

function playBell(g: OceanGraph, when: number) {
  const note = pick(SCALE.slice(5), (Math.random() * 6) | 0);
  tone(g.ctx, g.bus, {
    freq: midiHz(note),
    when,
    dur: g.beatSec * 3.2,
    peak: 0.034,
    attack: 0.01,
    pan: Math.random() < 0.5 ? -0.55 : 0.55,
  });
  g.beatsUntilBell = 5 + Math.random() * 9;
}

function advance(g: OceanGraph) {
  const when = g.nextTime;

  if (g.beatsUntilChord <= 0.001) {
    const roll = Math.random();
    if (roll < 0.34) g.chord = 0;
    else if (roll < 0.55) g.chord = 1;
    else g.chord = (Math.random() * CHORDS.length) | 0;
    playChord(g, when);
    g.beatsUntilChord = 8 + Math.floor(Math.random() * 5);
  }

  if (g.beatsUntilMelody <= 0.001) playMelody(g, when);
  if (g.beatsUntilBell <= 0.001) playBell(g, when);

  const step = 0.25;
  g.beatsUntilChord -= step;
  g.beatsUntilMelody -= step;
  g.beatsUntilBell -= step;
  g.nextTime += g.beatSec * step;
}

function tick() {
  const g = graph;
  if (!g || !wantOn) return;
  const horizon = g.ctx.currentTime + LOOKAHEAD;
  while (g.nextTime < horizon) advance(g);
}

function startScheduler(g: OceanGraph) {
  if (g.timer != null) return;
  g.nextTime = g.ctx.currentTime + 0.08;
  g.beatsUntilChord = 0;
  g.beatsUntilMelody = 1.5;
  g.beatsUntilBell = 4;
  tick();
  g.timer = window.setInterval(tick, SCHEDULE_MS);
}

function stopScheduler(g: OceanGraph) {
  if (g.timer != null) {
    window.clearInterval(g.timer);
    g.timer = null;
  }
}

function ensureGraph(): OceanGraph | null {
  const Ctor = getContextCtor();
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
    nextTime: 0,
    degree: 4,
    chord: 0,
    beatsUntilChord: 0,
    beatsUntilMelody: 2,
    beatsUntilBell: 5,
    beatSec: 60 / 68,
  };
  return graph;
}

export function unlockOceanAudio(): void {
  const g = ensureGraph();
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
  g.master.gain.setTargetAtTime(on ? 0.7 : 0, now, 0.42);
  if (on) startScheduler(g);
  else stopScheduler(g);
}

export function resumeOceanAudio(): void {
  if (graph && graph.ctx.state === "suspended") {
    void graph.ctx.resume();
  }
}
