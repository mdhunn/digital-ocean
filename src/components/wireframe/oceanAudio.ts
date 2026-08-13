/**
 * Underwater ambient music — decoded loop, not a noise bed.
 * Unlock + resume must happen inside a user gesture (the music toggle).
 */

const SOURCES = ["/audio/reef-ambient.ogg", "/audio/reef-ambient.m4a"];

type OceanGraph = {
  ctx: AudioContext;
  master: GainNode;
  source: AudioBufferSourceNode | null;
  buffer: AudioBuffer | null;
};

let graph: OceanGraph | null = null;
let wantOn = false;
let loadPromise: Promise<void> | null = null;

function getContextCtor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  return (
    window.AudioContext ||
    (window as Window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext ||
    null
  );
}

function ensureGraph(): OceanGraph | null {
  const Ctor = getContextCtor();
  if (!Ctor) return null;
  if (graph) return graph;
  const ctx = new Ctor({ latencyHint: "playback" });
  const master = ctx.createGain();
  master.gain.value = 0;
  master.connect(ctx.destination);
  graph = { ctx, master, source: null, buffer: null };
  return graph;
}

async function loadBuffer(g: OceanGraph): Promise<void> {
  if (g.buffer) return;
  let lastErr: unknown = null;
  for (const url of SOURCES) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const raw = await res.arrayBuffer();
      g.buffer = await g.ctx.decodeAudioData(raw.slice(0));
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!g.buffer) throw lastErr ?? new Error("Could not decode ambient loop");
}

function startSource(g: OceanGraph) {
  if (!g.buffer) return;
  if (g.source) {
    try {
      g.source.stop();
    } catch {
      /* already stopped */
    }
    g.source.disconnect();
    g.source = null;
  }
  const src = g.ctx.createBufferSource();
  src.buffer = g.buffer;
  src.loop = true;
  src.loopStart = 1.6;
  src.loopEnd = Math.max(2, g.buffer.duration - 1.6);
  src.connect(g.master);
  src.start();
  g.source = src;
}

export function unlockOceanAudio(): void {
  const g = ensureGraph();
  if (!g) return;
  if (g.ctx.state === "suspended") void g.ctx.resume();
  if (!loadPromise) {
    loadPromise = loadBuffer(g)
      .then(() => {
        if (wantOn) startSource(g);
      })
      .catch(() => {
        loadPromise = null;
      });
  }
}

export function setOceanMusic(on: boolean): void {
  wantOn = on;
  unlockOceanAudio();
  const g = graph;
  if (!g) return;
  if (g.ctx.state === "suspended") void g.ctx.resume();
  const now = g.ctx.currentTime;
  g.master.gain.cancelScheduledValues(now);
  g.master.gain.setTargetAtTime(on ? 0.62 : 0, now, 0.45);
  if (on && g.buffer && !g.source) startSource(g);
  if (!on && g.source) {
    const src = g.source;
    window.setTimeout(() => {
      if (!wantOn && graph?.source === src) {
        try {
          src.stop();
        } catch {
          /* ignore */
        }
        src.disconnect();
        if (graph.source === src) graph.source = null;
      }
    }, 1400);
  }
}

export function resumeOceanAudio(): void {
  if (graph && graph.ctx.state === "suspended") {
    void graph.ctx.resume();
  }
}
