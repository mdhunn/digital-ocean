import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import {
  registerMermaidPositions,
  sharkWorldPositions,
} from "./creatureRegistry";

/**
 * High-polygon female mermaids — soft-body wireframe swimmers.
 *
 * Anatomy informed by multi-angle refs (side / front / top / bottom):
 *  Side: human female torso proportions (head→neck→bust→waist→hips) then
 *        long fusiform fish tail with elegant caudal fluke.
 *  Front: shoulder width, feminine bust contour, navel plane, hip flare.
 *  Top (dorsal): shoulder blades, spine line, tail taper, hair volume.
 *  Bottom (ventral): clavicle hollow, underbust, soft belly, scale transition.
 *
 * Soft-body: Verlet + springs. Head/torso stiff; hair + mid-tail flexible;
 * caudal fluke drives lateral undulation (fish-like, not cetacean DV wave).
 *
 * Behavior:
 *  - Friendly & curious about cursor/pointer (approach, circle, investigate)
 *  - Flee hunting sharks with HIGHER priority and stronger force than curiosity
 *  - Cruise and burst swim faster than great whites
 */

const SURFACE_Y = 12;
const SEABED_Y = -1.5;
const MERMAID_COUNT = 3;
const SPINE_LEN = 64;
const RADIAL = 44;
const SOFT_ITERS = 4;
const BODY_LEN = 5.8;

/** Human torso ends / scaled hips begin */
const TORSO_END = 0.42;
/** Head soft-body freeze (pin + no undulation) */
const HEAD_FREEZE_U = 0.12;
/** Bust peak along body fraction */
const BUST_U = 0.2;
/** Waist narrowest */
const WAIST_U = 0.3;
/** Hip max before tail */
const HIP_U = 0.4;

/* ── materials ─────────────────────────────────────────────────── */

const BODY_MAT = new THREE.MeshBasicMaterial({
  vertexColors: true,
  wireframe: true,
  transparent: true,
  opacity: 0.98,
  depthWrite: false,
});

const TAIL_MAT = new THREE.MeshBasicMaterial({
  color: new THREE.Color("#3ec9b0"),
  wireframe: true,
  transparent: true,
  opacity: 0.97,
  depthWrite: false,
  side: THREE.DoubleSide,
});

const HAIR_MAT = new THREE.MeshBasicMaterial({
  color: new THREE.Color("#c96b3e"),
  wireframe: true,
  transparent: true,
  opacity: 0.94,
  depthWrite: false,
  side: THREE.DoubleSide,
});

const DETAIL_MAT = new THREE.MeshBasicMaterial({
  color: new THREE.Color("#f2d4c4"),
  wireframe: true,
  transparent: true,
  opacity: 0.93,
  depthWrite: false,
  side: THREE.DoubleSide,
});

const ARM_MAT = new THREE.MeshBasicMaterial({
  color: new THREE.Color("#e8b8a4"),
  wireframe: true,
  transparent: true,
  opacity: 0.96,
  depthWrite: false,
  side: THREE.DoubleSide,
});

const ACCENT_MAT = new THREE.MeshBasicMaterial({
  color: new THREE.Color("#7fd4ff"),
  wireframe: true,
  transparent: true,
  opacity: 0.92,
  depthWrite: false,
  side: THREE.DoubleSide,
});

function seeded(n: number) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/* ── Anatomical profiles (multi-angle) ───────────────────────────
 * u: 0 = crown → 1 = caudal peduncle base
 *
 * Side profile (from refs):
 *   crown → brow → jaw → neck → clavicle → bust peak → underbust →
 *   waist cinch → hip flare → scale belt → long tapering tail → peduncle
 *
 * Front: shoulders ~2× head, bust lobes, navel, hip width > waist
 * Top:   hair volume, shoulder width, spine ridge, tail dorsal keel
 * Bottom: chin→throat, breast unders, soft belly, ventral scale V
 */

function bodyRadius(u: number): number {
  // Head (sphere-ish)
  if (u < 0.02) return 0.12 + u * 6;
  if (u < 0.07) return 0.24 + (u - 0.02) * 1.1; // ~0.24–0.295 cranium
  if (u < 0.1) return 0.295 - (u - 0.07) * 2.2; // jaw taper
  // Neck
  if (u < 0.14) return 0.229 - (u - 0.1) * 1.1; // ~0.185 neck
  // Shoulders / upper chest
  if (u < 0.17) return 0.185 + (u - 0.14) * 8.5; // swell to shoulders
  // Bust region
  if (u < 0.24) return 0.44 + (u - 0.17) * 1.6; // ~0.44–0.55
  // Underbust → waist
  if (u < WAIST_U) return 0.552 - (u - 0.24) * 2.8; // cinch to ~0.38
  // Hip flare
  if (u < HIP_U) return 0.384 + (u - WAIST_U) * 2.6; // → ~0.64
  // Scale transition / upper tail
  if (u < 0.5) return 0.644 - (u - HIP_U) * 1.1;
  if (u < 0.62) return 0.534 - (u - 0.5) * 1.35;
  if (u < 0.75) return 0.372 - (u - 0.62) * 1.15;
  if (u < 0.88) return 0.2225 - (u - 0.75) * 0.85;
  if (u < 0.96) return 0.112 - (u - 0.88) * 0.55;
  return 0.068 - (u - 0.96) * 0.4;
}

/** Vertical scale — head tall, bust deep, waist, hips, flat-ish tail */
function bodyHeightScale(u: number): number {
  if (u < 0.08) return 1.08; // skull
  if (u < 0.14) return 1.02; // neck
  // Bust: deeper front (handled in sample), overall height
  if (u < 0.26) return 1.12 + Math.sin(((u - 0.14) / 0.12) * Math.PI) * 0.18;
  if (u < WAIST_U) return 1.05;
  if (u < HIP_U) return 1.08 + (u - WAIST_U) * 0.35;
  // Tail: more vertically oval mid-tail, flattened peduncle
  if (u < 0.7) return 1.05 - (u - HIP_U) * 0.15;
  if (u < 0.9) return 0.995 + (u - 0.7) * 0.2;
  return 1.05;
}

/** Lateral width — shoulders, bust, waist, hips */
function bodyWidthScale(u: number): number {
  if (u < 0.08) return 0.92; // head slightly oval
  if (u < 0.14) return 0.88; // neck
  if (u < 0.18) return 0.88 + (u - 0.14) * 4.5; // shoulder flare
  if (u < 0.26) return 1.06; // bust width
  if (u < WAIST_U) return 1.06 - (u - 0.26) * 2.2; // waist narrow
  if (u < HIP_U) return 0.972 + (u - WAIST_U) * 2.4; // hip wide
  if (u < 0.55) return 1.212 - (u - HIP_U) * 0.9;
  if (u < 0.8) return 1.077 - (u - 0.55) * 1.4;
  return 0.727 - (u - 0.8) * 1.1;
}

