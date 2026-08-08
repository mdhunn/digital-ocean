import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import {
  registerDolphinPositions,
  sharkWorldPositions,
} from "./creatureRegistry";

/**
 * High-polygon bottlenose dolphins (Tursiops truncatus).
 * Anatomy from multi-angle refs: side profile, dorsal/top, ventral belly, frontal.
 *
 * Key anatomy (vs shark):
 *  - Elongated rostrum (beak) + bulbous melon forehead
 *  - Blowhole on dorsal cranial surface
 *  - Single falcate dorsal fin mid-back
 *  - Pectoral flippers; no 2nd dorsal / anal
 *  - Horizontal flukes (not vertical caudal) — carangiform DORSOVENTRAL swim
 *  - Countershaded slate-grey dorsal / pale ventral
 *
 * Behavior: friendly + curious about cursor; alarm/flee when sharks hunt nearby.
 * Soft-body Verlet + springs; swim faster than great whites.
 */

const SURFACE_Y = 12;
const SEABED_Y = -1.5;
const DOLPHIN_COUNT = 4;
const SPINE_LEN = 42;
const RADIAL = 36;
const SOFT_ITERS = 4;
const BODY_LEN = 5.2;

/* ── wireframe materials ───────────────────────────────────────── */

const BODY_MAT = new THREE.MeshBasicMaterial({
  vertexColors: true,
  wireframe: true,
  transparent: true,
  opacity: 0.98,
  depthWrite: false,
});

const FIN_MAT = new THREE.MeshBasicMaterial({
  color: new THREE.Color("#8aa0b0"),
  wireframe: true,
  transparent: true,
  opacity: 0.95,
  depthWrite: false,
  side: THREE.DoubleSide,
});

const DETAIL_MAT = new THREE.MeshBasicMaterial({
  color: new THREE.Color("#c8dce8"),
  wireframe: true,
  transparent: true,
  opacity: 0.92,
  depthWrite: false,
  side: THREE.DoubleSide,
});

const FLUKE_MAT = new THREE.MeshBasicMaterial({
  color: new THREE.Color("#9ab0bc"),
  wireframe: true,
  transparent: true,
  opacity: 0.96,
  depthWrite: false,
  side: THREE.DoubleSide,
});

function seeded(n: number) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/* ── Anatomical body profile (bottlenose) ────────────────────────
 * Side: long beak, melon forehead, deep midbody, slim peduncle, flukes.
 * Top:  spindle, mid dorsal fin, wide flukes at tip.
 * Bottom: pale belly, pectoral flippers, genital slit mid-ventral.
 * Front: beak tip, melon dome, eyes lateral, smile crease.
 * u: 0 = rostrum tip → 1 = fluke base
 */

function bodyRadius(u: number): number {
  if (u < 0.08) return 0.02 + u * 1.15;
  if (u < 0.16) return 0.112 + (u - 0.08) * 4.8;
  if (u < 0.26) return 0.496 + (u - 0.16) * 1.9;
  if (u < 0.42) return 0.686 + (u - 0.26) * 0.55;
  if (u < 0.55) return 0.774 - (u - 0.42) * 0.4;
  if (u < 0.72) return 0.722 - (u - 0.55) * 1.55;
  if (u < 0.88) return 0.458 - (u - 0.72) * 1.65;
  return 0.194 - (u - 0.88) * 0.55;
}

function bodyHeightScale(u: number): number {
  if (u < 0.1) return 0.65 + u * 2.2;
  if (u < 0.2) return 0.87 + (u - 0.1) * 1.4;
  if (u < 0.45) return 1.01 + (u - 0.2) * 0.28;
  if (u < 0.65) return 1.08;
  if (u < 0.85) return 1.08 - (u - 0.65) * 0.7;
  return 0.94 - (u - 0.85) * 0.55;
}

function bodyWidthScale(u: number): number {
  if (u < 0.12) return 0.55 + u * 2.5;
  if (u < 0.35) return 0.85 + (u - 0.12) * 0.55;
  if (u < 0.6) return 0.976;
  if (u < 0.85) return 0.976 - (u - 0.6) * 0.55;
  return 0.838 - (u - 0.85) * 0.6;
}

/* ── Soft-body types ───────────────────────────────────────────── */

type SoftParticle = {
  x: number;
  y: number;
  z: number;
  px: number;
  py: number;
  pz: number;
  pinned: boolean;
};

type SoftSpring = {
  a: number;
  b: number;
  rest: number;
  stiff: number;
};

function makeParticle(x: number, y: number, z: number, pinned = false): SoftParticle {
  return { x, y, z, px: x, py: y, pz: z, pinned };
}

type DolphinSim = {
  id: number;
  mesh: THREE.Mesh;
  finMesh: THREE.Mesh;
  detailMesh: THREE.Mesh;
  flukeMesh: THREE.Mesh;
  particles: SoftParticle[];
  springs: SoftSpring[];
  spineCount: number;
  radial: number;
  restVerts: Float32Array;
  influence: Uint16Array;
  weights: Float32Array;
  finRest: Float32Array;
  finInfluence: Uint16Array;
  finWeights: Float32Array;
  detailRest: Float32Array;
  detailInfluence: Uint16Array;
  detailWeights: Float32Array;
  flukeRest: Float32Array;
  flukeInfluence: Uint16Array;
  flukeWeights: Float32Array;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  heading: THREE.Vector3;
  yaw: number;
  pitch: number;
  speed: number;
  baseSpeed: number;
  phase: number;
  scale: number;
  alarm: number;
  curiosity: number;
  podAngle: number;
  smile: number;
};

