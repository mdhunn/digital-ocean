import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import {
  registerDolphinPositions,
  sharkWorldPositions,
} from "./creatureRegistry";

/**
 * High-polygon bottlenose dolphins (Tursiops truncatus).
 *
 * Snout (rostrum) notes — common failure modes fixed here:
 *  - Long slender parallel-sided beak (~16% body length), not a blunt cone
 *  - Dorsoventrally flattened oval (wide > tall), not tall/narrow
 *  - Head rings pinned + strong retention so soft-body cannot squash the beak
 *  - Clean tapered tip cap (no disconnected tip-ring junk)
 *  - Clear upper/lower jaw with gape crease
 */

const SURFACE_Y = 12;
const SEABED_Y = -1.5;
const DOLPHIN_COUNT = 4;
const SPINE_LEN = 56;
const RADIAL = 40;
const SOFT_ITERS = 4;
const BODY_LEN = 5.4;
/** Rostrum ends / melon begins (fraction of body length) */
const ROSTRUM_END = 0.155;
/** Head soft-body freeze (pin + no undulation) */
const HEAD_FREEZE_U = 0.22;

/* ── wireframe materials ───────────────────────────────────────── */

const BODY_MAT = new THREE.MeshBasicMaterial({
  vertexColors: true,
  wireframe: true,
  transparent: true,
  opacity: 0.98,
  depthWrite: false,
});

const FIN_MAT = new THREE.MeshBasicMaterial({
  color: new THREE.Color("#7a929e"),
  wireframe: true,
  transparent: true,
  opacity: 0.96,
  depthWrite: false,
  side: THREE.DoubleSide,
});

const DETAIL_MAT = new THREE.MeshBasicMaterial({
  color: new THREE.Color("#c4d8e4"),
  wireframe: true,
  transparent: true,
  opacity: 0.93,
  depthWrite: false,
  side: THREE.DoubleSide,
});

const FLUKE_MAT = new THREE.MeshBasicMaterial({
  color: new THREE.Color("#8aa0ac"),
  wireframe: true,
  transparent: true,
  opacity: 0.97,
  depthWrite: false,
  side: THREE.DoubleSide,
});

function seeded(n: number) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/* ── Anatomical profile ──────────────────────────────────────────
 * Rostrum: near-constant slender radius from tip→melon (tube, not cone).
 * Melon: rapid dorsal swell. Midbody fusiform. Peduncle tall+narrow.
 */

function bodyRadius(u: number): number {
  // ── ROSTRUM: long, slender, almost parallel (slight tip taper only)
  if (u < 0.02) return 0.055 + u * 1.8; // soft tip start
  if (u < ROSTRUM_END) {
    // gently grow along the beak — still clearly a tube
    const t = (u - 0.02) / (ROSTRUM_END - 0.02);
    return 0.091 + t * 0.055; // ~0.09 → ~0.146
  }
  // Melon / cranium — swell after beak (not before)
  if (u < 0.2) {
    const t = (u - ROSTRUM_END) / (0.2 - ROSTRUM_END);
    return 0.146 + t * 0.32; // → ~0.466
  }
  if (u < 0.28) return 0.466 + (u - 0.2) * 2.2;
  if (u < 0.4) return 0.642 + (u - 0.28) * 1.05;
  if (u < 0.5) return 0.768 + (u - 0.4) * 0.2;
  if (u < 0.62) return 0.788 - (u - 0.5) * 0.55;
  if (u < 0.75) return 0.722 - (u - 0.62) * 1.45;
  if (u < 0.88) return 0.533 - (u - 0.75) * 2.05;
  if (u < 0.96) return 0.267 - (u - 0.88) * 1.35;
  return 0.159 - (u - 0.96) * 0.9;
}