/**
 * Spine centerline Y — human upright offset in head/torso,
 * gentle S-curve into tail (mermaid often slightly arched).
 */
function spineYOffset(u: number): number {
  if (u < 0.08) return 0.02; // head slightly above
  if (u < 0.14) return 0.01;
  // Chest lift
  if (u < 0.28) return 0.02 + Math.sin(((u - 0.14) / 0.14) * Math.PI) * 0.04;
  // Soft lumbar curve
  if (u < TORSO_END) return 0.01 - Math.sin(((u - 0.28) / 0.14) * Math.PI) * 0.03;
  // Tail slightly below then rises toward peduncle
  if (u < 0.75) return -0.02 - Math.sin(((u - TORSO_END) / 0.33) * Math.PI) * 0.04;
  return -0.02 + (u - 0.75) * 0.06;
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

type MermaidSim = {
  id: number;
  mesh: THREE.Mesh;
  tailMesh: THREE.Mesh;
  hairMesh: THREE.Mesh;
  detailMesh: THREE.Mesh;
  armMesh: THREE.Mesh;
  accentMesh: THREE.Mesh;
  particles: SoftParticle[];
  springs: SoftSpring[];
  spineCount: number;
  radial: number;
  restVerts: Float32Array;
  influence: Uint16Array;
  weights: Float32Array;
  tailRest: Float32Array;
  tailInfluence: Uint16Array;
  tailWeights: Float32Array;
  hairRest: Float32Array;
  hairInfluence: Uint16Array;
  hairWeights: Float32Array;
  detailRest: Float32Array;
  detailInfluence: Uint16Array;
  detailWeights: Float32Array;
  armRest: Float32Array;
  armInfluence: Uint16Array;
  armWeights: Float32Array;
  accentRest: Float32Array;
  accentInfluence: Uint16Array;
  accentWeights: Float32Array;
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
  hairHue: number;
  tailHue: number;
};

/** Shark avoid ranges — wider than dolphin so mermaids react earlier */
const SHARK_ALARM_RANGE = 13;
const SHARK_PANIC_RANGE = 7.5;
const CURIOUS_RANGE = 15;
/** Flee force outweighs curiosity force (user: avoid sharks more than cursor attract) */
const FLEE_FORCE = 4.2;
const CURIOUS_FORCE = 1.15;

function skinColor(y: number, r: number, u: number, out: THREE.Color) {
  const ny = y / Math.max(r, 0.04);
  // Warm human skin tones on torso; cooler teal scales on tail
  if (u < TORSO_END) {
    // Ventral lighter, dorsal slightly warmer
    if (ny < -0.15) {
      out.setRGB(0.96, 0.82, 0.74);
    } else if (ny < 0.2) {
      const t = (ny + 0.15) / 0.35;
      out.setRGB(0.96 - t * 0.08, 0.82 - t * 0.1, 0.74 - t * 0.08);
    } else {
      out.setRGB(0.86, 0.68, 0.58);
    }
    // Blush on cheeks / lips zone (head front)
    if (u > 0.03 && u < 0.08 && ny < 0.15 && ny > -0.25) {
      out.lerp(new THREE.Color(0.95, 0.55, 0.55), 0.12);
    }
  } else {
    // Iridescent teal/aqua scales
    const along = (u - TORSO_END) / (1 - TORSO_END);
    if (ny < -0.2) {
      out.setRGB(0.55 + along * 0.15, 0.92, 0.85);
    } else if (ny < 0.15) {
      out.setRGB(0.25 + along * 0.1, 0.78 - along * 0.1, 0.72);
    } else {
      out.setRGB(0.12, 0.55 - along * 0.08, 0.58);
    }
    // Scale shimmer bands
    const band = Math.sin(u * 48 + ny * 6) * 0.5 + 0.5;
    out.lerp(new THREE.Color(0.4, 0.95, 0.88), band * 0.12);
  }
}

/* ── Body ring sample ──────────────────────────────────────────── */

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

  // Bust: dual-lobe ventral swell (side + front anatomy)
  let bust = 1;
  if (u > 0.16 && u < 0.26) {
    const bu = 1 - Math.abs(u - BUST_U) / 0.06;
    const ventral = Math.max(0, -Math.sin(a)); // belly side of ring
    // Two peaks offset left/right of midline for breasts
    const lat = Math.cos(a);
    const lobe =
      Math.exp(-Math.pow((lat - 0.42) * 3.2, 2)) +
      Math.exp(-Math.pow((lat + 0.42) * 3.2, 2));
    if (ventral > 0.15 && bu > 0) {
      bust = 1 + bu * lobe * ventral * 0.55;
    }
  }

  // Soft underbust crease indent
  let underbust = 1;
  if (u > 0.24 && u < 0.28 && Math.sin(a) < -0.2) {
    const t = 1 - Math.abs(u - 0.26) / 0.04;
    underbust = 1 - t * 0.06 * Math.abs(Math.sin(a));
  }

  // Waist pinch
  let waist = 1;
  if (u > 0.27 && u < 0.34) {
    const t = 1 - Math.abs(u - WAIST_U) / 0.04;
    waist = 1 - t * 0.08;
  }

  // Hip / glute dorsal swell at transition
  let hip = 1;
  if (u > 0.35 && u < 0.46) {
    const t = 1 - Math.abs(u - HIP_U) / 0.06;
    const dorsal = Math.max(0, Math.sin(a));
    const lat = Math.abs(Math.cos(a));
    hip = 1 + t * (dorsal * 0.18 + lat * 0.12);
  }

  // Navel indent
  let navel = 1;
  if (u > 0.31 && u < 0.35 && Math.abs(Math.cos(a)) < 0.25 && Math.sin(a) < -0.6) {
    navel = 0.88;
  }

  // Eye socket indents (front of head)
  let eye = 1;
  if (u > 0.035 && u < 0.06) {
    const eu = 1 - Math.abs(u - 0.048) / 0.015;
    const lat = Math.abs(Math.cos(a));
    if (lat > 0.45 && lat < 0.85 && Math.abs(Math.sin(a)) < 0.45) {
      eye = 1 - eu * 0.22;
    }
  }

  // Nose bridge ridge (front midline of face)
  let nose = 1;
  if (u > 0.04 && u < 0.07 && Math.abs(Math.cos(a)) < 0.2 && Math.sin(a) < -0.5) {
    nose = 1.08;
  }

  // Scale belt ridge at torso→tail
  let belt = 1;
  if (u > 0.4 && u < 0.46) {
    const t = Math.sin(((u - 0.4) / 0.06) * Math.PI);
    belt = 1 + t * 0.06;
  }

  // Dorsal ridge on tail
  let ridge = 1;
  if (u > TORSO_END && Math.sin(a) > 0.75) {
    ridge = 1 + (Math.sin(a) - 0.75) * 0.2;
  }

  // Soft belly fill (human torso)
  const belly =
    u > 0.18 && u < TORSO_END && Math.sin(a) < -0.2
      ? 0.96 + Math.abs(Math.sin(a)) * 0.05
      : 1;

  let px =
    Math.cos(a) *
    r *
    hx *
    waist *
    hip *
    underbust *
    belt *
    eye *
    belly;
  let py =
    Math.sin(a) *
      r *
      hy *
      bust *
      hip *
      ridge *
      eye *
      nose *
      navel *
      belly +
    cy;

  const noiseAmt = u < HEAD_FREEZE_U ? 0.004 : 0.01;
  const n =
    1 +
    Math.sin(a * 7 + u * 15 + seed) * noiseAmt +
    Math.sin(a * 17 - u * 11) * noiseAmt * 0.55;

  return { x: px * n, y: py * n, z, r: r * hy, cy };
}