const SHARK_ALARM_RANGE = 11;
const SHARK_PANIC_RANGE = 6.5;
const CURIOUS_RANGE = 14;

/* ── High-poly body geometry ───────────────────────────────────── */

function countershadeColor(y: number, r: number, out: THREE.Color) {
  const ny = y / Math.max(r, 0.05);
  if (ny < -0.18) {
    out.setRGB(0.88, 0.9, 0.92);
  } else if (ny < 0.05) {
    const t = (ny + 0.18) / 0.23;
    out.setRGB(0.88 - t * 0.22, 0.9 - t * 0.18, 0.92 - t * 0.14);
  } else if (ny < 0.4) {
    const t = (ny - 0.05) / 0.35;
    out.setRGB(0.66 - t * 0.18, 0.72 - t * 0.14, 0.78 - t * 0.12);
  } else {
    out.setRGB(0.42, 0.52, 0.6);
  }
}

function buildDolphinGeometry(seed: number): {
  body: THREE.BufferGeometry;
  fins: THREE.BufferGeometry;
  detail: THREE.BufferGeometry;
  flukes: THREE.BufferGeometry;
} {
  const len = BODY_LEN;
  const spineN = SPINE_LEN;
  const radN = RADIAL;
  const positions: number[] = [];
  const colors: number[] = [];
  const col = new THREE.Color();

  for (let s = 0; s <= spineN; s++) {
    const u = s / spineN;
    const z = (u - 0.5) * len;
    const r = bodyRadius(u);
    const hy = bodyHeightScale(u);
    const hx = bodyWidthScale(u);
    for (let k = 0; k <= radN; k++) {
      const a = (k / radN) * Math.PI * 2;
      const melon =
        u > 0.06 && u < 0.2 && a > 0.2 && a < Math.PI - 0.2
          ? 1 + Math.sin(((u - 0.06) / 0.14) * Math.PI) * Math.sin(a) * 0.18
          : 1;
      const beakFlat = u < 0.1 ? 0.72 + u * 2.2 : 1;
      const belly =
        a > Math.PI && a < Math.PI * 2 ? 0.9 + Math.sin(a) * 0.03 : 1;
      const ridge =
        a > 0.5 && a < Math.PI - 0.5 ? 1 + Math.cos(a) * 0.03 : 1;
      const px = Math.cos(a) * r * hx * belly;
      const py = Math.sin(a) * r * hy * melon * beakFlat * ridge;
      const n =
        1 +
        Math.sin(a * 5 + u * 11 + seed) * 0.01 +
        Math.sin(a * 13 - u * 8) * 0.006;
      positions.push(px * n, py * n, z);
      countershadeColor(py, r * hy, col);
      if (u < 0.1) col.lerp(new THREE.Color("#d0d8e0"), 0.35);
      colors.push(col.r, col.g, col.b);
    }
  }

  const indices: number[] = [];
  const stride = radN + 1;
  for (let s = 0; s < spineN; s++) {
    for (let k = 0; k < radN; k++) {
      const a = s * stride + k;
      const b = a + stride;
      indices.push(a, b, a + 1);
      indices.push(a + 1, b, b + 1);
    }
  }

  const tip = positions.length / 3;
  positions.push(0, -0.01, -len * 0.5 - 0.22);
  colors.push(0.82, 0.86, 0.9);
  for (let k = 0; k < radN; k++) {
    indices.push(tip, k + 1, k);
  }

  const body = new THREE.BufferGeometry();
  body.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  body.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  body.setIndex(indices);
  body.computeVertexNormals();

  const finPos: number[] = [];
  const finIdx: number[] = [];

  // Dorsal fin — falcate, mid-body
  {
    const segs = 22;
    const baseZ0 = -0.05;
    const baseZ1 = 1.05;
    const baseY = 0.55;
    const height = 0.95;
    const start = finPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const z = THREE.MathUtils.lerp(baseZ0, baseZ1, t);
      const edge =
        t < 0.38
          ? Math.pow(t / 0.38, 0.75)
          : Math.pow(1 - (t - 0.38) / 0.62, 1.25);
      const tipLean = t * 0.18;
      finPos.push(0, baseY, z);
      finPos.push(0.025, baseY + height * edge, z + tipLean);
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      finIdx.push(a, a + 1, a + 2);
      finIdx.push(a + 2, a + 1, a + 3);
    }
    const mid = finPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const z = THREE.MathUtils.lerp(baseZ0, baseZ1, t);
      const edge =
        t < 0.38
          ? Math.pow(t / 0.38, 0.75)
          : Math.pow(1 - (t - 0.38) / 0.62, 1.25);
      finPos.push(0.04, baseY + 0.05, z);
      finPos.push(0.02, baseY + height * edge * 0.7, z + t * 0.12);
    }
    for (let i = 0; i < segs; i++) {
      const a = mid + i * 2;
      finIdx.push(a, a + 1, a + 2);
      finIdx.push(a + 2, a + 1, a + 3);
    }
  }

  // Pectoral flippers
  for (const side of [-1, 1] as const) {
    const segs = 20;
    const start = finPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const span = Math.sin(t * Math.PI * 0.95) * 1.05;
      const droop = t * 0.42;
      const sweep = t * 0.48;
      finPos.push(0.32 * side, -0.08, -0.85 + t * 0.2);
      finPos.push(
        (0.32 + span) * side,
        -0.08 - droop - span * 0.12,
        -0.85 + sweep + t * 0.25,
      );
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      finIdx.push(a, a + 1, a + 2);
      finIdx.push(a + 2, a + 1, a + 3);
    }
    const midStart = finPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const span = Math.sin(t * Math.PI * 0.95) * 0.62;
      const droop = t * 0.25;
      finPos.push(0.38 * side, -0.1, -0.75 + t * 0.22);
      finPos.push((0.38 + span) * side, -0.1 - droop, -0.7 + t * 0.45);
    }
    for (let i = 0; i < segs; i++) {
      const a = midStart + i * 2;
      finIdx.push(a, a + 1, a + 2);
      finIdx.push(a + 2, a + 1, a + 3);
    }
  }

  const fins = new THREE.BufferGeometry();
  fins.setAttribute("position", new THREE.Float32BufferAttribute(finPos, 3));
  fins.setIndex(finIdx);
  fins.computeVertexNormals();

  // Horizontal flukes
  const flukePos: number[] = [];
  const flukeIdx: number[] = [];
  {
    const segs = 28;
    for (const side of [-1, 1] as const) {
      const start = flukePos.length / 3;
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const span = Math.sin(t * Math.PI * 0.92) * 1.15;
        const aft = t * 0.95;
        flukePos.push(0.02 * side, 0, len * 0.5 - 0.05 + t * 0.08);
        flukePos.push(
          (0.05 + span) * side,
          Math.sin(t * Math.PI) * 0.04 * side * 0.2,
          len * 0.5 - 0.02 + aft,
        );
      }
      for (let i = 0; i < segs; i++) {
        const a = start + i * 2;
        flukeIdx.push(a, a + 1, a + 2);
        flukeIdx.push(a + 2, a + 1, a + 3);
      }
      const cStart = flukePos.length / 3;
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const span = Math.sin(t * Math.PI) * 1.05;
        flukePos.push(0.04 * side, 0.01, len * 0.5 + 0.15);
        flukePos.push(
          (0.08 + span) * side,
          -0.02,
          len * 0.5 + 0.25 + Math.cos(t * Math.PI) * 0.35,
        );
      }
      for (let i = 0; i < segs; i++) {
        const a = cStart + i * 2;
        flukeIdx.push(a, a + 1, a + 2);
        flukeIdx.push(a + 2, a + 1, a + 3);
      }
    }
    {
      const segs = 10;
      const start = flukePos.length / 3;
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        flukePos.push(-0.06, 0, len * 0.5 + 0.05 + t * 0.35);
        flukePos.push(0.06, 0, len * 0.5 + 0.05 + t * 0.35);
      }
      for (let i = 0; i < segs; i++) {
        const a = start + i * 2;
        flukeIdx.push(a, a + 1, a + 2);
        flukeIdx.push(a + 2, a + 1, a + 3);
      }
    }
  }

  const flukes = new THREE.BufferGeometry();
  flukes.setAttribute("position", new THREE.Float32BufferAttribute(flukePos, 3));
  flukes.setIndex(flukeIdx);
  flukes.computeVertexNormals();

  // Detail: blowhole, eyes, smile, melon crease, mouth
  const dPos: number[] = [];
  const dIdx: number[] = [];

  {
    const segs = 14;
    const cx = 0;
    const cy = 0.38;
    const cz = -1.75;
    const start = dPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      dPos.push(cx, cy, cz);
      dPos.push(cx + Math.cos(a) * 0.1, cy + 0.04, cz + Math.sin(a) * 0.07);
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      dIdx.push(a, a + 1, a + 2);
      dIdx.push(a + 2, a + 1, a + 3);
    }
    const rStart = dPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      dPos.push(cx + Math.cos(a) * 0.1, cy + 0.04, cz + Math.sin(a) * 0.07);
      dPos.push(cx + Math.cos(a) * 0.14, cy + 0.02, cz + Math.sin(a) * 0.1);
    }
    for (let i = 0; i < segs; i++) {
      const a = rStart + i * 2;
      dIdx.push(a, a + 1, a + 2);
      dIdx.push(a + 2, a + 1, a + 3);
    }
  }

  for (const side of [-1, 1] as const) {
    const segs = 14;
    const cx = side * 0.38;
    const cy = 0.08;
    const cz = -1.95;
    const start = dPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      dPos.push(cx, cy, cz);
      dPos.push(
        cx + Math.cos(a) * 0.07 * side * 0.35 + Math.cos(a) * 0.015,
        cy + Math.sin(a) * 0.065,
        cz + Math.cos(a) * 0.05,
      );
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      dIdx.push(a, a + 1, a + 2);
      dIdx.push(a + 2, a + 1, a + 3);
    }
  }

  for (const side of [-1, 1] as const) {
    const segs = 16;
    const start = dPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const z = -2.35 + t * 0.55;
      const y = -0.12 + Math.sin(t * Math.PI) * 0.06;
      const x = side * (0.22 + t * 0.12);
      dPos.push(x, y, z);
      dPos.push(x * 1.05, y - 0.03, z + 0.02);
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      dIdx.push(a, a + 1, a + 2);
      dIdx.push(a + 2, a + 1, a + 3);
    }
  }

  {
    const segs = 12;
    const start = dPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const a = -0.7 + t * 1.4;
      const x = Math.sin(a) * 0.22;
      const y = 0.18 + Math.cos(a) * 0.08;
      const z = -2.15;
      dPos.push(x * 0.85, y + 0.04, z);
      dPos.push(x, y, z + 0.04);
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      dIdx.push(a, a + 1, a + 2);
      dIdx.push(a + 2, a + 1, a + 3);
    }
  }

  {
    const segs = 18;
    const start = dPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const a = -Math.PI * 0.45 + t * Math.PI * 0.9;
      const x = Math.sin(a) * 0.14;
      const y = -0.1 + Math.cos(a) * 0.02;
      const z = -2.55 + Math.abs(Math.sin(a)) * 0.08;
      dPos.push(x * 0.75, y + 0.03, z + 0.05);
      dPos.push(x, y, z);
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      dIdx.push(a, a + 1, a + 2);
      dIdx.push(a + 2, a + 1, a + 3);
    }
  }

  for (const side of [-1, 1] as const) {
    const segs = 30;
    const start = dPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const u = 0.12 + t * 0.72;
      const z = (u - 0.5) * len;
      const r = bodyRadius(u) * bodyWidthScale(u);
      dPos.push(side * r * 0.97, 0.01, z);
      dPos.push(side * r * 1.01, 0.01, z + 0.035);
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      dIdx.push(a, a + 1, a + 2);
      dIdx.push(a + 2, a + 1, a + 3);
    }
  }

  const detail = new THREE.BufferGeometry();
  detail.setAttribute("position", new THREE.Float32BufferAttribute(dPos, 3));
  detail.setIndex(dIdx);
  detail.computeVertexNormals();

  void seed;
  return { body, fins, detail, flukes };
}

