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
 * Soft-body: Verlet + springs. Head stiff; bust is heavy soft tissue with
 * inertial jiggle; hair + mid-tail flexible; caudal fluke drives lateral
 * undulation (fish-like, not cetacean DV wave).
 *
 * Anatomy calibrated to photoreal reference: heavy dual-lobe bust with
 * forward hang, narrow waist, full hips→scale belt, long flowing hair,
 * bare torso (no shells), teal scale tail with crescent fluke.
 *
 * Behavior:
 *  - Friendly & curious about cursor/pointer (approach, circle, investigate)
 *  - Flee hunting sharks with HIGHER priority and stronger force than curiosity
 *  - Cruise and burst swim faster than great whites
 */

const SURFACE_Y = 12;
const SEABED_Y = -1.5;
const MERMAID_COUNT = 3;
const SPINE_LEN = 72;
const RADIAL = 48;
const SOFT_ITERS = 5;
const BODY_LEN = 6.0;

/**
 * Body fraction landmarks (u: 0 crown → 1 caudal base)
 * Tuned so human half ≈ 40% length, tail ≈ 60% (classic mermaid silhouette).
 */
const U_HEAD_END = 0.09;
const U_NECK_END = 0.13;
const U_SHOULDER = 0.155;
const BUST_U = 0.195;
const U_UNDERBUST = 0.24;
const WAIST_U = 0.295;
const HIP_U = 0.38;
const TORSO_END = 0.42; // scale belt / human→fish blend complete
/** Pin + no undulation through neck (keep face/neck solid) */
const HEAD_FREEZE_U = 0.13;
/** Strong shape retention through bust/waist (anatomy holds while soft) */
const TORSO_RETAIN_U = 0.36;

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
 * Side: crown→brow→chin→neck→clavicle→bust→waist→hips→scale belt→tail→peduncle
 * Front: head ~½ shoulder width; hourglass waist; hip flare; dual bust lobes
 * Top:  shoulder breadth, spine valley, hip width, long tapering tail
 * Bottom: chin/throat, underbust crease, soft belly, ventral scale V
 *
 * Target radii (approx at BODY_LEN=6):
 *   head ~0.17  neck ~0.11  shoulder ~0.38  bust ~0.40  waist ~0.24  hip ~0.42
 */