/* ── Geometry builders ─────────────────────────────────────────── */

function buildMermaidGeometry(seed: number): {
  body: THREE.BufferGeometry;
  tail: THREE.BufferGeometry;
  hair: THREE.BufferGeometry;
  detail: THREE.BufferGeometry;
  arms: THREE.BufferGeometry;
  accent: THREE.BufferGeometry;
} {
  const len = BODY_LEN;
  const spineN = SPINE_LEN;
  const radN = RADIAL;
  const positions: number[] = [];
  const colors: number[] = [];
  const col = new THREE.Color();

  // Non-linear u: denser rings on head + bust + hip transition
  for (let s = 0; s <= spineN; s++) {
    const sNorm = s / spineN;
    let u: number;
    if (sNorm < 0.18) {
      u = (sNorm / 0.18) * 0.12; // head density
    } else if (sNorm < 0.45) {
      u = 0.12 + ((sNorm - 0.18) / 0.27) * 0.32; // torso/bust/waist/hips
    } else {
      u = 0.44 + ((sNorm - 0.45) / 0.55) * 0.56; // long tail
    }

    for (let k = 0; k <= radN; k++) {
      const a = (k / radN) * Math.PI * 2;
      const p = sampleBodyRing(u, a, seed);
      positions.push(p.x, p.y, p.z);
      skinColor(p.y - p.cy, p.r, u, col);
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

  // Crown tip
  {
    const tip = positions.length / 3;
    positions.push(0, spineYOffset(0) + 0.12, -len * 0.5 - 0.06);
    colors.push(0.9, 0.75, 0.68);
    for (let k = 0; k < radN; k++) {
      indices.push(tip, k + 1, k);
    }
  }

  const body = new THREE.BufferGeometry();
  body.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  body.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  body.setIndex(indices);
  body.computeVertexNormals();

  /* ── Caudal fluke + side fins (tail extras) ──────────────────── */

  const tailPos: number[] = [];
  const tailIdx: number[] = [];

  const pushRibbon = (
    root: (t: number) => [number, number, number],
    tipFn: (t: number) => [number, number, number],
    segs: number,
  ) => {
    const start = tailPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const [rx, ry, rz] = root(t);
      const [tx, ty, tz] = tipFn(t);
      tailPos.push(rx, ry, rz);
      tailPos.push(tx, ty, tz);
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      tailIdx.push(a, a + 1, a + 2);
      tailIdx.push(a + 2, a + 1, a + 3);
    }
  };

  // Large elegant caudal fluke (horizontal lobes, fantasy mermaid)
  {
    const pedZ = len * 0.5 - 0.05;
    const segs = 36;
    const halfSpan = 1.55;
    for (const side of [-1, 1] as const) {
      // Leading edge
      const leadStart = tailPos.length / 3;
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const span = Math.sin(t * Math.PI * 0.92) * halfSpan;
        const zLead = pedZ + 0.08 + t * 0.65 + Math.sin(t * Math.PI) * 0.12;
        const yLead = Math.sin(t * Math.PI) * 0.04 * side;
        tailPos.push(0.03 * side, 0.01, pedZ + t * 0.1);
        tailPos.push((0.06 + span) * side, yLead, zLead);
      }
      for (let i = 0; i < segs; i++) {
        const a = leadStart + i * 2;
        tailIdx.push(a, a + 1, a + 2);
        tailIdx.push(a + 2, a + 1, a + 3);
      }
      // Trailing scalloped edge
      const trailStart = tailPos.length / 3;
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const span = Math.sin(t * Math.PI * 0.95) * halfSpan * 1.05;
        const scallop = Math.sin(t * Math.PI * 5) * 0.08 * (1 - t * 0.3);
        const zTrail =
          pedZ + 0.4 + Math.sin(t * Math.PI) * 0.85 + Math.pow(t, 1.5) * 0.2 + scallop;
        tailPos.push((0.08 + span * 0.4) * side, 0, pedZ + 0.25 + t * 0.2);
        tailPos.push((0.1 + span) * side, -0.02 + Math.sin(t * Math.PI) * 0.03, zTrail);
      }
      for (let i = 0; i < segs; i++) {
        const a = trailStart + i * 2;
        tailIdx.push(a, a + 1, a + 2);
        tailIdx.push(a + 2, a + 1, a + 3);
      }
    }
    // Fluke mid notch connector
    {
      const segs = 14;
      const start = tailPos.length / 3;
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const w = 0.05 + t * 0.1;
        const z = pedZ + 0.3 + t * 0.7;
        tailPos.push(-w, 0.008, z);
        tailPos.push(w, 0.008, z);
      }
      for (let i = 0; i < segs; i++) {
        const a = start + i * 2;
        tailIdx.push(a, a + 1, a + 2);
        tailIdx.push(a + 2, a + 1, a + 3);
      }
    }
  }

  // Side hip fins (pelvic fin accents from fin reference)
  for (const side of [-1, 1] as const) {
    pushRibbon(
      (t) => [0.38 * side, -0.05 - t * 0.02, 0.35 + t * 0.15],
      (t) => {
        const span = Math.sin(t * Math.PI * 0.9) * 0.55;
        return [
          (0.42 + span) * side,
          -0.08 - t * 0.35,
          0.4 + t * 0.55,
        ];
      },
      18,
    );
  }

  // Small dorsal fin mid-tail
  pushRibbon(
    (t) => [0, 0.22, 0.9 + t * 0.9],
    (t) => {
      let h: number;
      if (t < 0.35) h = Math.pow(t / 0.35, 0.7);
      else if (t < 0.55) h = 1 - (t - 0.35) * 0.1;
      else h = 0.98 * Math.pow(1 - (t - 0.55) / 0.45, 1.3);
      return [0.01, 0.22 + h * 0.55, 0.9 + t * 0.95 + t * t * 0.15];
    },
    22,
  );

  // Scale rows on upper tail (wire detail density)
  for (let row = 0; row < 5; row++) {
    const u0 = 0.45 + row * 0.08;
    const segs = 20;
    const start = tailPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const a = -Math.PI * 0.85 + t * Math.PI * 1.7;
      const r = bodyRadius(u0) * bodyWidthScale(u0) * 1.02;
      const z = (u0 - 0.5) * len;
      const cy = spineYOffset(u0);
      tailPos.push(
        Math.cos(a) * r * 0.92,
        Math.sin(a) * r * bodyHeightScale(u0) * 0.92 + cy,
        z,
      );
      tailPos.push(
        Math.cos(a) * r,
        Math.sin(a) * r * bodyHeightScale(u0) + cy,
        z + 0.04,
      );
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      tailIdx.push(a, a + 1, a + 2);
      tailIdx.push(a + 2, a + 1, a + 3);
    }
  }

  const tail = new THREE.BufferGeometry();
  tail.setAttribute("position", new THREE.Float32BufferAttribute(tailPos, 3));
  tail.setIndex(tailIdx);
  tail.computeVertexNormals();

  /* ── Flowing hair (soft-body driven) ──────────────────────────── */

  const hairPos: number[] = [];
  const hairIdx: number[] = [];
  const hairStrands = 18;
  const hairSegs = 16;
  for (let s = 0; s < hairStrands; s++) {
    const ang = (s / hairStrands) * Math.PI * 2;
    // Bias strands to back of head (dorsal / +X sides, less face-covering)
    const backBias = 0.55 + 0.45 * Math.max(0, Math.cos(ang)); // cos>0 → +Z wait
    // Head at −Z; hair flows toward +Z (back) and outward
    const rootX = Math.sin(ang) * 0.18 * (0.7 + backBias * 0.3);
    const rootY = 0.08 + Math.cos(ang * 0.5) * 0.06;
    const rootZ = -len * 0.5 + 0.15 + Math.cos(ang) * 0.08;
    // Prefer strands not covering face (more volume on sides/back)
    if (Math.cos(ang) < -0.55 && Math.abs(Math.sin(ang)) < 0.4) continue;

    const start = hairPos.length / 3;
    for (let i = 0; i <= hairSegs; i++) {
      const t = i / hairSegs;
      const spread = t * t * 0.55;
      const hang = t * 1.35 + Math.sin(t * Math.PI) * 0.15;
      const flow = t * 0.95; // toward tail (+Z)
      const wave = Math.sin(t * 4 + s) * t * 0.12;
      const x = rootX * (1 + spread) + wave * Math.cos(ang);
      const y = rootY - hang * 0.35 + Math.sin(t * 3 + seed) * t * 0.08;
      const z = rootZ + flow + Math.abs(rootX) * t * 0.3;
      // ribbon width
      const w = 0.025 * (1 - t * 0.4);
      hairPos.push(x - w * Math.cos(ang), y, z);
      hairPos.push(x + w * Math.cos(ang), y + w * 0.3, z + 0.01);
    }
    for (let i = 0; i < hairSegs; i++) {
      const a = start + i * 2;
      hairIdx.push(a, a + 1, a + 2);
      hairIdx.push(a + 2, a + 1, a + 3);
    }
  }
  // Hair volume cap over crown
  {
    const segs = 20;
    const start = hairPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const a = t * Math.PI * 2;
      hairPos.push(0, 0.14, -len * 0.5 + 0.12);
      hairPos.push(
        Math.sin(a) * 0.22,
        0.16 + Math.cos(a) * 0.04,
        -len * 0.5 + 0.12 + Math.cos(a) * 0.08,
      );
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      hairIdx.push(a, a + 1, a + 2);
      hairIdx.push(a + 2, a + 1, a + 3);
    }
  }

  const hair = new THREE.BufferGeometry();
  hair.setAttribute("position", new THREE.Float32BufferAttribute(hairPos, 3));
  hair.setIndex(hairIdx);
  hair.computeVertexNormals();

  /* ── Arms ────────────────────────────────────────────────────── */

  const armPos: number[] = [];
  const armIdx: number[] = [];
  for (const side of [-1, 1] as const) {
    // Upper arm → forearm → hand as tapered tubes via ribbons
    const shoulder: [number, number, number] = [0.42 * side, 0.08, -1.35];
    const elbow: [number, number, number] = [0.85 * side, -0.15, -0.95];
    const wrist: [number, number, number] = [1.05 * side, -0.35, -0.45];
    const hand: [number, number, number] = [1.12 * side, -0.42, -0.2];

    const chain = [shoulder, elbow, wrist, hand];
    for (let seg = 0; seg < chain.length - 1; seg++) {
      const a0 = chain[seg]!;
      const a1 = chain[seg + 1]!;
      const rad0 = seg === 0 ? 0.07 : seg === 1 ? 0.055 : 0.04;
      const rad1 = seg === 0 ? 0.055 : seg === 1 ? 0.04 : 0.03;
      const segs = 10;
      const start = armPos.length / 3;
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const cx = THREE.MathUtils.lerp(a0[0], a1[0], t);
        const cy = THREE.MathUtils.lerp(a0[1], a1[1], t);
        const cz = THREE.MathUtils.lerp(a0[2], a1[2], t);
        const rad = THREE.MathUtils.lerp(rad0, rad1, t);
        // local "up" ribbon
        armPos.push(cx, cy + rad, cz);
        armPos.push(cx, cy - rad, cz);
      }
      for (let i = 0; i < segs; i++) {
        const a = start + i * 2;
        armIdx.push(a, a + 1, a + 2);
        armIdx.push(a + 2, a + 1, a + 3);
      }
      // side ribbon for thickness
      const start2 = armPos.length / 3;
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const cx = THREE.MathUtils.lerp(a0[0], a1[0], t);
        const cy = THREE.MathUtils.lerp(a0[1], a1[1], t);
        const cz = THREE.MathUtils.lerp(a0[2], a1[2], t);
        const rad = THREE.MathUtils.lerp(rad0, rad1, t);
        armPos.push(cx + rad * 0.7 * side, cy, cz);
        armPos.push(cx - rad * 0.35 * side, cy, cz + rad * 0.3);
      }
      for (let i = 0; i < segs; i++) {
        const a = start2 + i * 2;
        armIdx.push(a, a + 1, a + 2);
        armIdx.push(a + 2, a + 1, a + 3);
      }
    }
    // Simple hand fan (fingers)
    for (let f = 0; f < 5; f++) {
      const fa = (f - 2) * 0.18;
      const segs = 6;
      const start = armPos.length / 3;
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const x = hand[0] + fa * t * 0.15 * side + t * 0.08 * side;
        const y = hand[1] - t * 0.02;
        const z = hand[2] + t * 0.16;
        armPos.push(x, y + 0.012, z);
        armPos.push(x, y - 0.012, z);
      }
      for (let i = 0; i < segs; i++) {
        const a = start + i * 2;
        armIdx.push(a, a + 1, a + 2);
        armIdx.push(a + 2, a + 1, a + 3);
      }
    }
  }

  const arms = new THREE.BufferGeometry();
  arms.setAttribute("position", new THREE.Float32BufferAttribute(armPos, 3));
  arms.setIndex(armIdx);
  arms.computeVertexNormals();

  /* ── Facial + torso detail ───────────────────────────────────── */

  const dPos: number[] = [];
  const dIdx: number[] = [];

  const pushRing = (
    cx: number,
    cy: number,
    cz: number,
    rx: number,
    ry: number,
    segs: number,
  ) => {
    const start = dPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      dPos.push(cx, cy, cz);
      dPos.push(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, cz + 0.01);
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      dIdx.push(a, a + 1, a + 2);
      dIdx.push(a + 2, a + 1, a + 3);
    }
  };

  // Eyes
  for (const side of [-1, 1] as const) {
    pushRing(side * 0.1, 0.04, -len * 0.5 + 0.28, 0.04, 0.032, 14);
    pushRing(side * 0.1, 0.04, -len * 0.5 + 0.3, 0.018, 0.016, 10);
  }

  // Lips
  {
    const segs = 16;
    const start = dPos.length / 3;
    const z = -len * 0.5 + 0.38;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const x = (t - 0.5) * 0.1;
      const y = -0.04 + Math.sin(t * Math.PI) * 0.012;
      dPos.push(x, y, z);
      dPos.push(x, y - 0.018, z + 0.01);
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      dIdx.push(a, a + 1, a + 2);
      dIdx.push(a + 2, a + 1, a + 3);
    }
  }

  // Clavicle lines
  for (const side of [-1, 1] as const) {
    const segs = 12;
    const start = dPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const x = side * t * 0.32;
      const y = 0.12 - t * 0.06;
      const z = -1.55 + t * 0.15;
      dPos.push(x, y, z);
      dPos.push(x, y - 0.02, z + 0.02);
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      dIdx.push(a, a + 1, a + 2);
      dIdx.push(a + 2, a + 1, a + 3);
    }
  }

  // Shell / seashell top (tasteful coverage, wireframe)
  for (const side of [-1, 1] as const) {
    const segs = 18;
    const start = dPos.length / 3;
    const cx = side * 0.16;
    const cy = 0.02;
    const cz = -1.15;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const a = -0.4 + t * (Math.PI + 0.8);
      const rx = 0.14 + Math.sin(t * Math.PI) * 0.04;
      const ry = 0.12 + Math.sin(t * Math.PI) * 0.05;
      dPos.push(cx, cy, cz);
      dPos.push(
        cx + Math.cos(a) * rx * side * (side > 0 ? 1 : -1) * 0.15 + Math.sin(a) * rx * 0.3,
        cy + Math.sin(a) * ry * 0.85,
        cz + Math.cos(a) * 0.06,
      );
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      dIdx.push(a, a + 1, a + 2);
      dIdx.push(a + 2, a + 1, a + 3);
    }
  }

  // Navel
  pushRing(0, -0.12, -0.35, 0.025, 0.02, 10);

  // Hip scale belt decorative V
  {
    const segs = 24;
    const start = dPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const a = -Math.PI * 0.9 + t * Math.PI * 1.8;
      const u = HIP_U;
      const r = bodyRadius(u) * bodyWidthScale(u) * 1.05;
      const z = (u - 0.5) * len;
      const cy = spineYOffset(u);
      dPos.push(
        Math.cos(a) * r * 0.95,
        Math.sin(a) * r * bodyHeightScale(u) * 0.95 + cy,
        z,
      );
      dPos.push(
        Math.cos(a) * r,
        Math.sin(a) * r * bodyHeightScale(u) + cy,
        z + 0.05,
      );
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

  /* ── Accent jewelry / ear fins ───────────────────────────────── */

  const aPos: number[] = [];
  const aIdx: number[] = [];
  // Ear fins (auricle from fin reference)
  for (const side of [-1, 1] as const) {
    const segs = 12;
    const start = aPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const x = side * (0.22 + t * 0.18);
      const y = 0.05 + Math.sin(t * Math.PI) * 0.12;
      const z = -len * 0.5 + 0.32 + t * 0.05;
      aPos.push(side * 0.2, 0.05, -len * 0.5 + 0.3);
      aPos.push(x, y, z);
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      aIdx.push(a, a + 1, a + 2);
      aIdx.push(a + 2, a + 1, a + 3);
    }
  }
  // Necklace
  {
    const segs = 20;
    const start = aPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const a = -0.9 + t * 1.8;
      aPos.push(Math.sin(a) * 0.16, 0.02 + Math.cos(a) * 0.04, -1.48);
      aPos.push(Math.sin(a) * 0.18, -0.02 + Math.cos(a) * 0.05, -1.46);
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      aIdx.push(a, a + 1, a + 2);
      aIdx.push(a + 2, a + 1, a + 3);
    }
  }

  const accent = new THREE.BufferGeometry();
  accent.setAttribute("position", new THREE.Float32BufferAttribute(aPos, 3));
  accent.setIndex(aIdx);
  accent.computeVertexNormals();

  void seed;
  return { body, tail, hair, detail, arms, accent };
}