/* ── Soft lattice ──────────────────────────────────────────────── */

function buildSoftLattice(): {
  particles: SoftParticle[];
  springs: SoftSpring[];
  spineCount: number;
  radial: number;
} {
  const len = BODY_LEN;
  const spineCount = 20;
  const radial = 12;
  const particles: SoftParticle[] = [];
  const springs: SoftSpring[] = [];

  for (let s = 0; s < spineCount; s++) {
    const u = s / (spineCount - 1);
    const z = (u - 0.5) * len;
    const r = bodyRadius(u) * 0.94;
    const hy = bodyHeightScale(u);
    const hx = bodyWidthScale(u);
    particles.push(makeParticle(0, 0, z, s === 0));
    for (let k = 0; k < radial; k++) {
      const a = (k / radial) * Math.PI * 2;
      particles.push(
        makeParticle(Math.cos(a) * r * hx, Math.sin(a) * r * hy, z, false),
      );
    }
  }

  const ringSize = 1 + radial;
  const dist = (i: number, j: number) => {
    const a = particles[i]!;
    const b = particles[j]!;
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  };
  const addSpring = (a: number, b: number, stiff: number) => {
    springs.push({ a, b, rest: dist(a, b), stiff });
  };

  for (let s = 0; s < spineCount; s++) {
    const base = s * ringSize;
    for (let k = 0; k < radial; k++) {
      addSpring(base, base + 1 + k, 0.9);
      addSpring(base + 1 + k, base + 1 + ((k + 1) % radial), 0.8);
      addSpring(base + 1 + k, base + 1 + ((k + 2) % radial), 0.5);
      addSpring(base + 1 + k, base + 1 + ((k + 3) % radial), 0.34);
    }
    if (s < spineCount - 1) {
      const next = (s + 1) * ringSize;
      addSpring(base, next, 0.97);
      for (let k = 0; k < radial; k++) {
        addSpring(base + 1 + k, next + 1 + k, 0.74);
        addSpring(base + 1 + k, next + 1 + ((k + 1) % radial), 0.44);
        addSpring(base + 1 + k, next, 0.4);
      }
    }
    if (s < spineCount - 2) {
      addSpring(base, (s + 2) * ringSize, 0.58);
    }
  }

  return { particles, springs, spineCount, radial };
}