function smoothstep(e0: number, e1: number, x: number): number {
  const t = THREE.MathUtils.clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

function bodyRadius(u: number): number {
  // ── HEAD: compact sphere (must stay clearly smaller than shoulders)
  if (u < 0.015) return 0.06 + u * 7.5; // crown soft start
  if (u < 0.045) return 0.172 + (u - 0.015) * 0.9; // cranium peak ~0.20
  if (u < 0.07) return 0.199 - (u - 0.045) * 0.6; // temples → cheeks
  if (u < U_HEAD_END) return 0.184 - (u - 0.07) * 2.8; // jaw → chin ~0.13

  // ── NECK: narrow cylinder
  if (u < U_NECK_END) {
    const t = (u - U_HEAD_END) / (U_NECK_END - U_HEAD_END);
    return 0.13 - t * 0.02; // ~0.13 → 0.11
  }

  // ── SHOULDERS: rapid flare
  if (u < U_SHOULDER) {
    const t = (u - U_NECK_END) / (U_SHOULDER - U_NECK_END);
    return 0.11 + smoothstep(0, 1, t) * 0.27; // → ~0.38
  }

  // ── BUST shelf (heavy ribcage; dual lobes added in sampleBodyRing)
  // Reference: very full forward mass relative to shoulders/waist
  if (u < U_UNDERBUST) {
    const t = (u - U_SHOULDER) / (U_UNDERBUST - U_SHOULDER);
    // strong peak near BUST_U then ease into underbust
    const peak = Math.sin(t * Math.PI) * 0.14;
    return 0.40 + peak - t * 0.01; // ~0.40–0.54
  }

  // ── UNDERBUST → WAIST cinch (hourglass)
  if (u < WAIST_U) {
    const t = (u - U_UNDERBUST) / (WAIST_U - U_UNDERBUST);
    return 0.36 - smoothstep(0, 1, t) * 0.12; // → ~0.24
  }

  // ── WAIST → HIPS flare
  if (u < HIP_U) {
    const t = (u - WAIST_U) / (HIP_U - WAIST_U);
    return 0.24 + smoothstep(0, 1, t) * 0.2; // → ~0.44
  }

  // ── HIP → SCALE BELT (blend into fish body, stay full)
  if (u < TORSO_END) {
    const t = (u - HIP_U) / (TORSO_END - HIP_U);
    return 0.44 - t * 0.04; // gentle
  }

  // ── FISH TAIL: long elegant fusiform taper
  if (u < 0.52) {
    const t = (u - TORSO_END) / (0.52 - TORSO_END);
    return 0.4 - t * 0.08; // still full upper tail
  }
  if (u < 0.68) {
    const t = (u - 0.52) / 0.16;
    return 0.32 - t * 0.12; // mid taper
  }
  if (u < 0.82) {
    const t = (u - 0.68) / 0.14;
    return 0.2 - t * 0.08;
  }
  if (u < 0.93) {
    const t = (u - 0.82) / 0.11;
    return 0.12 - t * 0.05; // peduncle
  }
  return 0.07 - (u - 0.93) * 0.25;
}

/** Vertical ellipse — head taller, bust deep, peduncle flattened */
function bodyHeightScale(u: number): number {
  if (u < U_HEAD_END) return 1.12; // skull slightly tall
  if (u < U_NECK_END) return 1.05;
  if (u < U_UNDERBUST) return 1.12 + Math.sin(((u - U_NECK_END) / 0.12) * Math.PI) * 0.22;
  if (u < WAIST_U) return 1.02;
  if (u < HIP_U) return 1.06 + (u - WAIST_U) * 0.4; // hip depth
  if (u < 0.55) return 1.1;
  if (u < 0.8) return 1.05 + (u - 0.55) * 0.15; // mid-tail oval
  return 0.95 - (u - 0.8) * 0.3; // peduncle flatter
}

/** Lateral width — shoulders wide, waist narrow, hips wide */
function bodyWidthScale(u: number): number {
  if (u < U_HEAD_END) return 0.88; // head slightly narrow vs height
  if (u < U_NECK_END) return 0.82;
  if (u < U_SHOULDER) return 0.82 + ((u - U_NECK_END) / (U_SHOULDER - U_NECK_END)) * 0.35;
  if (u < U_UNDERBUST) return 1.12; // shoulder/ribcage width
  if (u < WAIST_U) return 1.12 - ((u - U_UNDERBUST) / (WAIST_U - U_UNDERBUST)) * 0.28; // cinch
  if (u < HIP_U) return 0.84 + ((u - WAIST_U) / (HIP_U - WAIST_U)) * 0.38; // hip width
  if (u < 0.55) return 1.18 - (u - HIP_U) * 0.7;
  if (u < 0.8) return 1.05 - (u - 0.55) * 1.3;
  return 0.72 - (u - 0.8) * 1.0;
}

/**
 * Spine centerline Y — slight lordosis through lumbar, chest lift,
 * gentle S into tail (swimming arch).
 */
function spineYOffset(u: number): number {
  if (u < U_HEAD_END) return 0.03;
  if (u < U_NECK_END) return 0.02;
  // Chest / bust lift
  if (u < U_UNDERBUST) return 0.02 + Math.sin(((u - U_NECK_END) / 0.11) * Math.PI) * 0.035;
  // Lumbar curve (slight swayback)
  if (u < HIP_U) return 0.01 - Math.sin(((u - U_UNDERBUST) / 0.14) * Math.PI) * 0.04;
  // Hip → tail dips then peduncle rises
  if (u < 0.7) return -0.025 - Math.sin(((u - HIP_U) / 0.32) * Math.PI) * 0.05;
  return -0.03 + (u - 0.7) * 0.08;
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
  /** Previous velocity for inertial soft-tissue (breast jiggle, hair lag). */
  prevVel: THREE.Vector3;
  /** Smoothed local acceleration. */
  accel: THREE.Vector3;
  yaw: number;
  pitch: number;
  bank: number;
  speed: number;
  baseSpeed: number;
  phase: number;
  /** Stroke frequency phase (independent of turn phase). */
  strokePhase: number;
  scale: number;
  alarm: number;
  curiosity: number;
  podAngle: number;
  hairHue: number;
  tailHue: number;
  /** Soft-tissue state: breast displacement (secondary motion). */
  bustDisp: THREE.Vector3;
  bustVel: THREE.Vector3;
  /** Hip soft sway residual. */
  hipSway: number;
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

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Half-width / ventral depth / dorsal depth — NOT a radius of revolution. */
function torsoHalf(u: number): { hw: number; df: number; db: number } {
  const keys: [number, number, number, number][] = [
    [U_NECK_END, 0.085, 0.085, 0.085],
    [U_SHOULDER, 0.37, 0.105, 0.095], // wide flat clavicle bar
    [0.175, 0.23, 0.125, 0.115],
    [BUST_U, 0.2, 0.12, 0.11], // ribcage only; breasts added in Cartesian
    [U_UNDERBUST, 0.175, 0.11, 0.1],
    [WAIST_U, 0.125, 0.108, 0.1],
    [HIP_U, 0.245, 0.13, 0.175],
    [TORSO_END, 0.215, 0.135, 0.15],
  ];
  if (u <= keys[0][0]) return { hw: keys[0][1], df: keys[0][2], db: keys[0][3] };
  for (let i = 1; i < keys.length; i++) {
    const [u1, hw1, df1, db1] = keys[i]!;
    const [u0, hw0, df0, db0] = keys[i - 1]!;
    if (u <= u1) {
      const t = smoothstep(u0, u1, u);
      return {
        hw: lerp(hw0, hw1, t),
        df: lerp(df0, df1, t),
        db: lerp(db0, db1, t),
      };
    }
  }
  const last = keys[keys.length - 1]!;
  return { hw: last[1], df: last[2], db: last[3] };
}

function addSphereEnvelope(
  px: number,
  py: number,
  z: number,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
): { x: number; y: number } {
  const dx = px - cx;
  const dy = py - cy;
  const dz = z - cz;
  const d = Math.hypot(dx, dy, dz);
  if (d >= radius || d < 1e-6) return { x: px, y: py };
  const s = radius / d;
  return { x: cx + dx * s, y: cy + dy * s };
}

function sampleBodyRing(
  u: number,
  a: number,
  seed: number,
): { x: number; y: number; z: number; r: number; cy: number } {
  const len = BODY_LEN;
  const z = (u - 0.5) * len;
  const cy = spineYOffset(u);
  const sa = Math.sin(a);
  const ca = Math.cos(a);

  let px: number;
  let py: number;
  let rOut: number;

  if (u < U_NECK_END - 0.012 || u > TORSO_END + 0.05) {
    const r = bodyRadius(u);
    const hy = bodyHeightScale(u);
    const hx = bodyWidthScale(u);
    let faceFlat = 1;
    if (u < U_HEAD_END) {
      if (sa < -0.15) faceFlat = 1.04 + Math.abs(sa) * 0.06;
      else if (sa > 0.4) faceFlat = 1.02;
      const n = 2.2;
      const superR =
        Math.pow(Math.pow(Math.abs(ca), n) + Math.pow(Math.abs(sa), n), 1 / n) || 1;
      faceFlat *= 0.92 / superR + 0.08;
    }
    let eye = 1;
    if (u > 0.03 && u < 0.055) {
      const eu = 1 - Math.abs(u - 0.042) / 0.014;
      const lat = Math.abs(ca);
      if (lat > 0.35 && lat < 0.8 && Math.abs(sa) < 0.55 && sa < 0.35) {
        eye = 1 - eu * 0.28 * (lat - 0.3);
      }
    }
    let nose = 1;
    if (u > 0.035 && u < 0.065 && Math.abs(ca) < 0.22 && sa < -0.35) {
      const t = 1 - Math.abs(u - 0.05) / 0.02;
      nose = 1 + t * 0.1;
    }
    let chin = 1;
    if (u > 0.07 && u < U_HEAD_END && Math.abs(ca) < 0.35 && sa < -0.5) {
      chin = 1.06;
    }
    let ridge = 1;
    if (u > TORSO_END) {
      if (sa > 0.72) ridge = 1 + (sa - 0.72) * 0.28;
      if (sa < -0.75) ridge = 1 + (-sa - 0.75) * 0.12;
    }
    px = ca * r * hx * faceFlat * eye;
    py = sa * r * hy * ridge * eye * nose * chin + cy;
    rOut = r * hy;
  } else {
    const { hw, df, db } = torsoHalf(u);
    const depth = sa < 0 ? df : db;
    const n = sa < 0 ? 2.7 : 2.05;
    const sr =
      Math.pow(Math.pow(Math.abs(ca), n) + Math.pow(Math.abs(sa), n), 1 / n) || 1;
    px = (ca / sr) * hw;
    py = (sa / sr) * depth + cy;

    // Soft belly — modest ventral ease, not a revolved pot
    if (u > U_UNDERBUST && u < HIP_U && sa < -0.2) {
      py -= Math.pow(-sa, 1.2) * 0.025;
    }
    // Spine valley
    if (sa > 0.55 && Math.abs(ca) < 0.28) {
      py -= (sa - 0.55) * 0.035;
    }
    // Navel
    if (u > 0.3 && u < 0.33 && Math.abs(ca) < 0.16 && sa < -0.55) {
      py += 0.018;
    }

    // Breasts: two Cartesian spheres on the front of a flat ribcage
    if (u > 0.155 && u < 0.255 && sa < 0.12) {
      const br = 0.152;
      const hang = cy - df * 0.2 - 0.07;
      const bz = (BUST_U - 0.5) * len + 0.015;
      for (const side of [-1, 1] as const) {
        const hit = addSphereEnvelope(px, py, z, side * 0.128, hang, bz, br);
        if (hit.y < py) {
          px = hit.x;
          py = hit.y;
        }
      }
    }

    // Glutes: two dorsal masses, not a torus
    if (u > 0.33 && u < 0.44 && sa > 0.05) {
      const gr = 0.13;
      const gz = (HIP_U - 0.5) * len;
      for (const side of [-1, 1] as const) {
        const hit = addSphereEnvelope(px, py, z, side * 0.1, cy + db * 0.35, gz, gr);
        if (hit.y > py) {
          px = hit.x;
          py = hit.y;
        }
      }
    }

    rOut = Math.max(hw, df, db);

    if (u > TORSO_END - 0.015) {
      const r = bodyRadius(u);
      const hy = bodyHeightScale(u);
      const hx = bodyWidthScale(u);
      const tx = ca * r * hx;
      const ty = sa * r * hy + cy;
      const t = smoothstep(TORSO_END - 0.015, TORSO_END + 0.05, u);
      px = lerp(px, tx, t);
      py = lerp(py, ty, t);
      rOut = lerp(rOut, r * hy, t);
    }
  }

  const noiseAmt = u < HEAD_FREEZE_U ? 0.0025 : u < TORSO_END ? 0.0045 : 0.01;
  const n =
    1 +
    Math.sin(a * 7 + u * 15 + seed) * noiseAmt +
    Math.sin(a * 17 - u * 11) * noiseAmt * 0.5;

  return { x: px * n, y: py * n, z, r: rOut, cy };
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

  // Non-linear u: densest on head, bust, waist, hips; even on long tail
  for (let s = 0; s <= spineN; s++) {
    const sNorm = s / spineN;
    let u: number;
    if (sNorm < 0.16) {
      // head + neck (0 → U_NECK_END)
      u = (sNorm / 0.16) * U_NECK_END;
    } else if (sNorm < 0.48) {
      // shoulders → hips (U_NECK_END → TORSO_END)
      u = U_NECK_END + ((sNorm - 0.16) / 0.32) * (TORSO_END - U_NECK_END);
    } else {
      // long tail
      u = TORSO_END + ((sNorm - 0.48) / 0.52) * (1 - TORSO_END);
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

  // Crown tip (smaller, sits on skull)
  {
    const tip = positions.length / 3;
    positions.push(0, spineYOffset(0) + 0.08, -len * 0.5 - 0.04);
    colors.push(0.92, 0.78, 0.7);
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

  // Large elegant caudal fluke — crescent lobes (classic mermaid side silhouette)
  {
    const pedZ = len * 0.5 - 0.04;
    const segs = 40;
    const halfSpan = 1.65;
    for (const side of [-1, 1] as const) {
      // Leading edge (sweeping crescent)
      const leadStart = tailPos.length / 3;
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        // Classic mermaid: fluke fans mostly in XY with slight Z depth
        const span = Math.sin(t * Math.PI * 0.94) * halfSpan;
        const flare = Math.pow(t, 0.85);
        const zLead = pedZ + 0.06 + flare * 0.55 + Math.sin(t * Math.PI) * 0.1;
        // Slight vertical lift of outer tips (crescent)
        const yLift = Math.sin(t * Math.PI) * 0.18 * (side > 0 ? 0.15 : -0.05);
        tailPos.push(0.02 * side, 0.0, pedZ + t * 0.08);
        tailPos.push((0.05 + span) * side, yLift, zLead);
      }
      for (let i = 0; i < segs; i++) {
        const a = leadStart + i * 2;
        tailIdx.push(a, a + 1, a + 2);
        tailIdx.push(a + 2, a + 1, a + 3);
      }
      // Trailing scalloped edge (longer, more dramatic)
      const trailStart = tailPos.length / 3;
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const span = Math.sin(t * Math.PI * 0.96) * halfSpan * 1.12;
        const scallop = Math.sin(t * Math.PI * 6) * 0.09 * (1 - t * 0.25);
        const zTrail =
          pedZ + 0.35 + Math.sin(t * Math.PI) * 0.95 + Math.pow(t, 1.4) * 0.25 + scallop;
        const yTrail = Math.sin(t * Math.PI) * 0.08 * side * 0.2 - 0.02;
        tailPos.push((0.06 + span * 0.35) * side, 0.0, pedZ + 0.2 + t * 0.18);
        tailPos.push((0.08 + span) * side, yTrail, zTrail);
      }
      for (let i = 0; i < segs; i++) {
        const a = trailStart + i * 2;
        tailIdx.push(a, a + 1, a + 2);
        tailIdx.push(a + 2, a + 1, a + 3);
      }
    }
    // Mid notch + peduncle web
    {
      const segs = 16;
      const start = tailPos.length / 3;
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const w = 0.04 + t * 0.12;
        const z = pedZ + 0.25 + t * 0.75;
        tailPos.push(-w, 0.006, z);
        tailPos.push(w, 0.006, z);
      }
      for (let i = 0; i < segs; i++) {
        const a = start + i * 2;
        tailIdx.push(a, a + 1, a + 2);
        tailIdx.push(a + 2, a + 1, a + 3);
      }
    }
  }

  // Side hip fins (pelvic) — attach at hip scale belt
  for (const side of [-1, 1] as const) {
    const rootZ = (HIP_U - 0.5) * len + 0.15;
    pushRibbon(
      (t) => [0.36 * side, -0.04 - t * 0.02, rootZ + t * 0.12],
      (t) => {
        const span = Math.sin(t * Math.PI * 0.9) * 0.62;
        return [(0.4 + span) * side, -0.06 - t * 0.38, rootZ + 0.08 + t * 0.5];
      },
      20,
    );
  }

  // Small dorsal fin mid-tail
  {
    const baseZ = (0.58 - 0.5) * len;
    pushRibbon(
      (t) => [0, 0.2, baseZ + t * 0.85],
      (t) => {
        let h: number;
        if (t < 0.32) h = Math.pow(t / 0.32, 0.7);
        else if (t < 0.55) h = 1 - (t - 0.32) * 0.08;
        else h = 0.98 * Math.pow(1 - (t - 0.55) / 0.45, 1.3);
        return [0.01, 0.2 + h * 0.52, baseZ + t * 0.9 + t * t * 0.12];
      },
      24,
    );
  }

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
  const hairStrands = 28;
  const hairSegs = 22;
  const headR = bodyRadius(0.04);
  for (let s = 0; s < hairStrands; s++) {
    const ang = (s / hairStrands) * Math.PI * 2;
    // Head at −Z; face is ventral-front of rings — keep strands off face
    // Prefer occipital / lateral roots
    if (Math.cos(ang) < -0.35 && Math.abs(Math.sin(ang)) < 0.45) continue;

    const rootX = Math.sin(ang) * headR * 0.95;
    const rootY = spineYOffset(0.04) + Math.cos(ang) * headR * 0.55 + 0.04;
    const rootZ = -len * 0.5 + 0.12 + Math.max(0, Math.cos(ang)) * 0.06;

    const start = hairPos.length / 3;
    for (let i = 0; i <= hairSegs; i++) {
      const t = i / hairSegs;
      const spread = t * t * 0.65;
      const hang = t * 1.85 + Math.sin(t * Math.PI) * 0.18;
      const flow = t * 1.45; // toward tail (+Z) — long flowing
      const wave = Math.sin(t * 5.1 + s * 0.7) * t * 0.2;
      const x = rootX * (1 + spread * 0.9) + wave * Math.cos(ang);
      const y = rootY - hang * 0.42 + Math.sin(t * 3.2 + seed) * t * 0.07;
      const z = rootZ + flow + Math.abs(rootX) * t * 0.35;
      const w = 0.022 * (1 - t * 0.45);
      hairPos.push(x - w * Math.cos(ang), y, z);
      hairPos.push(x + w * Math.cos(ang), y + w * 0.35, z + 0.01);
    }
    for (let i = 0; i < hairSegs; i++) {
      const a = start + i * 2;
      hairIdx.push(a, a + 1, a + 2);
      hairIdx.push(a + 2, a + 1, a + 3);
    }
  }
  // Hair volume cap over crown
  {
    const segs = 22;
    const start = hairPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const a = t * Math.PI * 2;
      hairPos.push(0, spineYOffset(0) + 0.1, -len * 0.5 + 0.1);
      hairPos.push(
        Math.sin(a) * headR * 1.05,
        spineYOffset(0) + 0.12 + Math.cos(a) * 0.03,
        -len * 0.5 + 0.1 + Math.cos(a) * headR * 0.35,
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

  /* ── Arms — attach at shoulder ring, swim pose ───────────────── */

  const armPos: number[] = [];
  const armIdx: number[] = [];
  {
    const shoulderZ = (U_SHOULDER - 0.5) * len;
    const shoulderR = bodyRadius(U_SHOULDER) * bodyWidthScale(U_SHOULDER);
    for (const side of [-1, 1] as const) {
      // Swim stroke: arms slightly forward and out
      const shoulder: [number, number, number] = [
        shoulderR * 0.95 * side,
        spineYOffset(U_SHOULDER) + 0.04,
        shoulderZ,
      ];
      const elbow: [number, number, number] = [
        (shoulderR + 0.48) * side,
        -0.08,
        shoulderZ + 0.45,
      ];
      const wrist: [number, number, number] = [
        (shoulderR + 0.62) * side,
        -0.22,
        shoulderZ + 0.95,
      ];
      const hand: [number, number, number] = [
        (shoulderR + 0.68) * side,
        -0.28,
        shoulderZ + 1.22,
      ];

      const chain = [shoulder, elbow, wrist, hand];
      for (let seg = 0; seg < chain.length - 1; seg++) {
        const a0 = chain[seg]!;
        const a1 = chain[seg + 1]!;
        const rad0 = seg === 0 ? 0.065 : seg === 1 ? 0.05 : 0.035;
        const rad1 = seg === 0 ? 0.05 : seg === 1 ? 0.035 : 0.028;
        const segs = 12;
        // Vertical ribbon
        const start = armPos.length / 3;
        for (let i = 0; i <= segs; i++) {
          const t = i / segs;
          const cx = THREE.MathUtils.lerp(a0[0], a1[0], t);
          const cy = THREE.MathUtils.lerp(a0[1], a1[1], t);
          const cz = THREE.MathUtils.lerp(a0[2], a1[2], t);
          const rad = THREE.MathUtils.lerp(rad0, rad1, t);
          armPos.push(cx, cy + rad, cz);
          armPos.push(cx, cy - rad, cz);
        }
        for (let i = 0; i < segs; i++) {
          const a = start + i * 2;
          armIdx.push(a, a + 1, a + 2);
          armIdx.push(a + 2, a + 1, a + 3);
        }
        // Horizontal thickness ribbon
        const start2 = armPos.length / 3;
        for (let i = 0; i <= segs; i++) {
          const t = i / segs;
          const cx = THREE.MathUtils.lerp(a0[0], a1[0], t);
          const cy = THREE.MathUtils.lerp(a0[1], a1[1], t);
          const cz = THREE.MathUtils.lerp(a0[2], a1[2], t);
          const rad = THREE.MathUtils.lerp(rad0, rad1, t);
          armPos.push(cx + rad * 0.75 * side, cy, cz);
          armPos.push(cx - rad * 0.35 * side, cy, cz + rad * 0.25);
        }
        for (let i = 0; i < segs; i++) {
          const a = start2 + i * 2;
          armIdx.push(a, a + 1, a + 2);
          armIdx.push(a + 2, a + 1, a + 3);
        }
      }
      // Fingers
      for (let f = 0; f < 5; f++) {
        const fa = (f - 2) * 0.16;
        const segs = 7;
        const start = armPos.length / 3;
        for (let i = 0; i <= segs; i++) {
          const t = i / segs;
          const x = hand[0] + fa * t * 0.14 * side + t * 0.06 * side;
          const y = hand[1] - t * 0.015;
          const z = hand[2] + t * 0.15;
          armPos.push(x, y + 0.01, z);
          armPos.push(x, y - 0.01, z);
        }
        for (let i = 0; i < segs; i++) {
          const a = start + i * 2;
          armIdx.push(a, a + 1, a + 2);
          armIdx.push(a + 2, a + 1, a + 3);
        }
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

  // Eyes — sit on mid-face rings
  {
    const eyeU = 0.042;
    const eyeZ = (eyeU - 0.5) * len;
    const eyeY = spineYOffset(eyeU) + 0.02;
    const eyeX = bodyRadius(eyeU) * bodyWidthScale(eyeU) * 0.55;
    for (const side of [-1, 1] as const) {
      pushRing(side * eyeX, eyeY, eyeZ, 0.032, 0.026, 14);
      pushRing(side * eyeX, eyeY, eyeZ + 0.015, 0.014, 0.012, 10);
    }
  }

  // Lips
  {
    const segs = 16;
    const start = dPos.length / 3;
    const lipU = 0.072;
    const z = (lipU - 0.5) * len;
    const y0 = spineYOffset(lipU) - bodyRadius(lipU) * 0.35;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const x = (t - 0.5) * 0.08;
      const y = y0 + Math.sin(t * Math.PI) * 0.01;
      dPos.push(x, y, z);
      dPos.push(x, y - 0.014, z + 0.008);
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
    const z0 = (U_NECK_END - 0.5) * len;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const x = side * t * bodyRadius(U_SHOULDER) * 0.85;
      const y = spineYOffset(U_NECK_END) + 0.06 - t * 0.05;
      const z = z0 + t * 0.12;
      dPos.push(x, y, z);
      dPos.push(x, y - 0.018, z + 0.015);
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      dIdx.push(a, a + 1, a + 2);
      dIdx.push(a + 2, a + 1, a + 3);
    }
  }

  // Areola rings sit on the rounded lobe surface
  for (const side of [-1, 1] as const) {
    const segs = 14;
    const start = dPos.length / 3;
    const hit = sampleBodyRing(BUST_U, -Math.PI * 0.5 + side * 0.52, 0);
    const cx = hit.x;
    const cy = hit.y;
    const cz = hit.z;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const a = t * Math.PI * 2;
      dPos.push(cx, cy, cz);
      dPos.push(
        cx + Math.cos(a) * 0.05,
        cy + Math.sin(a) * 0.042,
        cz + 0.008,
      );
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      dIdx.push(a, a + 1, a + 2);
      dIdx.push(a + 2, a + 1, a + 3);
    }
  }

  // Navel
  {
    const navelU = 0.315;
    pushRing(
      0,
      spineYOffset(navelU) - bodyRadius(navelU) * bodyHeightScale(navelU) * 0.55,
      (navelU - 0.5) * len,
      0.02,
      0.016,
      10,
    );
  }

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
  // Ear fins (auricle)
  for (const side of [-1, 1] as const) {
    const segs = 14;
    const start = aPos.length / 3;
    const rootX = bodyRadius(0.05) * bodyWidthScale(0.05) * 0.95 * side;
    const rootY = spineYOffset(0.05);
    const rootZ = (0.05 - 0.5) * len;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const x = rootX + side * t * 0.16;
      const y = rootY + Math.sin(t * Math.PI) * 0.1;
      const z = rootZ + t * 0.04;
      aPos.push(rootX, rootY, rootZ);
      aPos.push(x, y, z);
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      aIdx.push(a, a + 1, a + 2);
      aIdx.push(a + 2, a + 1, a + 3);
    }
  }
  // Necklace at clavicle
  {
    const segs = 22;
    const start = aPos.length / 3;
    const neckZ = (U_NECK_END - 0.5) * len + 0.04;
    const neckY = spineYOffset(U_NECK_END) - 0.02;
    const neckR = bodyRadius(U_NECK_END) * 1.15;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const a = -1.0 + t * 2.0;
      aPos.push(Math.sin(a) * neckR, neckY + Math.cos(a) * 0.03, neckZ);
      aPos.push(Math.sin(a) * (neckR + 0.025), neckY - 0.03 + Math.cos(a) * 0.04, neckZ + 0.02);
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
  const spineCount = 30;
  const radial = 18;
  const particles: SoftParticle[] = [];
  const springs: SoftSpring[] = [];

  for (let s = 0; s < spineCount; s++) {
    const u = s / (spineCount - 1);
    const z = (u - 0.5) * len;
    const cy = spineYOffset(u);
    // Pin head+neck solid; pin lightly through upper chest so bust silhouette holds
    const pin = u <= HEAD_FREEZE_U;
    particles.push(makeParticle(0, cy, z, pin));
    for (let k = 0; k < radial; k++) {
      const a = (k / radial) * Math.PI * 2;
      // Use full anatomical sample for rest lattice (bust/hips included)
      const p = sampleBodyRing(u, a, 0);
      particles.push(makeParticle(p.x, p.y, p.z, pin));
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
    // Heavy soft tissue through bust — low stiffness for realistic jiggle
    const inBust = u > 0.15 && u < 0.28;
    const torsoStiff = inBust ? 0.82 : u < TORSO_RETAIN_U ? 1.12 : 1;
    for (let k = 0; k < radial; k++) {
      addSpring(base, base + 1 + k, 0.94 * torsoStiff);
      addSpring(base + 1 + k, base + 1 + ((k + 1) % radial), 0.9 * torsoStiff);
      addSpring(base + 1 + k, base + 1 + ((k + 2) % radial), inBust ? 0.48 : 0.55);
      addSpring(base + 1 + k, base + 1 + ((k + 3) % radial), inBust ? 0.32 : 0.38);
    }
    if (s < spineCount - 1) {
      const next = (s + 1) * ringSize;
      const longStiff = u > 0.65 ? 0.8 : u < TORSO_RETAIN_U ? 1.0 : 0.94;
      addSpring(base, next, longStiff);
      for (let k = 0; k < radial; k++) {
        addSpring(base + 1 + k, next + 1 + k, u > 0.65 ? 0.55 : 0.8);
        addSpring(base + 1 + k, next + 1 + ((k + 1) % radial), 0.45);
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
    prevVel: heading.clone().multiplyScalar(baseSpeed),
    accel: new THREE.Vector3(),
    yaw,
    pitch: 0,
    bank: 0,
    speed: baseSpeed,
    baseSpeed,
    phase: seeded(seed + 6) * Math.PI * 2,
    strokePhase: seeded(seed + 7) * Math.PI * 2,
    scale,
    alarm: 0,
    curiosity: 0.45 + seeded(seed + 8) * 0.4,
    podAngle: angle,
    hairHue,
    tailHue,
    bustDisp: new THREE.Vector3(),
    bustVel: new THREE.Vector3(),
    hipSway: 0,
  };
}

/* ── Soft-body + realistic swim ─────────────────────────────────── */

const _diff = new THREE.Vector3();

/**
 * Traveling lateral S-wave for mermaid locomotion.
 * Power from hips → peduncle; shoulders counter-sway slightly.
 * Soft tissue: breast jiggle from world accel + stroke; hip sway.
 */
function stepSoftBody(m: MermaidSim, dt: number, swimAmp: number, t: number) {
  dt = Math.min(Math.max(dt, 1 / 240), 1 / 48);
  const particles = m.particles;
  const ringSize = 1 + m.radial;
  const damp = Math.pow(0.905, dt * 60);

  // Inertial soft tissue from acceleration
  const invDt = 1 / Math.max(dt, 1e-4);
  const ax = (m.vel.x - m.prevVel.x) * invDt;
  const ay = (m.vel.y - m.prevVel.y) * invDt;
  const az = (m.vel.z - m.prevVel.z) * invDt;
  m.accel.x += (ax - m.accel.x) * 0.45;
  m.accel.y += (ay - m.accel.y) * 0.45;
  m.accel.z += (az - m.accel.z) * 0.45;
  m.prevVel.copy(m.vel);

  const fwdX = m.heading.x;
  const fwdZ = m.heading.z;
  const rightX = -fwdZ;
  const rightZ = fwdX;
  const aLat = m.accel.x * rightX + m.accel.z * rightZ;
  const aUp = m.accel.y;
  const aFwd = m.accel.x * fwdX + m.accel.z * fwdZ;

  // Heavy breast soft-tissue spring-damper (photoreal ref secondary motion)
  // Lower stiffness + higher drive = visible lag, overshoot, settle
  const bustStiff = 22;
  const bustDamp = 5.2;
  const driveY =
    -aUp * 0.022 -
    aFwd * 0.008 +
    Math.sin(m.strokePhase * 2) * swimAmp * 0.07 * (0.55 + m.speed * 0.18) +
    m.bank * 0.035;
  const driveX =
    -aLat * 0.028 +
    Math.sin(m.strokePhase) * swimAmp * 0.04 * m.speed * 0.12 +
    m.bank * 0.07;

  m.bustVel.x += (driveX - m.bustDisp.x * bustStiff - m.bustVel.x * bustDamp) * dt;
  m.bustVel.y += (driveY - m.bustDisp.y * bustStiff - m.bustVel.y * bustDamp) * dt;
  m.bustVel.z +=
    (-aFwd * 0.006 - m.bustDisp.z * (bustStiff * 1.15) - m.bustVel.z * bustDamp) * dt;
  m.bustDisp.x += m.bustVel.x * dt;
  m.bustDisp.y += m.bustVel.y * dt;
  m.bustDisp.z += m.bustVel.z * dt;
  // Wider travel for heavy tissue (still clamped so lattice doesn't collapse)
  m.bustDisp.x = THREE.MathUtils.clamp(m.bustDisp.x, -0.22, 0.22);
  m.bustDisp.y = THREE.MathUtils.clamp(m.bustDisp.y, -0.26, 0.16);
  m.bustDisp.z = THREE.MathUtils.clamp(m.bustDisp.z, -0.14, 0.14);

  const hipTarget = Math.sin(m.strokePhase - 0.4) * swimAmp * 0.55;
  m.hipSway += (hipTarget - m.hipSway) * Math.min(1, dt * 8);

  // Traveling swim wave along spine
  for (let s = 0; s < m.spineCount; s++) {
    const u = s / (m.spineCount - 1);
    if (u <= HEAD_FREEZE_U) continue;

    const base = s * ringSize;

    let envelope: number;
    if (u < TORSO_RETAIN_U) {
      envelope = -0.14 * smoothstep(HEAD_FREEZE_U, TORSO_RETAIN_U, u);
    } else if (u < TORSO_END) {
      envelope = 0.35 * smoothstep(TORSO_RETAIN_U, TORSO_END, u);
    } else {
      const tu = (u - TORSO_END) / (1 - TORSO_END);
      envelope = 0.35 + Math.pow(tu, 1.35) * 1.95;
    }

    const wave =
      Math.sin(u * 4.6 - m.strokePhase * 1.15 - t * 0.12 + m.phase * 0.2) *
      swimAmp *
      envelope;
    const wave2 =
      Math.sin(u * 7.2 - m.strokePhase * 1.6 + m.phase) *
      swimAmp *
      0.2 *
      Math.max(0, envelope);
    const flukeKick =
      u > 0.7
        ? Math.sin(u * 3.2 - m.strokePhase * 1.1) *
          swimAmp *
          0.38 *
          Math.pow((u - 0.7) / 0.3, 1.4)
        : 0;

    const lat = (wave + wave2) * dt * 2.85;
    const vert = flukeKick * dt * 2.25;

    const center = particles[base]!;
    if (!center.pinned) {
      center.x += lat + m.hipSway * Math.max(0, u - 0.3) * 0.15 * dt * 8;
      center.y += vert;
    }

    for (let k = 0; k < m.radial; k++) {
      const q = particles[base + 1 + k]!;
      if (q.pinned) continue;
      const a = (k / m.radial) * Math.PI * 2;
      const sa = Math.sin(a);
      const ca = Math.cos(a);

      q.x += lat * 0.95;
      q.y += vert * 0.9;

      // Breast soft-body (ventral dual lobes)
      if (u > 0.155 && u < 0.27 && sa < 0.15) {
        const wL = Math.max(0, 1 - Math.hypot(ca - 0.45, (u - BUST_U) / 0.05));
        const wR = Math.max(0, 1 - Math.hypot(ca + 0.45, (u - BUST_U) / 0.05));
        const w = Math.max(wL, wR) * Math.max(0, -sa + 0.15);
        if (w > 0.02) {
          const sideSign = ca >= 0 ? 1 : -1;
          const lobePhase = sideSign * 0.2;
          const jiggleX =
            m.bustDisp.x * w * 0.7 +
            Math.sin(m.strokePhase + lobePhase) * swimAmp * 0.025 * w * m.speed * 0.1;
          const jiggleY =
            m.bustDisp.y * w * 0.8 +
            Math.sin(m.strokePhase * 2 + lobePhase * 1.4) * swimAmp * 0.035 * w;
          const jiggleZ = m.bustDisp.z * w * 0.55;
          const k = Math.min(dt * 36, 0.65);

          q.x += jiggleX * k;
          q.y += jiggleY * k;
          q.z += jiggleZ * k * 0.7;
          q.x -= aLat * 0.00035 * w * k;
          q.y -= aUp * 0.0004 * w * k;
        }
      }

      // Soft belly
      if (u > 0.24 && u < 0.34 && sa < -0.35) {
        const bw = (-sa - 0.35) * (1 - Math.abs(u - 0.29) / 0.06);
        if (bw > 0) {
          q.y += m.bustDisp.y * 0.28 * bw * dt * 30;
          q.x += m.bustDisp.x * 0.16 * bw * dt * 25;
        }
      }

      // Hip soft flesh
      if (u > 0.33 && u < 0.48) {
        const hw = 1 - Math.abs(u - HIP_U) / 0.1;
        if (hw > 0) {
          q.x += m.hipSway * 0.09 * hw * Math.abs(ca) * dt * 20;
          q.y += Math.sin(m.strokePhase * 2 + 0.5) * swimAmp * 0.016 * hw * dt * 15;
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
      const cy = spineYOffset(u);
      const base = s * ringSize;
      const center = particles[base]!;

      let retain: number;
      if (u <= HEAD_FREEZE_U) retain = 0.55;
      else if (u > 0.15 && u < 0.28) retain = 0.09;
      else if (u < TORSO_RETAIN_U) retain = 0.14;
      else if (u < TORSO_END) retain = 0.08;
      else if (u > 0.8) retain = 0.03;
      else retain = 0.048;

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
        const rest = sampleBodyRing(u, a, 0);
        if (q.pinned) {
          q.x = rest.x;
          q.y = rest.y;
          q.z = rest.z;
        } else {
          const sa = Math.sin(a);
          let rs: number;
          if (u <= HEAD_FREEZE_U) rs = 0.28;
          else if (u > 0.15 && u < 0.28 && sa < -0.04) rs = 0.07;
          else if (u < TORSO_RETAIN_U) rs = 0.1;
          else if (u < TORSO_END) rs = 0.06;
          else rs = 0.036;

          q.x += (rest.x - q.x) * rs;
          q.y += (rest.y - q.y) * rs;
          q.z += (rest.z - q.z) * rs;
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
    // Hair lag + strong bust secondary-motion boost (heavy tissue)
    const hairBoost = ry > 0.12 && rz < -BODY_LEN * 0.1 ? 1.7 : 1;
    const uApprox = rz / BODY_LEN + 0.5;
    const bustBoost =
      hairBoost <= 1 && uApprox > 0.14 && uApprox < 0.29 && ry < 0.08 ? 1.55 : 1;
    const boost = hairBoost * bustBoost;
    arr[v * 3] = rx + dx * boost;
    arr[v * 3 + 1] = ry + dy * boost;
    arr[v * 3 + 2] = rz + dz * boost;
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

    // Stroke rate scales with speed
    const strokeRate = 2.9 + m.speed * 1.45 + m.alarm * 1.4;
    m.strokePhase += dt * strokeRate;
    m.phase += dt * (3.2 + m.speed * 2.1 + m.alarm * 1.5);

    // Bank into turns + residual stroke roll
    const turn = THREE.MathUtils.clamp(m.vel.x * 0.04 - m.heading.x * 0.35, -0.4, 0.4);
    const strokeRoll = Math.sin(m.strokePhase) * 0.06 * (0.6 + m.speed * 0.12);
    const targetBank = turn + strokeRoll + m.alarm * Math.sin(m.phase) * 0.08;
    m.bank += (targetBank - m.bank) * Math.min(1, dt * 6);

    // Subtle porpoising bob
    m.pos.y += Math.sin(m.strokePhase * 0.5) * 0.012 * m.speed * dt * 8;
  }
}

function orientMermaid(
  mesh: THREE.Object3D,
  heading: THREE.Vector3,
  bank: number,
  pitchBoost = 0,
) {
  _fwd.copy(heading).normalize();
  if (pitchBoost !== 0) {
    _fwd.y = THREE.MathUtils.clamp(_fwd.y + pitchBoost, -0.85, 0.85);
    _fwd.normalize();
  }
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
        0.13 + m.speed * 0.075 + (fleeing ? 0.1 : 0) + m.curiosity * 0.035;

      stepSoftBody(m, dt, swimAmp, t);

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

      // Arm swim stroke on distal verts
      {
        const arr = m.armMesh.geometry.attributes.position.array as Float32Array;
        const stroke = Math.sin(m.strokePhase);
        const stroke2 = Math.sin(m.strokePhase * 2);
        for (let v = 0; v < arr.length / 3; v++) {
          const z = m.armRest[v * 3 + 2]!;
          const distal = THREE.MathUtils.clamp((z + 1.2) / 2.2, 0, 1);
          arr[v * 3]! += stroke * 0.045 * distal;
          arr[v * 3 + 1]! += stroke2 * 0.032 * distal;
        }
        (m.armMesh.geometry.attributes.position as THREE.BufferAttribute).needsUpdate =
          true;
      }

      const pitchBob =
        Math.sin(m.strokePhase * 0.5) * 0.05 * (0.5 + m.speed * 0.1);
      orientMermaid(m.mesh, m.heading, m.bank, m.pitch * 0.15 + pitchBob);
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