/** Vertical scale — snout FLAT (short), melon tall, peduncle tall */
function bodyHeightScale(u: number): number {
  if (u < ROSTRUM_END) {
    // Strong dorsoventral flattening of the beak
    const t = u / ROSTRUM_END;
    return 0.48 + t * 0.14; // ~0.48–0.62  (much flatter than midbody)
  }
  if (u < 0.2) {
    // Melon rises quickly after beak
    const t = (u - ROSTRUM_END) / (0.2 - ROSTRUM_END);
    return 0.62 + t * 0.42; // → ~1.04
  }
  if (u < 0.28) return 1.04 + (u - 0.2) * 0.4;
  if (u < 0.5) return 1.072 + (u - 0.28) * 0.18;
  if (u < 0.7) return 1.112 - (u - 0.5) * 0.12;
  if (u < 0.88) return 1.088 + (u - 0.7) * 0.3;
  return 1.142 + (u - 0.88) * 0.35;
}

/** Lateral scale — snout relatively WIDE vs height (oval beak) */
function bodyWidthScale(u: number): number {
  if (u < ROSTRUM_END) {
    // Beak wider than tall — classic bottlenose rostrum oval
    const t = u / ROSTRUM_END;
    return 0.95 + t * 0.08; // ~0.95–1.03
  }
  if (u < 0.22) return 1.03 - (u - ROSTRUM_END) * 0.3;
  if (u < 0.4) return 0.98 + (u - 0.22) * 0.05;
  if (u < 0.55) return 0.989;
  if (u < 0.75) return 0.989 - (u - 0.55) * 0.55;
  if (u < 0.9) return 0.879 - (u - 0.75) * 1.4;
  return 0.669 - (u - 0.9) * 1.2;
}

/**
 * Spine centerline Y:
 *  - Rostrum slightly below mid (jaws hang under melon line)
 *  - Melon lifts dorsal
 */