function bindMeshToLattice(
  restVerts: Float32Array,
  particles: SoftParticle[],
  spineCount: number,
  radial: number,
): { influence: Uint16Array; weights: Float32Array } {
  const vCount = restVerts.length / 3;
  const influence = new Uint16Array(vCount * 4);
  const weights = new Float32Array(vCount * 4);
  const ringSize = 1 + radial;
  const tmp: { i: number; d: number }[] = [];
  const len = BODY_LEN;

  for (let v = 0; v < vCount; v++) {
    const x = restVerts[v * 3]!;
    const y = restVerts[v * 3 + 1]!;
    const z = restVerts[v * 3 + 2]!;
    tmp.length = 0;
    const u = THREE.MathUtils.clamp(z / len + 0.5, 0, 1);
    const s0 = Math.floor(u * (spineCount - 1));
    for (let s = Math.max(0, s0 - 1); s <= Math.min(spineCount - 1, s0 + 1); s++) {
      const base = s * ringSize;
      for (let p = 0; p < ringSize; p++) {
        const pr = particles[base + p]!;
        const d = Math.hypot(x - pr.x, y - pr.y, z - pr.z) + 1e-4;
        tmp.push({ i: base + p, d });
      }
    }
    tmp.sort((a, b) => a.d - b.d);
    let wsum = 0;
    for (let k = 0; k < 4; k++) {
      const t = tmp[k] ?? tmp[tmp.length - 1]!;
      const w = 1 / (t.d * t.d);
      influence[v * 4 + k] = t.i;
      weights[v * 4 + k] = w;
      wsum += w;
    }
    for (let k = 0; k < 4; k++) weights[v * 4 + k]! /= wsum;
  }
  return { influence, weights };
}