/* ── Soft lattice ──────────────────────────────────────────────── */

function buildSoftLattice(): {
  particles: SoftParticle[];
  springs: SoftSpring[];
  spineCount: number;
  radial: number;
} {
  const len = BODY_LEN;
  const spineCount = 28;
  const radial = 16;
  const particles: SoftParticle[] = [];
  const springs: SoftSpring[] = [];

  for (let s = 0; s < spineCount; s++) {
    const u = s / (spineCount - 1);
    const z = (u - 0.5) * len;
    const r = bodyRadius(u) * 0.94;
    const hy = bodyHeightScale(u);
    const hx = bodyWidthScale(u);
    const cy = spineYOffset(u);
    // Pin head solidly; light pin on upper chest for stable bust silhouette
    const pin = u <= HEAD_FREEZE_U;
    particles.push(makeParticle(0, cy, z, pin));
    for (let k = 0; k < radial; k++) {
      const a = (k / radial) * Math.PI * 2;
      particles.push(
        makeParticle(Math.cos(a) * r * hx, Math.sin(a) * r * hy + cy, z, pin),
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
    const torsoStiff = u < TORSO_END ? 1.05 : 1;
    for (let k = 0; k < radial; k++) {
      addSpring(base, base + 1 + k, 0.9 * torsoStiff);
      addSpring(base + 1 + k, base + 1 + ((k + 1) % radial), 0.82 * torsoStiff);
      addSpring(base + 1 + k, base + 1 + ((k + 2) % radial), 0.5);
      addSpring(base + 1 + k, base + 1 + ((k + 3) % radial), 0.34);
    }
    if (s < spineCount - 1) {
      const next = (s + 1) * ringSize;
      const longStiff = u > 0.65 ? 0.82 : 0.95;
      addSpring(base, next, longStiff);
      for (let k = 0; k < radial; k++) {
        addSpring(base + 1 + k, next + 1 + k, u > 0.65 ? 0.58 : 0.74);
        addSpring(base + 1 + k, next + 1 + ((k + 1) % radial), 0.42);
        addSpring(base + 1 + k, next, 0.38);
      }
    }
    if (s < spineCount - 2) {
      addSpring(base, (s + 2) * ringSize, 0.55);
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
    // Hair / arm verts far from body — still bind to nearest rings
    if (tmp.length < 4) {
      for (let s = 0; s < spineCount; s++) {
        const base = s * ringSize;
        for (let p = 0; p < ringSize; p++) {
          const pr = particles[base + p]!;
          const d = Math.hypot(x - pr.x, y - pr.y, z - pr.z) + 1e-4;
          tmp.push({ i: base + p, d });
        }
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

function createMermaid(id: number): MermaidSim {
  const seed = id * 17.1 + 3.9;
  const { body, tail, hair, detail, arms, accent } = buildMermaidGeometry(seed);
  const lattice = buildSoftLattice();

  const restVerts = new Float32Array(
    (body.attributes.position as THREE.BufferAttribute).array as Float32Array,
  );
  const tailRest = new Float32Array(
    (tail.attributes.position as THREE.BufferAttribute).array as Float32Array,
  );
  const hairRest = new Float32Array(
    (hair.attributes.position as THREE.BufferAttribute).array as Float32Array,
  );
  const detailRest = new Float32Array(
    (detail.attributes.position as THREE.BufferAttribute).array as Float32Array,
  );
  const armRest = new Float32Array(
    (arms.attributes.position as THREE.BufferAttribute).array as Float32Array,
  );
  const accentRest = new Float32Array(
    (accent.attributes.position as THREE.BufferAttribute).array as Float32Array,
  );

  const bind = bindMeshToLattice(
    restVerts,
    lattice.particles,
    lattice.spineCount,
    lattice.radial,
  );
  const tailBind = bindMeshToLattice(
    tailRest,
    lattice.particles,
    lattice.spineCount,
    lattice.radial,
  );
  const hairBind = bindMeshToLattice(
    hairRest,
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
  const armBind = bindMeshToLattice(
    armRest,
    lattice.particles,
    lattice.spineCount,
    lattice.radial,
  );
  const accentBind = bindMeshToLattice(
    accentRest,
    lattice.particles,
    lattice.spineCount,
    lattice.radial,
  );

  const scale = 0.88 + seeded(seed) * 0.22;
  const angle = (id / MERMAID_COUNT) * Math.PI * 2 + seeded(seed + 1) * 0.6 + 0.3;
  const radius = 3.5 + seeded(seed + 2) * 3.5;
  const pos = new THREE.Vector3(
    Math.cos(angle) * radius - 1.2,
    4.5 + seeded(seed + 3) * 2.4,
    Math.sin(angle) * radius * 0.7 - 0.5,
  );
  const yaw = angle + Math.PI * 0.6;
  const heading = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  // Faster than sharks (shark base ~0.32–0.44; hunt peak ~0.8)
  const baseSpeed = 1.55 + seeded(seed + 5) * 0.5;

  // Per-mermaid hair color variation via material clone
  const hairMat = HAIR_MAT.clone();
  const hairHue = seeded(seed + 9);
  if (hairHue < 0.33) hairMat.color.set("#c96b3e"); // auburn
  else if (hairHue < 0.66) hairMat.color.set("#2a8a9a"); // teal-black
  else hairMat.color.set("#d4a84b"); // golden

  const tailMat = TAIL_MAT.clone();
  const tailHue = seeded(seed + 11);
  if (tailHue < 0.33) tailMat.color.set("#3ec9b0");
  else if (tailHue < 0.66) tailMat.color.set("#5b8fd4");
  else tailMat.color.set("#c45ec8");

  const mesh = new THREE.Mesh(body, BODY_MAT);
  mesh.scale.setScalar(scale);
  mesh.frustumCulled = false;

  const tailMesh = new THREE.Mesh(tail, tailMat);
  tailMesh.scale.setScalar(scale);
  tailMesh.frustumCulled = false;

  const hairMesh = new THREE.Mesh(hair, hairMat);
  hairMesh.scale.setScalar(scale);
  hairMesh.frustumCulled = false;

  const detailMesh = new THREE.Mesh(detail, DETAIL_MAT);
  detailMesh.scale.setScalar(scale);
  detailMesh.frustumCulled = false;

  const armMesh = new THREE.Mesh(arms, ARM_MAT);
  armMesh.scale.setScalar(scale);
  armMesh.frustumCulled = false;

  const accentMesh = new THREE.Mesh(accent, ACCENT_MAT);
  accentMesh.scale.setScalar(scale);
  accentMesh.frustumCulled = false;

  return {
    id,
    mesh,
    tailMesh,
    hairMesh,
    detailMesh,
    armMesh,
    accentMesh,
    particles: lattice.particles,
    springs: lattice.springs,
    spineCount: lattice.spineCount,
    radial: lattice.radial,
    restVerts,
    influence: bind.influence,
    weights: bind.weights,
    tailRest,
    tailInfluence: tailBind.influence,
    tailWeights: tailBind.weights,
    hairRest,
    hairInfluence: hairBind.influence,
    hairWeights: hairBind.weights,
    detailRest,
    detailInfluence: detailBind.influence,
    detailWeights: detailBind.weights,
    armRest,
    armInfluence: armBind.influence,
    armWeights: armBind.weights,
    accentRest,
    accentInfluence: accentBind.influence,
    accentWeights: accentBind.weights,
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
    curiosity: 0.45 + seeded(seed + 8) * 0.4,
    podAngle: angle,
    hairHue,
    tailHue,
  };
}

/* ── Soft-body step ────────────────────────────────────────────── */

const _diff = new THREE.Vector3();

function stepSoftBody(m: MermaidSim, dt: number, swimAmp: number, t: number) {
  const particles = m.particles;
  const ringSize = 1 + m.radial;
  const damp = Math.pow(0.91, dt * 60);

  // Lateral undulation stronger toward tail (fish drive); hair gets lag via springs
  for (let s = 0; s < m.spineCount; s++) {
    const u = s / (m.spineCount - 1);
    if (u <= HEAD_FREEZE_U) continue;

    // Soft torso sway (gentle); strong tail wave
    const tailWeight =
      u < TORSO_END
        ? 0.15 * ((u - HEAD_FREEZE_U) / (TORSO_END - HEAD_FREEZE_U))
        : 0.15 +
          Math.pow((u - TORSO_END) / (1 - TORSO_END), 1.55) * 1.75;

    const wave =
      Math.sin(u * 3.8 - t * 5.8 + m.phase) * swimAmp * (0.1 + tailWeight);
    const base = s * ringSize;
    const p = particles[base]!;
    if (!p.pinned) p.x += wave * dt * 2.6;
    for (let k = 0; k < m.radial; k++) {
      const q = particles[base + 1 + k]!;
      if (q.pinned) continue;
      q.x += wave * dt * 2.3;
      // Soft breast / torso jiggle (small vertical) — soft-body feel
      if (u > 0.16 && u < 0.28) {
        q.y +=
          Math.sin(t * 6.5 + m.phase + u * 4) *
          swimAmp *
          0.08 *
          dt *
          (m.speed * 0.15 + 0.4);
      }
      // Hair-region root sway on upper rings
      if (u < 0.2) {
        q.x += Math.sin(t * 3.2 + m.phase * 1.3) * swimAmp * 0.05 * dt;
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
    for (const s of m.springs) {
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

    for (let s = 0; s < m.spineCount; s++) {
      const u = s / (m.spineCount - 1);
      const z = (u - 0.5) * BODY_LEN;
      const r = bodyRadius(u) * 0.94;
      const hy = bodyHeightScale(u);
      const hx = bodyWidthScale(u);
      const cy = spineYOffset(u);
      const base = s * ringSize;
      const center = particles[base]!;
      // Strong shape retention on head/torso for anatomy; soft on tail
      const retain =
        u <= HEAD_FREEZE_U ? 0.5 : u < TORSO_END ? 0.12 : u > 0.8 ? 0.04 : 0.07;
      if (!center.pinned) {
        center.x += (0 - center.x) * retain;
        center.y += (cy - center.y) * retain;
        center.z += (z - center.z) * retain;
      } else {
        center.x = 0;
        center.y = cy;
        center.z = z;
      }
      for (let k = 0; k < m.radial; k++) {
        const a = (k / m.radial) * Math.PI * 2;
        const q = particles[base + 1 + k]!;
        // Rest pose with bust/hip shaping (match sampleBodyRing lightly)
        let rx = Math.cos(a) * r * hx;
        let ry = Math.sin(a) * r * hy + cy;
        if (u > 0.16 && u < 0.26 && Math.sin(a) < -0.15) {
          const lat = Math.cos(a);
          const lobe =
            Math.exp(-Math.pow((lat - 0.42) * 3.2, 2)) +
            Math.exp(-Math.pow((lat + 0.42) * 3.2, 2));
          const bu = 1 - Math.abs(u - BUST_U) / 0.06;
          if (bu > 0) {
            const f = 1 + bu * lobe * Math.max(0, -Math.sin(a)) * 0.45;
            rx *= f;
            ry = (ry - cy) * f + cy;
          }
        }
        if (q.pinned) {
          q.x = rx;
          q.y = ry;
          q.z = z;
        } else {
          const rs = u <= HEAD_FREEZE_U ? 0.22 : u < TORSO_END ? 0.09 : 0.05;
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
  freezeHead = true,
) {
  const arr = posAttr.array as Float32Array;
  const vCount = rest.length / 3;
  for (let v = 0; v < vCount; v++) {
    const rx = rest[v * 3]!;
    const ry = rest[v * 3 + 1]!;
    const rz = rest[v * 3 + 2]!;
    if (freezeHead && rz < (HEAD_FREEZE_U - 0.5) * BODY_LEN + 0.04) {
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
    // Hair gets exaggerated soft lag
    const hairBoost = ry > 0.2 && rz < -BODY_LEN * 0.15 ? 1.35 : 1;
    arr[v * 3] = rx + dx * hairBoost;
    arr[v * 3 + 1] = ry + dy * hairBoost;
    arr[v * 3 + 2] = rz + dz * hairBoost;
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
const _plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -4.8);
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
    out.y = 4.8;
  }
  return true;
}

function aiStep(
  mermaids: MermaidSim[],
  dt: number,
  pointerWorld: THREE.Vector3 | null,
) {
  for (const m of mermaids) {
    _steer.set(0, 0, 0);

    const sharkDist = nearestSharkDist(m.pos);
    const shark = nearestSharkPos(m.pos);
    let threat = 0;
    if (Number.isFinite(sharkDist) && sharkDist < SHARK_ALARM_RANGE) {
      threat =
        1 -
        THREE.MathUtils.smoothstep(sharkDist, SHARK_PANIC_RANGE, SHARK_ALARM_RANGE);
      if (sharkDist < SHARK_PANIC_RANGE) threat = 1;
    }
    m.alarm = THREE.MathUtils.lerp(m.alarm, threat, dt * 4);

    // Priority: flee sharks ALWAYS outweighs cursor curiosity
    if (m.alarm > 0.25 && shark) {
      _tmp.copy(m.pos).sub(shark).normalize();
      _tmp.y += 0.3;
      _tmp.normalize();
      // Strong flee — higher than any curiosity force
      _steer.addScaledVector(_tmp, FLEE_FORCE + m.alarm * 2.2);
      // Erratic dodge
      _tmp.set(
        Math.sin(m.phase * 2.4) * 0.9,
        Math.cos(m.phase * 1.9) * 0.45,
        Math.cos(m.phase * 2.1) * 0.9,
      );
      _steer.addScaledVector(_tmp, m.alarm * 1.2);
      m.curiosity = THREE.MathUtils.lerp(m.curiosity, 0.05, dt * 3);
    } else if (pointerWorld && m.alarm < 0.3) {
      const toPtr = _tmp.copy(pointerWorld).sub(m.pos);
      const dist = toPtr.length() || 1e-6;
      toPtr.multiplyScalar(1 / dist);

      if (dist < CURIOUS_RANGE) {
        m.curiosity = THREE.MathUtils.lerp(m.curiosity, 1, dt * 1.6);
        if (dist > 2.0) {
          // Approach — weaker than flee
          _steer.addScaledVector(toPtr, CURIOUS_FORCE * m.curiosity);
        } else {
          // Circle / investigate close
          _tmp.set(-toPtr.z, 0.2, toPtr.x).normalize();
          _steer.addScaledVector(_tmp, 1.25);
          _steer.addScaledVector(toPtr, (dist - 1.5) * 0.45);
        }
        _steer.y +=
          THREE.MathUtils.clamp(pointerWorld.y - m.pos.y, -1.2, 1.2) * 0.45;
      } else {
        m.curiosity = THREE.MathUtils.lerp(m.curiosity, 0.4, dt);
        m.podAngle += dt * 0.2;
        const px = Math.cos(m.podAngle + m.id * 1.1) * 7;
        const pz = Math.sin(m.podAngle + m.id * 1.1) * 5.5 - 1;
        _tmp.set(px - m.pos.x, 0, pz - m.pos.z);
        const pd = _tmp.length() || 1;
        _tmp.multiplyScalar(1 / pd);
        _steer.addScaledVector(_tmp, 0.6);
        _tmp.copy(pointerWorld).sub(m.pos).normalize();
        _steer.addScaledVector(_tmp, 0.2 * m.curiosity);
      }
    } else {
      m.podAngle += dt * 0.18;
      const px = Math.cos(m.podAngle + m.id * 1.1) * 7.5;
      const pz = Math.sin(m.podAngle + m.id * 1.1) * 5.8 - 1;
      _tmp.set(px - m.pos.x, 0, pz - m.pos.z);
      const pd = _tmp.length() || 1;
      _tmp.multiplyScalar(1 / pd);
      _steer.addScaledVector(_tmp, 0.5);
      _tmp.set(
        Math.sin(m.phase * 0.32) * 0.28,
        Math.sin(m.phase * 0.26) * 0.32,
        Math.cos(m.phase * 0.3) * 0.28,
      );
      _steer.addScaledVector(_tmp, 0.38);
    }

    // Separation / cohesion among mermaids
    for (const o of mermaids) {
      if (o.id === m.id) continue;
      const d2 = m.pos.distanceToSquared(o.pos);
      if (d2 < 12 && d2 > 1e-6) {
        _tmp.copy(m.pos).sub(o.pos).normalize();
        _steer.addScaledVector(_tmp, 0.95);
      } else if (d2 > 120 && d2 < 500) {
        _tmp.copy(o.pos).sub(m.pos).normalize();
        _steer.addScaledVector(_tmp, 0.18);
      }
    }

    const yMin = SEABED_Y + 2.5;
    const yMax = SURFACE_Y - 4.2;
    if (m.pos.y < yMin) _steer.y += (yMin - m.pos.y) * 1.3;
    if (m.pos.y > yMax) _steer.y -= (m.pos.y - yMax) * 1.3;
    _steer.y += (4.8 - m.pos.y) * 0.04;

    if (m.pos.x < -18) _steer.x += 1.3;
    if (m.pos.x > 18) _steer.x -= 1.3;
    if (m.pos.z < -20) _steer.z += 1.2;
    if (m.pos.z > 10) _steer.z -= 1.0;

    const fleeing = m.alarm > 0.25;
    const curiousBoost = m.curiosity > 0.65 && !fleeing ? 1.18 : 1;
    // Faster than sharks always; flee burst even higher
    const targetSpeed =
      m.baseSpeed * (fleeing ? 2.35 : 1) * curiousBoost * (0.95 + m.alarm * 0.25);
    const maxSp = fleeing
      ? Math.min(targetSpeed * 1.4, 4.2)
      : Math.min(targetSpeed * 1.3, 2.8);
    const minSp = targetSpeed * 0.48;

    m.vel.addScaledVector(_steer, dt * (fleeing ? 2.8 : 1.85));
    const sp = m.vel.length() || 1e-6;
    if (sp > maxSp) m.vel.multiplyScalar(maxSp / sp);
    else if (sp < minSp) m.vel.multiplyScalar(minSp / sp);

    m.pos.addScaledVector(m.vel, dt);
    m.speed = m.vel.length();
    m.heading.copy(m.vel).normalize();
    m.yaw = Math.atan2(-m.heading.x, -m.heading.z);
    m.pitch = Math.asin(THREE.MathUtils.clamp(m.heading.y, -0.55, 0.55));
    m.phase += dt * (3.6 + m.speed * 2.4 + m.alarm * 1.8);
  }
}

function orientMermaid(mesh: THREE.Object3D, heading: THREE.Vector3, bank: number) {
  _fwd.copy(heading).normalize();
  _look.copy(mesh.position).sub(_fwd);
  mesh.lookAt(_look);
  mesh.rotateZ(bank);
}

/* ── React component ───────────────────────────────────────────── */

export function FemaleMermaids() {
  const group = useRef<THREE.Group>(null);
  const { camera } = useThree();

  const mermaids = useMemo(() => {
    const list: MermaidSim[] = [];
    for (let i = 0; i < MERMAID_COUNT; i++) list.push(createMermaid(i));
    return list;
  }, []);

  const restLattices = useMemo(() => {
    return mermaids.map((m) => m.particles.map((p) => ({ x: p.x, y: p.y, z: p.z })));
  }, [mermaids]);

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

    registerMermaidPositions(mermaids.map((m) => m.pos));
    aiStep(mermaids, dt, _pointerWorld);

    for (let i = 0; i < mermaids.length; i++) {
      const m = mermaids[i]!;
      const fleeing = m.alarm > 0.25;
      const swimAmp =
        0.09 + m.speed * 0.05 + (fleeing ? 0.07 : 0) + m.curiosity * 0.025;

      stepSoftBody(m, dt, swimAmp, t + m.phase * 0.08);

      const bodyPos = m.mesh.geometry.attributes.position as THREE.BufferAttribute;
      deformMeshFromLattice(
        bodyPos,
        m.restVerts,
        m.particles,
        m.influence,
        m.weights,
        restLattices[i]!,
        true,
      );

      const tailPos = m.tailMesh.geometry.attributes
        .position as THREE.BufferAttribute;
      deformMeshFromLattice(
        tailPos,
        m.tailRest,
        m.particles,
        m.tailInfluence,
        m.tailWeights,
        restLattices[i]!,
        false,
      );

      const hairPos = m.hairMesh.geometry.attributes
        .position as THREE.BufferAttribute;
      deformMeshFromLattice(
        hairPos,
        m.hairRest,
        m.particles,
        m.hairInfluence,
        m.hairWeights,
        restLattices[i]!,
        false,
      );

      const detPos = m.detailMesh.geometry.attributes
        .position as THREE.BufferAttribute;
      deformMeshFromLattice(
        detPos,
        m.detailRest,
        m.particles,
        m.detailInfluence,
        m.detailWeights,
        restLattices[i]!,
        true,
      );

      const armPos = m.armMesh.geometry.attributes.position as THREE.BufferAttribute;
      deformMeshFromLattice(
        armPos,
        m.armRest,
        m.particles,
        m.armInfluence,
        m.armWeights,
        restLattices[i]!,
        false,
      );

      const accPos = m.accentMesh.geometry.attributes
        .position as THREE.BufferAttribute;
      deformMeshFromLattice(
        accPos,
        m.accentRest,
        m.particles,
        m.accentInfluence,
        m.accentWeights,
        restLattices[i]!,
        true,
      );

      m.mesh.position.copy(m.pos);
      m.tailMesh.position.copy(m.pos);
      m.hairMesh.position.copy(m.pos);
      m.detailMesh.position.copy(m.pos);
      m.armMesh.position.copy(m.pos);
      m.accentMesh.position.copy(m.pos);

      const bank = THREE.MathUtils.clamp(
        -m.heading.x * 0.38 +
          m.vel.x * 0.022 +
          m.alarm * Math.sin(m.phase) * 0.1,
        -0.38,
        0.38,
      );
      orientMermaid(m.mesh, m.heading, bank);
      m.tailMesh.quaternion.copy(m.mesh.quaternion);
      m.hairMesh.quaternion.copy(m.mesh.quaternion);
      m.detailMesh.quaternion.copy(m.mesh.quaternion);
      m.armMesh.quaternion.copy(m.mesh.quaternion);
      m.accentMesh.quaternion.copy(m.mesh.quaternion);
    }
  });

  return (
    <group ref={group}>
      {mermaids.map((m) => (
        <group key={m.id}>
          <primitive object={m.mesh} />
          <primitive object={m.tailMesh} />
          <primitive object={m.hairMesh} />
          <primitive object={m.detailMesh} />
          <primitive object={m.armMesh} />
          <primitive object={m.accentMesh} />
        </group>
      ))}
    </group>
  );
}
