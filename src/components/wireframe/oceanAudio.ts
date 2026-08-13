/**
 * Procedural underwater ambience — Web Audio only, no assets.
 * Unlock + resume must happen inside a user gesture (the music toggle).
 */

type OceanGraph = {
  ctx: AudioContext;
  master: GainNode;
  lfo: OscillatorNode;
};

let graph: OceanGraph | null = null;

function makeNoiseBuffer(ctx: AudioContext, seconds: number, brown: boolean) {
  const rate = ctx.sampleRate;
  const length = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(1, length, rate);
  const data = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1;
    if (brown) {
      last = (last + white * 0.02) * 0.986;
      data[i] = last * 3.2;
    } else {
      data[i] = white;
    }
  }
  return buf;
}

function startLoop(
  ctx: AudioContext,
  buffer: AudioBuffer,
  dest: AudioNode,
  playbackRate = 1,
) {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  src.playbackRate.value = playbackRate;
  src.connect(dest);
  src.start();
  return src;
}

function buildGraph(ctx: AudioContext): OceanGraph {
  const master = ctx.createGain();
  master.gain.value = 0;
  master.connect(ctx.destination);

  const bed = ctx.createGain();
  bed.gain.value = 0.22;
  bed.connect(master);

  const brownFilter = ctx.createBiquadFilter();
  brownFilter.type = "lowpass";
  brownFilter.frequency.value = 380;
  brownFilter.Q.value = 0.55;
  brownFilter.connect(bed);
  startLoop(ctx, makeNoiseBuffer(ctx, 3.2, true), brownFilter, 0.55);

  const wash = ctx.createBiquadFilter();
  wash.type = "bandpass";
  wash.frequency.value = 720;
  wash.Q.value = 0.7;
  const washGain = ctx.createGain();
  washGain.gain.value = 0.07;
  wash.connect(washGain);
  washGain.connect(master);
  startLoop(ctx, makeNoiseBuffer(ctx, 2.4, false), wash, 0.35);

  const droneA = ctx.createOscillator();
  droneA.type = "sine";
  droneA.frequency.value = 49;
  const droneB = ctx.createOscillator();
  droneB.type = "sine";
  droneB.frequency.value = 73.5;
  const droneGain = ctx.createGain();
  droneGain.gain.value = 0.045;
  droneA.connect(droneGain);
  droneB.connect(droneGain);
  droneGain.connect(master);
  droneA.start();
  droneB.start();

  const shimmer = ctx.createOscillator();
  shimmer.type = "sine";
  shimmer.frequency.value = 392;
  const shimmerGain = ctx.createGain();
  shimmerGain.gain.value = 0.012;
  shimmer.connect(shimmerGain);
  shimmerGain.connect(master);
  shimmer.start();

  const lfo = ctx.createOscillator();
  lfo.type = "sine";
  lfo.frequency.value = 0.07;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 90;
  lfo.connect(lfoGain);
  lfoGain.connect(brownFilter.frequency);
  const lfoShimmer = ctx.createGain();
  lfoShimmer.gain.value = 0.008;
  lfo.connect(lfoShimmer);
  lfoShimmer.connect(shimmerGain.gain);
  lfo.start();

  return { ctx, master, lfo };
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

export function unlockOceanAudio(): void {
  const Ctor = getContextCtor();
  if (!Ctor) return;
  if (!graph) {
    const ctx = new Ctor({ latencyHint: "playback" });
    graph = buildGraph(ctx);
  }
  if (graph.ctx.state === "suspended") {
    void graph.ctx.resume();
  }
}

export function setOceanMusic(on: boolean): void {
  unlockOceanAudio();
  if (!graph) return;
  const { ctx, master } = graph;
  if (ctx.state === "suspended") void ctx.resume();
  const now = ctx.currentTime;
  master.gain.cancelScheduledValues(now);
  master.gain.setTargetAtTime(on ? 0.85 : 0, now, 0.38);
}

export function resumeOceanAudio(): void {
  if (graph && graph.ctx.state === "suspended") {
    void graph.ctx.resume();
  }
}