function createDolphin(id: number): DolphinSim {
  const seed = id * 19.3 + 8.2;
  const { body, fins, detail, flukes } = buildDolphinGeometry(seed);
  const lattice = buildSoftLattice();

  const restVerts = new Float32Array(
    (body.attributes.position as THREE.BufferAttribute).array as Float32Array,
  );
  const finRest = new Float32Array(
    (fins.attributes.position as THREE.BufferAttribute).array as Float32Array,
  );
  const detailRest = new Float32Array(
    (detail.attributes.position as THREE.BufferAttribute).array as Float32Array,
  );
  const flukeRest = new Float32Array(
    (flukes.attributes.position as THREE.BufferAttribute).array as Float32Array,
  );

  const bind = bindMeshToLattice(
    restVerts,
    lattice.particles,
    lattice.spineCount,
    lattice.radial,
  );
  const finBind = bindMeshToLattice(
    finRest,
    lattice.particles,
    lattice.spineCount,
    lattice.radial,
  );
  const detailBind = bindMeshToLattice(
    detailRest,
    lattice.particles,
    lattice.spineCount,
    lattice.radial,
  );
  const flukeBind = bindMeshToLattice(
    flukeRest,
    lattice.particles,
    lattice.spineCount,
    lattice.radial,
  );

  const scale = 0.95 + seeded(seed) * 0.28;
  const angle = (id / DOLPHIN_COUNT) * Math.PI * 2 + seeded(seed + 1) * 0.5 - 0.4;
  const radius = 4 + seeded(seed + 2) * 3.2;
  const pos = new THREE.Vector3(
    Math.cos(angle) * radius + 1.5,
    4.2 + seeded(seed + 3) * 2.2,
    Math.sin(angle) * radius * 0.65 - 1.5,
  );
  const yaw = angle + Math.PI * 0.5;
  const heading = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const baseSpeed = 1.35 + seeded(seed + 5) * 0.45;

  const mesh = new THREE.Mesh(body, BODY_MAT);
  mesh.scale.setScalar(scale);
  mesh.frustumCulled = false;

  const finMesh = new THREE.Mesh(fins, FIN_MAT);
  finMesh.scale.setScalar(scale);
  finMesh.frustumCulled = false;

  const detailMesh = new THREE.Mesh(detail, DETAIL_MAT);
  detailMesh.scale.setScalar(scale);
  detailMesh.frustumCulled = false;

  const flukeMesh = new THREE.Mesh(flukes, FLUKE_MAT);
  flukeMesh.scale.setScalar(scale);
  flukeMesh.frustumCulled = false;

  return {
    id,
    mesh,
    finMesh,
    detailMesh,
    flukeMesh,
    particles: lattice.particles,
    springs: lattice.springs,
    spineCount: lattice.spineCount,
    radial: lattice.radial,
    restVerts,
    influence: bind.influence,
    weights: bind.weights,
    finRest,
    finInfluence: finBind.influence,
    finWeights: finBind.weights,
    detailRest,
    detailInfluence: detailBind.influence,
    detailWeights: detailBind.weights,
    flukeRest,
    flukeInfluence: flukeBind.influence,
    flukeWeights: flukeBind.weights,
    pos,
    vel: heading.clone().multiplyScalar(baseSpeed),
    heading,
    yaw,
    pitch: 0,
    speed: baseSpeed,
    baseSpeed,
    phase: seeded(seed + 6) * Math.PI * 2,
    scale,
    alarm: 0,
    curiosity: 0.4 + seeded(seed + 8) * 0.4,
    podAngle: angle,
    smile: 0.3,
  };
}

/* ── Soft-body: DORSOVENTRAL undulation (cetacean fluke drive) ──── */

const _diff = new THREE.Vector3();