function spineYOffset(u: number): number {
  // Beak sits a touch low relative to melon
  if (u < ROSTRUM_END) {
    return -0.04 - (1 - u / ROSTRUM_END) * 0.02;
  }
  // Melon dome
  if (u < 0.26) {
    const t = (u - ROSTRUM_END) / (0.26 - ROSTRUM_END);
    return -0.04 + Math.sin(t * Math.PI) * 0.09;
  }
  const belly =
    u > 0.28 && u < 0.7 ? -Math.sin(((u - 0.28) / 0.42) * Math.PI) * 0.03 : 0;
  const ped = u > 0.8 ? (u - 0.8) * 0.05 : 0;
  return belly + ped;
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

function countershadeColor(y: number, r: number, u: number, out: THREE.Color) {
  const ny = y / Math.max(r, 0.04);
  if (ny < -0.22) {
    out.setRGB(0.9, 0.91, 0.93);
  } else if (ny < -0.02) {
    const t = (ny + 0.22) / 0.2;
    out.setRGB(0.9 - t * 0.2, 0.91 - t * 0.16, 0.93 - t * 0.12);
  } else if (ny < 0.28) {
    const t = (ny + 0.02) / 0.3;
    out.setRGB(0.7 - t * 0.16, 0.76 - t * 0.14, 0.82 - t * 0.12);
  } else if (ny < 0.55) {
    const t = (ny - 0.28) / 0.27;
    out.setRGB(0.54 - t * 0.12, 0.62 - t * 0.1, 0.7 - t * 0.1);
  } else {
    out.setRGB(0.36, 0.44, 0.52);
  }
  // Beak: slightly lighter / warmer grey
  if (u < ROSTRUM_END) {
    out.lerp(new THREE.Color(0.76, 0.8, 0.84), 0.35);
  }
  if (u > 0.38 && u < 0.58 && ny > 0.35) {
    out.lerp(new THREE.Color(0.3, 0.38, 0.46), 0.25);
  }
}

/* ── Body ring sample (shared by mesh + lattice) ───────────────── */

function sampleBodyRing(
  u: number,
  a: number,
  seed: number,
): { x: number; y: number; z: number; r: number; cy: number } {
  const len = BODY_LEN;
  const z = (u - 0.5) * len;
  const r = bodyRadius(u);
  const hy = bodyHeightScale(u);
  const hx = bodyWidthScale(u);
  const cy = spineYOffset(u);

  // Melon bulge (dorsal only, AFTER rostrum)
  let melon = 1;
  if (u > ROSTRUM_END && u < 0.26) {
    const mu = (u - ROSTRUM_END) / (0.26 - ROSTRUM_END);
    const dorsal = Math.max(0, Math.sin(a));
    melon = 1 + Math.sin(mu * Math.PI) * dorsal * dorsal * 0.28;
  }

  // Lower-jaw pad under beak — subtle, does not inflate the snout
  let chin = 1;
  if (u > 0.02 && u < ROSTRUM_END && Math.sin(a) < -0.25) {
    const cu = u / ROSTRUM_END;
    chin = 1 + Math.sin(cu * Math.PI) * Math.abs(Math.sin(a)) * 0.06;
  }

  // Jaw gape split: slight indent along mouth plane (horizontal seam)
  let gape = 1;
  if (u < ROSTRUM_END + 0.02) {
    // Mouth is near horizontal midline, slightly below center on a dolphin
    const mouthY = -0.12; // sin(a) ≈ mouthY when on gape
    const nearGape = 1 - Math.min(1, Math.abs(Math.sin(a) - mouthY) / 0.18);
    if (nearGape > 0) {
      gape = 1 - nearGape * nearGape * 0.08;
    }
  }

  // Eye socket indent
  let eyeSocket = 1;
  if (u > 0.17 && u < 0.23) {
    const eu = 1 - Math.abs(u - 0.2) / 0.03;
    const lat = Math.abs(Math.cos(a));
    if (lat > 0.65 && Math.abs(Math.sin(a)) < 0.5) {
      eyeSocket = 1 - eu * (lat - 0.65) * 0.4;
    }
  }

  // Flipper root bulge
  let flipperRoot = 1;
  if (u > 0.25 && u < 0.34) {
    const fu = 1 - Math.abs(u - 0.29) / 0.05;
    const lat = Math.abs(Math.cos(a));
    if (lat > 0.55 && Math.sin(a) < 0.2) {
      flipperRoot = 1 + fu * (lat - 0.55) * 0.22;
    }
  }

  // Soft belly fill (body only, not snout)
  const belly =
    u > ROSTRUM_END && Math.sin(a) < -0.15
      ? 0.93 + Math.abs(Math.sin(a)) * 0.04
      : 1;

  // Dorsal ridge (body)
  let ridge = 1;
  if (u > 0.32 && Math.sin(a) > 0.78) {
    ridge = 1 + (Math.sin(a) - 0.78) * 0.12;
  }

  // Rostrum: smooth oval — NO extra shape hacks that invert proportions
  // Superellipse squaring for a slightly boxier beak cross-section
  let ovalX = 1;
  let ovalY = 1;
  if (u < ROSTRUM_END) {
    // n=2.4 → slightly flatter sides than pure ellipse (beak looks solid)
    const n = 2.35;
    const ca = Math.abs(Math.cos(a));
    const sa = Math.abs(Math.sin(a));
    const superR =
      Math.pow(Math.pow(ca, n) + Math.pow(sa, n), 1 / n) || 1;
    // Normalize so max radius stays ~1
    ovalX = 1 / superR;
    ovalY = 1 / superR;
  }

  let px = Math.cos(a) * r * hx * belly * eyeSocket * flipperRoot * gape * ovalX;
  let py =
    Math.sin(a) * r * hy * melon * chin * ridge * eyeSocket * gape * ovalY + cy;

  // Micro noise — reduce on snout so beak stays clean
  const noiseAmt = u < ROSTRUM_END ? 0.003 : 0.008;
  const n =
    1 +
    Math.sin(a * 6 + u * 13 + seed) * noiseAmt +
    Math.sin(a * 15 - u * 9) * noiseAmt * 0.6;

  return { x: px * n, y: py * n, z, r: r * hy, cy };
}

/* ── High-poly body geometry ───────────────────────────────────── */

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

  // Extra density bias: more rings dedicated to the snout via non-linear u
  for (let s = 0; s <= spineN; s++) {
    const sNorm = s / spineN;
    // Map more segments into the rostrum (first ~28% of rings cover ROSTRUM_END)
    let u: number;
    if (sNorm < 0.28) {
      u = (sNorm / 0.28) * ROSTRUM_END;
    } else {
      u = ROSTRUM_END + ((sNorm - 0.28) / 0.72) * (1 - ROSTRUM_END);
    }

    for (let k = 0; k <= radN; k++) {
      const a = (k / radN) * Math.PI * 2;
      const p = sampleBodyRing(u, a, seed);
      positions.push(p.x, p.y, p.z);
      countershadeColor(p.y - p.cy, p.r, u, col);
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

  // Clean snout tip: single apex slightly ahead of first ring, matching oval
  // First ring is at u=0 → z = -len/2, y ≈ spineYOffset(0)
  {
    const tipZ = -len * 0.5 - 0.12;
    const tipY = spineYOffset(0) - 0.015; // slight downturn
    const tip = positions.length / 3;
    positions.push(0, tipY, tipZ);
    colors.push(0.8, 0.84, 0.88);

    // Fan from tip to first ring (index 0..radN)
    for (let k = 0; k < radN; k++) {
      indices.push(tip, k + 1, k);
    }

    // Intermediate cap ring for rounded (not pointy cone) tip
    const midU = 0.008;
    const midZ = (midU - 0.5) * len - 0.04;
    const midRing = positions.length / 3;
    for (let k = 0; k < radN; k++) {
      const a = (k / radN) * Math.PI * 2;
      // Half-size oval at tip
      const p = sampleBodyRing(0.01, a, seed);
      positions.push(p.x * 0.55, p.y * 0.55 + tipY * 0.2, midZ);
      colors.push(0.79, 0.83, 0.87);
    }
    for (let k = 0; k < radN; k++) {
      const k1 = (k + 1) % radN;
      // tip → mid ring
      indices.push(tip, midRing + k1, midRing + k);
      // mid ring → first body ring
      indices.push(midRing + k, midRing + k1, k);
      indices.push(midRing + k1, k1, k);
    }
  }

  const body = new THREE.BufferGeometry();
  body.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  body.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  body.setIndex(indices);
  body.computeVertexNormals();

  /* ── Fins ────────────────────────────────────────────────────── */

  const finPos: number[] = [];
  const finIdx: number[] = [];

  const pushRibbon = (
    root: (t: number) => [number, number, number],
    tipFn: (t: number) => [number, number, number],
    segs: number,
  ) => {
    const start = finPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const [rx, ry, rz] = root(t);
      const [tx, ty, tz] = tipFn(t);
      finPos.push(rx, ry, rz);
      finPos.push(tx, ty, tz);
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      finIdx.push(a, a + 1, a + 2);
      finIdx.push(a + 2, a + 1, a + 3);
    }
  };

  // Dorsal fin
  {
    const baseZ0 = -0.2;
    const baseZ1 = 0.95;
    const baseY = 0.58;
    const height = 1.05;
    const segs = 28;
    pushRibbon(
      (t) => {
        const z = THREE.MathUtils.lerp(baseZ0, baseZ1, t);
        return [0, baseY - Math.sin(t * Math.PI) * 0.04, z];
      },
      (t) => {
        let edge: number;
        if (t < 0.32) edge = Math.pow(t / 0.32, 0.72);
        else if (t < 0.55) edge = 1 - (t - 0.32) * 0.08;
        else edge = 0.978 * Math.pow(1 - (t - 0.55) / 0.45, 1.35);
        const tipLean = Math.pow(t, 1.1) * 0.32;
        return [
          0.018,
          baseY + height * edge,
          THREE.MathUtils.lerp(baseZ0, baseZ1, t) + tipLean,
        ];
      },
      segs,
    );
    pushRibbon(
      (t) => [0.04, baseY + 0.06, THREE.MathUtils.lerp(baseZ0, baseZ1, t)],
      (t) => {
        let edge: number;
        if (t < 0.32) edge = Math.pow(t / 0.32, 0.72);
        else if (t < 0.55) edge = 1 - (t - 0.32) * 0.08;
        else edge = 0.978 * Math.pow(1 - (t - 0.55) / 0.45, 1.35);
        return [
          0.012,
          baseY + height * edge * 0.72,
          THREE.MathUtils.lerp(baseZ0, baseZ1, t) + Math.pow(t, 1.1) * 0.28,
        ];
      },
      segs,
    );
  }

  // Pectorals
  for (const side of [-1, 1] as const) {
    const segs = 26;
    const rootZ = -1.15;
    const rootY = -0.1;
    const rootX = 0.42;
    pushRibbon(
      (t) => [rootX * side * (0.95 + t * 0.05), rootY - t * 0.04, rootZ + t * 0.35],
      (t) => {
        const span = Math.sin(t * Math.PI * 0.88) * 1.25 * (1 - t * 0.08);
        const sweep = t * 0.72;
        const droop = t * 0.48 + span * 0.1;
        return [
          (rootX + span) * side,
          rootY - droop,
          rootZ + sweep - (1 - t) * 0.12 + t * 0.15,
        ];
      },
      segs,
    );
    pushRibbon(
      (t) => [rootX * 1.05 * side, rootY - 0.02, rootZ + 0.12 + t * 0.3],
      (t) => {
        const span = Math.sin(t * Math.PI * 0.9) * 0.95;
        return [
          (rootX + span) * side,
          rootY - t * 0.42 - span * 0.08,
          rootZ + 0.2 + t * 0.85,
        ];
      },
      segs,
    );
  }

  const fins = new THREE.BufferGeometry();
  fins.setAttribute("position", new THREE.Float32BufferAttribute(finPos, 3));
  fins.setIndex(finIdx);
  fins.computeVertexNormals();

  /* ── Flukes ──────────────────────────────────────────────────── */

  const flukePos: number[] = [];
  const flukeIdx: number[] = [];
  {
    const pedZ = len * 0.5 - 0.08;
    const segs = 32;
    const halfSpan = 1.35;
    for (const side of [-1, 1] as const) {
      const leadStart = flukePos.length / 3;
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const x = (0.04 + Math.sin(t * Math.PI * 0.92) * halfSpan) * side;
        const zLead = pedZ + 0.05 + t * 0.55 + Math.sin(t * Math.PI) * 0.08;
        flukePos.push(0.02 * side, 0.015, pedZ + t * 0.12);
        flukePos.push(x, Math.sin(t * Math.PI) * 0.02 * side * 0.15, zLead);
      }
      for (let i = 0; i < segs; i++) {
        const a = leadStart + i * 2;
        flukeIdx.push(a, a + 1, a + 2);
        flukeIdx.push(a + 2, a + 1, a + 3);
      }
      const trailStart = flukePos.length / 3;
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const span = Math.sin(t * Math.PI * 0.95) * halfSpan;
        const zTrail =
          pedZ + 0.35 + Math.sin(t * Math.PI) * 0.72 + Math.pow(t, 1.6) * 0.15;
        flukePos.push((0.06 + span * 0.35) * side, 0, pedZ + 0.2 + t * 0.25);
        flukePos.push((0.08 + span) * side, -0.01, zTrail);
      }
      for (let i = 0; i < segs; i++) {
        const a = trailStart + i * 2;
        flukeIdx.push(a, a + 1, a + 2);
        flukeIdx.push(a + 2, a + 1, a + 3);
      }
    }
    {
      const segs = 12;
      const start = flukePos.length / 3;
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const w = 0.04 + t * 0.08;
        const z = pedZ + 0.25 + t * 0.55;
        flukePos.push(-w, 0.005, z);
        flukePos.push(w, 0.005, z);
      }
      for (let i = 0; i < segs; i++) {
        const a = start + i * 2;
        flukeIdx.push(a, a + 1, a + 2);
        flukeIdx.push(a + 2, a + 1, a + 3);
      }
    }
    for (const side of [-1, 1] as const) {
      const segs = 14;
      const start = flukePos.length / 3;
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const z = pedZ - 0.55 + t * 0.55;
        const x = (0.1 + Math.sin(t * Math.PI) * 0.12) * side;
        flukePos.push(x * 0.7, 0.03, z);
        flukePos.push(x, -0.02, z + 0.02);
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

  /* ── Detail ──────────────────────────────────────────────────── */

  const dPos: number[] = [];
  const dIdx: number[] = [];

  const pushRing = (
    cx: number,
    cy: number,
    cz: number,
    rx: number,
    ry: number,
    rz: number,
    segs: number,
    extrude = 0.03,
  ) => {
    const start = dPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      dPos.push(cx, cy, cz);
      dPos.push(
        cx + Math.cos(a) * rx,
        cy + Math.sin(a) * ry + extrude * 0.4,
        cz + Math.cos(a) * rz * 0.3,
      );
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      dIdx.push(a, a + 1, a + 2);
      dIdx.push(a + 2, a + 1, a + 3);
    }
  };

  // Blowhole
  {
    const cy = 0.44;
    const cz = -1.45;
    const segs = 18;
    const start = dPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const a = -Math.PI * 0.55 + t * Math.PI * 1.1;
      dPos.push(0, cy, cz);
      dPos.push(Math.sin(a) * 0.09, cy + 0.035, cz + Math.cos(a) * 0.05);
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      dIdx.push(a, a + 1, a + 2);
      dIdx.push(a + 2, a + 1, a + 3);
    }
  }

  // Eyes — sit just behind the rostrum / at melon base
  for (const side of [-1, 1] as const) {
    const cx = side * 0.34;
    const cy = 0.04;
    const cz = -1.72;
    pushRing(cx, cy, cz, 0.05, 0.045, 0.035, 16, 0.02);
    pushRing(cx + side * 0.01, cy, cz + 0.01, 0.025, 0.022, 0.018, 12, 0.012);
  }

  // Mandibular smile crease — runs along the long snout
  for (const side of [-1, 1] as const) {
    const segs = 24;
    const start = dPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      // From near tip along the length of the beak
      const z = -len * 0.5 + 0.08 + t * (ROSTRUM_END * len * 0.95);
      const y = -0.07 + Math.sin(t * Math.PI * 0.7) * 0.04 + t * 0.03;
      const x = side * (0.07 + t * 0.14 + bodyRadius(t * ROSTRUM_END) * bodyWidthScale(t * ROSTRUM_END) * 0.55);
      dPos.push(x, y, z);
      dPos.push(x * 1.03, y - 0.02, z + 0.012);
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      dIdx.push(a, a + 1, a + 2);
      dIdx.push(a + 2, a + 1, a + 3);
    }
  }

  // Melon / beak break crease (where forehead meets snout)
  {
    const segs = 18;
    const start = dPos.length / 3;
    const zBreak = (ROSTRUM_END - 0.5) * len;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const a = -0.95 + t * 1.9;
      const x = Math.sin(a) * 0.18;
      const y = 0.1 + Math.cos(a) * 0.12;
      dPos.push(x * 0.85, y + 0.04, zBreak);
      dPos.push(x, y, zBreak + 0.04);
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      dIdx.push(a, a + 1, a + 2);
      dIdx.push(a + 2, a + 1, a + 3);
    }
  }

  // Mouth gape along underside of snout (long horizontal line)
  {
    const segs = 28;
    const start = dPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const u = 0.01 + t * (ROSTRUM_END - 0.02);
      const z = (u - 0.5) * len;
      const halfW = bodyRadius(u) * bodyWidthScale(u) * 0.55 * (1 - t * 0.15);
      const y = spineYOffset(u) - bodyRadius(u) * bodyHeightScale(u) * 0.15;
      dPos.push(-halfW, y, z);
      dPos.push(halfW, y, z);
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      dIdx.push(a, a + 1, a + 2);
      dIdx.push(a + 2, a + 1, a + 3);
    }
  }

  // Upper jaw ridge (dorsal midline of beak)
  {
    const segs = 20;
    const start = dPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const u = 0.01 + t * (ROSTRUM_END - 0.01);
      const z = (u - 0.5) * len;
      const yTop = spineYOffset(u) + bodyRadius(u) * bodyHeightScale(u) * 0.92;
      dPos.push(-0.012, yTop, z);
      dPos.push(0.012, yTop + 0.01, z + 0.01);
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      dIdx.push(a, a + 1, a + 2);
      dIdx.push(a + 2, a + 1, a + 3);
    }
  }

  // Peg teeth hint along gape
  for (let row = 0; row < 2; row++) {
    const count = 14;
    for (let i = 0; i < count; i++) {
      const t = i / (count - 1);
      const u = 0.02 + t * (ROSTRUM_END * 0.85);
      const z = (u - 0.5) * len;
      const x = Math.sin((t - 0.5) * 0.7) * bodyRadius(u) * 0.45;
      const y =
        spineYOffset(u) -
        bodyRadius(u) * bodyHeightScale(u) * 0.12 +
        (row === 0 ? 0.02 : -0.025);
      const start = dPos.length / 3;
      dPos.push(x - 0.01, y, z);
      dPos.push(x + 0.01, y, z);
      dPos.push(x, y + (row === 0 ? -0.028 : 0.025), z + 0.006);
      dIdx.push(start, start + 1, start + 2);
    }
  }

  // Lateral line
  for (const side of [-1, 1] as const) {
    const segs = 36;
    const start = dPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const u = ROSTRUM_END + t * 0.7;
      const z = (u - 0.5) * len;
      const r = bodyRadius(u) * bodyWidthScale(u);
      const y = spineYOffset(u) - 0.02;
      dPos.push(side * r * 0.97, y, z);
      dPos.push(side * r * 1.01, y, z + 0.03);
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

/* ── Soft lattice — pin entire head so snout never warps ───────── */

function buildSoftLattice(): {
  particles: SoftParticle[];
  springs: SoftSpring[];
  spineCount: number;
  radial: number;
} {
  const len = BODY_LEN;
  const spineCount = 24;
  const radial = 14;
  const particles: SoftParticle[] = [];
  const springs: SoftSpring[] = [];

  for (let s = 0; s < spineCount; s++) {
    const u = s / (spineCount - 1);
    const z = (u - 0.5) * len;
    const r = bodyRadius(u) * 0.94;
    const hy = bodyHeightScale(u);
    const hx = bodyWidthScale(u);
    const cy = spineYOffset(u);
    // Pin ALL particles in the head/rostrum region — snout stays rigid
    const pinHead = u <= HEAD_FREEZE_U;
    particles.push(makeParticle(0, cy, z, pinHead));
    for (let k = 0; k < radial; k++) {
      const a = (k / radial) * Math.PI * 2;
      particles.push(
        makeParticle(
          Math.cos(a) * r * hx,
          Math.sin(a) * r * hy + cy,
          z,
          pinHead,
        ),
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
    const u = s / (spineCount - 1);
    const headStiff = u < HEAD_FREEZE_U ? 1.15 : 1;
    for (let k = 0; k < radial; k++) {
      addSpring(base, base + 1 + k, 0.92 * headStiff);
      addSpring(base + 1 + k, base + 1 + ((k + 1) % radial), 0.84 * headStiff);
      addSpring(base + 1 + k, base + 1 + ((k + 2) % radial), 0.52);
      addSpring(base + 1 + k, base + 1 + ((k + 3) % radial), 0.36);
    }
    if (s < spineCount - 1) {
      const next = (s + 1) * ringSize;
      const longStiff = u > 0.7 ? 0.88 : 0.97;
      addSpring(base, next, longStiff);
      for (let k = 0; k < radial; k++) {
        addSpring(base + 1 + k, next + 1 + k, u > 0.7 ? 0.62 : 0.76);
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
    // Tip vertices (ahead of first ring) — bind hard to first ring only
    if (z < -len * 0.5 + 0.05) {
      tmp.length = 0;
      for (let p = 0; p < ringSize; p++) {
        const pr = particles[p]!;
        const d = Math.hypot(x - pr.x, y - pr.y, z - pr.z) + 1e-4;
        tmp.push({ i: p, d });
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

/* ── Soft-body: no undulation on head/snout ────────────────────── */

const _diff = new THREE.Vector3();

function stepSoftBody(d: DolphinSim, dt: number, swimAmp: number, t: number) {
  const particles = d.particles;
  const ringSize = 1 + d.radial;
  const damp = Math.pow(0.91, dt * 60);

  for (let s = 0; s < d.spineCount; s++) {
    const u = s / (d.spineCount - 1);
    // Zero wave on head/rostrum — snout stays rock-solid
    if (u <= HEAD_FREEZE_U) continue;

    const tailWeight = Math.pow((u - HEAD_FREEZE_U) / (1 - HEAD_FREEZE_U), 1.7);
    const wave =
      Math.sin(u * 3.6 - t * 5.4 + d.phase) *
      swimAmp *
      (0.08 + tailWeight * 1.85);
    const base = s * ringSize;
    const p = particles[base]!;
    if (!p.pinned) p.y += wave * dt * 2.7;
    for (let k = 0; k < d.radial; k++) {
      const q = particles[base + 1 + k]!;
      if (q.pinned) continue;
      q.y += wave * dt * 2.4;
      if (u > 0.55) {
        q.x +=
          Math.sin(u * 2.1 - t * 3.6 + d.phase) *
          swimAmp *
          0.12 *
          tailWeight *
          dt;
      }
    }
  }

  // Smile only on very front jaw particles if somehow unpinned (usually pinned)
  if (d.smile > 0.2 && d.alarm < 0.35) {
    for (let s = 0; s < 3; s++) {
      const u = s / (d.spineCount - 1);
      if (u > HEAD_FREEZE_U) break;
      // Head is pinned — skip. Soft smile is visual via details only.
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
      const cy = spineYOffset(u);
      const base = s * ringSize;
      const center = particles[base]!;
      // Very strong retention on head; moderate mid; soft tail
      const retain = u <= HEAD_FREEZE_U ? 0.45 : u > 0.75 ? 0.05 : 0.08;
      if (!center.pinned) {
        center.x += (0 - center.x) * retain;
        center.y += (cy - center.y) * retain;
        center.z += (z - center.z) * retain;
      } else {
        // Force pinned head back to exact rest every frame
        center.x = 0;
        center.y = cy;
        center.z = z;
      }
      for (let k = 0; k < d.radial; k++) {
        const a = (k / d.radial) * Math.PI * 2;
        const q = particles[base + 1 + k]!;
        const rx = Math.cos(a) * r * hx;
        const ry = Math.sin(a) * r * hy + cy;
        if (q.pinned) {
          q.x = rx;
          q.y = ry;
          q.z = z;
        } else {
          const rs = u <= HEAD_FREEZE_U ? 0.2 : 0.06;
          q.x += (rx - q.x) * rs;
          q.y += (ry - q.y) * rs;
          q.z += (z - q.z) * rs;
        }
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
    // Snout verts: keep exact rest (no soft-body delta) for a clean beak
    if (rz < (HEAD_FREEZE_U - 0.5) * BODY_LEN + 0.05) {
      arr[v * 3] = rx;
      arr[v * 3 + 1] = ry;
      arr[v * 3 + 2] = rz;
      continue;
    }
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

/* ── AI ────────────────────────────────────────────────────────── */

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