function stepSoftBody(d: DolphinSim, dt: number, swimAmp: number, t: number) {
  const particles = d.particles;
  const ringSize = 1 + d.radial;
  const damp = Math.pow(0.91, dt * 60);

  for (let s = 0; s < d.spineCount; s++) {
    const u = s / (d.spineCount - 1);
    const tailWeight = Math.pow(u, 1.55);
    const wave =
      Math.sin(u * 3.8 - t * 5.2 + d.phase) *
      swimAmp *
      (0.12 + tailWeight * 1.75);
    const base = s * ringSize;
    const p = particles[base]!;
    if (!p.pinned) {
      p.y += wave * dt * 2.6;
    }
    for (let k = 0; k < d.radial; k++) {
      const q = particles[base + 1 + k]!;
      q.y += wave * dt * 2.3;
      q.x +=
        Math.sin(u * 2.2 - t * 3.5 + d.phase) *
        swimAmp *
        0.1 *
        tailWeight *
        dt;
    }
  }

  if (d.smile > 0.2 && d.alarm < 0.35) {
    for (let s = 0; s < 3; s++) {
      const base = s * ringSize;
      for (let k = 0; k < d.radial; k++) {
        const a = (k / d.radial) * Math.PI * 2;
        if (Math.sin(a) < -0.15) {
          const q = particles[base + 1 + k]!;
          q.y -= d.smile * 0.04 * dt * 4;
        }
      }
    }
  }

  for (const p of particles) {
    if (p.pinned) {
      p.px = p.x;
      p.py = p.y;
      p.pz = p.z;
      continue;
    }
    const vx = (p.x - p.px) * damp;
    const vy = (p.y - p.py) * damp;
    const vz = (p.z - p.pz) * damp;
    p.px = p.x;
    p.py = p.y;
    p.pz = p.z;
    p.x += vx;
    p.y += vy;
    p.z += vz;
  }

  for (let iter = 0; iter < SOFT_ITERS; iter++) {
    for (const s of d.springs) {
      const a = particles[s.a]!;
      const b = particles[s.b]!;
      _diff.set(b.x - a.x, b.y - a.y, b.z - a.z);
      const dist = _diff.length() || 1e-6;
      const corr = ((dist - s.rest) / dist) * 0.5 * s.stiff;
      if (!a.pinned) {
        a.x += _diff.x * corr;
        a.y += _diff.y * corr;
        a.z += _diff.z * corr;
      }
      if (!b.pinned) {
        b.x -= _diff.x * corr;
        b.y -= _diff.y * corr;
        b.z -= _diff.z * corr;
      }
    }

    for (let s = 0; s < d.spineCount; s++) {
      const u = s / (d.spineCount - 1);
      const z = (u - 0.5) * BODY_LEN;
      const r = bodyRadius(u) * 0.94;
      const hy = bodyHeightScale(u);
      const hx = bodyWidthScale(u);
      const base = s * ringSize;
      const center = particles[base]!;
      const retain = u < 0.3 ? 0.15 : 0.07;
      if (!center.pinned) {
        center.x += (0 - center.x) * retain;
        center.y += (0 - center.y) * retain;
        center.z += (z - center.z) * retain;
      } else {
        center.x = 0;
        center.y = 0;
        center.z = z;
      }
      for (let k = 0; k < d.radial; k++) {
        const a = (k / d.radial) * Math.PI * 2;
        const q = particles[base + 1 + k]!;
        const rx = Math.cos(a) * r * hx;
        const ry = Math.sin(a) * r * hy;
        q.x += (rx - q.x) * 0.065;
        q.y += (ry - q.y) * 0.065;
        q.z += (z - q.z) * 0.065;
      }
    }
  }
}

function deformMeshFromLattice(
  posAttr: THREE.BufferAttribute,
  rest: Float32Array,
  particles: SoftParticle[],
  influence: Uint16Array,
  weights: Float32Array,
  restLattice: { x: number; y: number; z: number }[],
) {
  const arr = posAttr.array as Float32Array;
  const vCount = rest.length / 3;
  for (let v = 0; v < vCount; v++) {
    const rx = rest[v * 3]!;
    const ry = rest[v * 3 + 1]!;
    const rz = rest[v * 3 + 2]!;
    let dx = 0;
    let dy = 0;
    let dz = 0;
    for (let k = 0; k < 4; k++) {
      const pi = influence[v * 4 + k]!;
      const w = weights[v * 4 + k]!;
      const p = particles[pi]!;
      const r = restLattice[pi]!;
      dx += (p.x - r.x) * w;
      dy += (p.y - r.y) * w;
      dz += (p.z - r.z) * w;
    }
    arr[v * 3] = rx + dx;
    arr[v * 3 + 1] = ry + dy;
    arr[v * 3 + 2] = rz + dz;
  }
  posAttr.needsUpdate = true;
}

/* ── AI: curious about pointer / flee sharks ───────────────────── */

const _steer = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _look = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _pointerWorld = new THREE.Vector3();
const _ndc = new THREE.Vector3();
const _plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -4.5);
const _raycaster = new THREE.Raycaster();

function nearestSharkDist(from: THREE.Vector3): number {
  let best = Infinity;
  for (const p of sharkWorldPositions) {
    const d2 = from.distanceToSquared(p);
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

function nearestSharkPos(from: THREE.Vector3): THREE.Vector3 | null {
  let best: THREE.Vector3 | null = null;
  let bestD = Infinity;
  for (const p of sharkWorldPositions) {
    const d2 = from.distanceToSquared(p);
    if (d2 < bestD) {
      bestD = d2;
      best = p;
    }
  }
  return best;
}

function projectPointer(
  pointer: THREE.Vector2,
  camera: THREE.Camera,
  out: THREE.Vector3,
): boolean {
  _raycaster.setFromCamera(pointer, camera);
  const hit = _raycaster.ray.intersectPlane(_plane, out);
  if (!hit) {
    // Fallback: unproject at fixed depth if ray is parallel to plane
    _ndc.set(pointer.x, pointer.y, 0.5).unproject(camera);
    out.copy(_ndc);
    out.y = 4.5;
  }
  return true;
}

function aiStep(
  dolphins: DolphinSim[],
  dt: number,
  pointerWorld: THREE.Vector3 | null,
) {
  for (const d of dolphins) {
    _steer.set(0, 0, 0);

    const sharkDist = nearestSharkDist(d.pos);
    const shark = nearestSharkPos(d.pos);
    let threat = 0;
    if (Number.isFinite(sharkDist) && sharkDist < SHARK_ALARM_RANGE) {
      threat =
        1 -
        THREE.MathUtils.smoothstep(sharkDist, SHARK_PANIC_RANGE, SHARK_ALARM_RANGE);
      if (sharkDist < SHARK_PANIC_RANGE) threat = 1;
    }
    d.alarm = THREE.MathUtils.lerp(d.alarm, threat, dt * 3.5);

    if (d.alarm > 0.35 && shark) {
      _tmp.copy(d.pos).sub(shark).normalize();
      _tmp.y += 0.25;
      _tmp.normalize();
      _steer.addScaledVector(_tmp, 2.8 + d.alarm * 1.6);
      _tmp.set(
        Math.sin(d.phase * 2.1) * 0.7,
        Math.cos(d.phase * 1.7) * 0.35,
        Math.cos(d.phase * 1.9) * 0.7,
      );
      _steer.addScaledVector(_tmp, d.alarm * 0.9);
      d.smile = THREE.MathUtils.lerp(d.smile, 0.05, dt * 4);
      d.curiosity = THREE.MathUtils.lerp(d.curiosity, 0.1, dt * 2);
    } else if (pointerWorld && d.alarm < 0.4) {
      const toPtr = _tmp.copy(pointerWorld).sub(d.pos);
      const dist = toPtr.length() || 1e-6;
      toPtr.multiplyScalar(1 / dist);

      if (dist < CURIOUS_RANGE) {
        d.curiosity = THREE.MathUtils.lerp(d.curiosity, 1, dt * 1.5);
        if (dist > 2.2) {
          _steer.addScaledVector(toPtr, 1.35 * d.curiosity);
        } else {
          _tmp.set(-toPtr.z, 0.15, toPtr.x).normalize();
          _steer.addScaledVector(_tmp, 1.1);
          _steer.addScaledVector(toPtr, (dist - 1.6) * 0.4);
        }
        _steer.y +=
          THREE.MathUtils.clamp(pointerWorld.y - d.pos.y, -1.2, 1.2) * 0.4;
        d.smile = THREE.MathUtils.lerp(d.smile, 0.85, dt * 2);
      } else {
        d.curiosity = THREE.MathUtils.lerp(d.curiosity, 0.35, dt);
        d.podAngle += dt * 0.22;
        const px = Math.cos(d.podAngle + d.id * 0.9) * 6.5;
        const pz = Math.sin(d.podAngle + d.id * 0.9) * 5.2 - 1.5;
        _tmp.set(px - d.pos.x, 0, pz - d.pos.z);
        const pd = _tmp.length() || 1;
        _tmp.multiplyScalar(1 / pd);
        _steer.addScaledVector(_tmp, 0.65);
        _tmp.copy(pointerWorld).sub(d.pos).normalize();
        _steer.addScaledVector(_tmp, 0.25 * d.curiosity);
        d.smile = THREE.MathUtils.lerp(d.smile, 0.4, dt);
      }
    } else {
      d.podAngle += dt * 0.2;
      const px = Math.cos(d.podAngle + d.id * 0.9) * 7;
      const pz = Math.sin(d.podAngle + d.id * 0.9) * 5.5 - 1.5;
      _tmp.set(px - d.pos.x, 0, pz - d.pos.z);
      const pd = _tmp.length() || 1;
      _tmp.multiplyScalar(1 / pd);
      _steer.addScaledVector(_tmp, 0.55);
      _tmp.set(
        Math.sin(d.phase * 0.35) * 0.25,
        Math.sin(d.phase * 0.28) * 0.3,
        Math.cos(d.phase * 0.32) * 0.25,
      );
      _steer.addScaledVector(_tmp, 0.35);
      d.smile = THREE.MathUtils.lerp(d.smile, 0.35, dt);
    }

    for (const o of dolphins) {
      if (o.id === d.id) continue;
      const d2 = d.pos.distanceToSquared(o.pos);
      if (d2 < 9 && d2 > 1e-6) {
        _tmp.copy(d.pos).sub(o.pos).normalize();
        _steer.addScaledVector(_tmp, 0.9);
      } else if (d2 > 100 && d2 < 400) {
        _tmp.copy(o.pos).sub(d.pos).normalize();
        _steer.addScaledVector(_tmp, 0.2);
      }
    }

    const yMin = SEABED_Y + 2.4;
    const yMax = SURFACE_Y - 4.5;
    if (d.pos.y < yMin) _steer.y += (yMin - d.pos.y) * 1.2;
    if (d.pos.y > yMax) _steer.y -= (d.pos.y - yMax) * 1.2;
    _steer.y += (4.5 - d.pos.y) * 0.035;

    if (d.pos.x < -18) _steer.x += 1.2;
    if (d.pos.x > 18) _steer.x -= 1.2;
    if (d.pos.z < -20) _steer.z += 1.1;
    if (d.pos.z > 10) _steer.z -= 0.9;

    const fleeing = d.alarm > 0.35;
    const curiousBoost = d.curiosity > 0.6 && !fleeing ? 1.15 : 1;
    const targetSpeed =
      d.baseSpeed * (fleeing ? 2.15 : 1) * curiousBoost * (0.95 + d.alarm * 0.2);
    const maxSp = fleeing
      ? Math.min(targetSpeed * 1.35, 3.6)
      : Math.min(targetSpeed * 1.25, 2.4);
    const minSp = targetSpeed * 0.5;

    d.vel.addScaledVector(_steer, dt * (fleeing ? 2.4 : 1.8));
    const sp = d.vel.length() || 1e-6;
    if (sp > maxSp) d.vel.multiplyScalar(maxSp / sp);
    else if (sp < minSp) d.vel.multiplyScalar(minSp / sp);

    d.pos.addScaledVector(d.vel, dt);
    d.speed = d.vel.length();
    d.heading.copy(d.vel).normalize();
    d.yaw = Math.atan2(-d.heading.x, -d.heading.z);
    d.pitch = Math.asin(THREE.MathUtils.clamp(d.heading.y, -0.6, 0.6));
    d.phase += dt * (3.4 + d.speed * 2.2 + d.alarm * 1.5);
  }
}

function orientDolphin(mesh: THREE.Object3D, heading: THREE.Vector3, bank: number) {
  _fwd.copy(heading).normalize();
  _look.copy(mesh.position).sub(_fwd);
  mesh.lookAt(_look);
  mesh.rotateZ(bank);
}

/* ── React component ───────────────────────────────────────────── */

export function BottlenoseDolphins() {
  const group = useRef<THREE.Group>(null);
  const { camera } = useThree();

  const dolphins = useMemo(() => {
    const list: DolphinSim[] = [];
    for (let i = 0; i < DOLPHIN_COUNT; i++) list.push(createDolphin(i));
    return list;
  }, []);

  const restLattices = useMemo(() => {
    return dolphins.map((d) => d.particles.map((p) => ({ x: p.x, y: p.y, z: p.z })));
  }, [dolphins]);

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const t = state.clock.elapsedTime;

    projectPointer(state.pointer, camera, _pointerWorld);
    _pointerWorld.x = THREE.MathUtils.clamp(_pointerWorld.x, -16, 16);
    _pointerWorld.z = THREE.MathUtils.clamp(_pointerWorld.z, -18, 8);
    _pointerWorld.y = THREE.MathUtils.clamp(
      _pointerWorld.y,
      SEABED_Y + 2.5,
      SURFACE_Y - 5,
    );

    registerDolphinPositions(dolphins.map((d) => d.pos));
    aiStep(dolphins, dt, _pointerWorld);

    for (let i = 0; i < dolphins.length; i++) {
      const d = dolphins[i]!;
      const fleeing = d.alarm > 0.35;
      const swimAmp =
        0.08 + d.speed * 0.055 + (fleeing ? 0.06 : 0) + d.curiosity * 0.02;

      stepSoftBody(d, dt, swimAmp, t + d.phase * 0.08);

      const bodyPos = d.mesh.geometry.attributes.position as THREE.BufferAttribute;
      deformMeshFromLattice(
        bodyPos,
        d.restVerts,
        d.particles,
        d.influence,
        d.weights,
        restLattices[i]!,
      );

      const finPos = d.finMesh.geometry.attributes.position as THREE.BufferAttribute;
      deformMeshFromLattice(
        finPos,
        d.finRest,
        d.particles,
        d.finInfluence,
        d.finWeights,
        restLattices[i]!,
      );

      const detPos = d.detailMesh.geometry.attributes
        .position as THREE.BufferAttribute;
      deformMeshFromLattice(
        detPos,
        d.detailRest,
        d.particles,
        d.detailInfluence,
        d.detailWeights,
        restLattices[i]!,
      );

      const flukePos = d.flukeMesh.geometry.attributes
        .position as THREE.BufferAttribute;
      deformMeshFromLattice(
        flukePos,
        d.flukeRest,
        d.particles,
        d.flukeInfluence,
        d.flukeWeights,
        restLattices[i]!,
      );

      d.mesh.position.copy(d.pos);
      d.finMesh.position.copy(d.pos);
      d.detailMesh.position.copy(d.pos);
      d.flukeMesh.position.copy(d.pos);

      const bank = THREE.MathUtils.clamp(
        -d.heading.x * 0.4 +
          d.vel.x * 0.025 +
          d.alarm * Math.sin(d.phase) * 0.08,
        -0.35,
        0.35,
      );
      orientDolphin(d.mesh, d.heading, bank);
      d.finMesh.quaternion.copy(d.mesh.quaternion);
      d.detailMesh.quaternion.copy(d.mesh.quaternion);
      d.flukeMesh.quaternion.copy(d.mesh.quaternion);
    }
  });

  return (
    <group ref={group}>
      {dolphins.map((d) => (
        <group key={d.id}>
          <primitive object={d.mesh} />
          <primitive object={d.finMesh} />
          <primitive object={d.detailMesh} />
          <primitive object={d.flukeMesh} />
        </group>
      ))}
    </group>
  );
}
