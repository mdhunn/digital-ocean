import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import {
  registerDolphinPositions,
  sharkWorldPositions,
} from "./creatureRegistry";

/**
 * High-polygon bottlenose dolphins (Tursiops truncatus).
 * Anatomy refined from multi-angle refs (side, dorsal, ventral, frontal):
 *
 * Proportions (u along body, snout→fluke):
 *  0.00–0.14  elongated rostrum (beak), dorsoventrally flattened
 *  0.14–0.24  melon forehead + cranium, blowhole on dorsal
 *  0.24–0.36  cervical / pectoral root (flippers)
 *  0.36–0.55  max girth midbody; falcate dorsal base ~0.42–0.55
 *  0.55–0.78  gradual taper
 *  0.78–0.96  caudal peduncle (laterally compressed for fluke stroke)
 *  0.96–1.00  fluke insertion + horizontal crescent flukes
 *
 * Soft-body Verlet + springs; dorsoventral swim; curious / flee sharks.
 */

const SURFACE_Y = 12;
const SEABED_Y = -1.5;
const DOLPHIN_COUNT = 4;
const SPINE_LEN = 52;
const RADIAL = 40;
const SOFT_ITERS = 4;
const BODY_LEN = 5.4;

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

/* ── Anatomical profile (Tursiops) ───────────────────────────────
 * Base radius follows fusiform hydrodynamics; height/width scales
 * reshape cross-section: flat beak, round melon, tall peduncle.
 */

function bodyRadius(u: number): number {
  // Long slender beak
  if (u < 0.04) return 0.018 + u * 0.55;
  if (u < 0.1) return 0.04 + (u - 0.04) * 0.95;
  if (u < 0.14) return 0.097 + (u - 0.1) * 2.1;
  // Melon / head swell (not as fat as midbody)
  if (u < 0.2) return 0.181 + (u - 0.14) * 4.6;
  if (u < 0.28) return 0.457 + (u - 0.2) * 2.35;
  // Shoulder → max girth just ahead of dorsal
  if (u < 0.4) return 0.645 + (u - 0.28) * 1.05;
  if (u < 0.5) return 0.771 + (u - 0.4) * 0.18;
  // Peak ~0.48–0.5 then slow taper
  if (u < 0.62) return 0.789 - (u - 0.5) * 0.55;
  if (u < 0.75) return 0.723 - (u - 0.62) * 1.45;
  // Peduncle slim
  if (u < 0.88) return 0.534 - (u - 0.75) * 2.05;
  if (u < 0.96) return 0.268 - (u - 0.88) * 1.35;
  return 0.16 - (u - 0.96) * 0.9;
}

/** Vertical ellipse — beak flat, mid tall, peduncle tall for fluke power */
function bodyHeightScale(u: number): number {
  if (u < 0.12) return 0.52 + u * 2.8; // dorsoventrally flattened rostrum
  if (u < 0.18) return 0.856 + (u - 0.12) * 2.6; // melon rises
  if (u < 0.28) return 1.012 + (u - 0.18) * 0.55;
  if (u < 0.5) return 1.067 + (u - 0.28) * 0.22;
  if (u < 0.7) return 1.115 - (u - 0.5) * 0.15;
  if (u < 0.88) return 1.085 + (u - 0.7) * 0.35; // peduncle gets taller relatively
  return 1.148 + (u - 0.88) * 0.4;
}

/** Lateral width — beak narrow, mid full, peduncle compressed */
function bodyWidthScale(u: number): number {
  if (u < 0.12) return 0.72 + u * 1.4;
  if (u < 0.22) return 0.888 + (u - 0.12) * 0.7;
  if (u < 0.4) return 0.958 + (u - 0.22) * 0.15;
  if (u < 0.55) return 0.985;
  if (u < 0.75) return 0.985 - (u - 0.55) * 0.55;
  if (u < 0.9) return 0.875 - (u - 0.75) * 1.4; // lateral compression
  return 0.665 - (u - 0.9) * 1.2;
}

/** Spine centerline Y offset — slight melon rise, chin, peduncle dip */
function spineYOffset(u: number): number {
  // Melon dome lifts dorsal midline
  const melon = u > 0.12 && u < 0.26 ? Math.sin(((u - 0.12) / 0.14) * Math.PI) * 0.07 : 0;
  // Slight belly sag midbody (natural underwater posture)
  const belly = u > 0.28 && u < 0.7 ? -Math.sin(((u - 0.28) / 0.42) * Math.PI) * 0.035 : 0;
  // Peduncle slightly rises into fluke
  const ped = u > 0.8 ? (u - 0.8) * 0.06 : 0;
  return melon + belly + ped;
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

/* ── Countershading + cape cape ────────────────────────────────── */

function countershadeColor(y: number, r: number, u: number, out: THREE.Color) {
  const ny = y / Math.max(r, 0.04);
  // Classic bottlenose: dark dorsal cape, medium flank, pale pink-white belly
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
    // Dorsal cape — darker slate
    out.setRGB(0.36, 0.44, 0.52);
  }
  // Slightly lighter rostrum tip / chin
  if (u < 0.12) {
    out.lerp(new THREE.Color(0.78, 0.82, 0.86), 0.28);
  }
  // Darker dorsal fin region cape
  if (u > 0.38 && u < 0.58 && ny > 0.35) {
    out.lerp(new THREE.Color(0.3, 0.38, 0.46), 0.25);
  }
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

  for (let s = 0; s <= spineN; s++) {
    const u = s / spineN;
    const z = (u - 0.5) * len;
    const r = bodyRadius(u);
    const hy = bodyHeightScale(u);
    const hx = bodyWidthScale(u);
    const cy = spineYOffset(u);

    for (let k = 0; k <= radN; k++) {
      const a = (k / radN) * Math.PI * 2;
      // Angle: 0 = +X (right), π/2 = +Y (dorsal), π = −X, 3π/2 = −Y (ventral)

      // Melon: bulbous forehead (dorsal only, u ~0.12–0.24)
      let melon = 1;
      if (u > 0.11 && u < 0.26) {
        const mu = (u - 0.11) / 0.15;
        const dorsal = Math.max(0, Math.sin(a)); // upper half
        melon = 1 + Math.sin(mu * Math.PI) * dorsal * dorsal * 0.32;
      }

      // Chin / lower jaw pad under beak
      let chin = 1;
      if (u > 0.02 && u < 0.14 && Math.sin(a) < -0.2) {
        const cu = (u - 0.02) / 0.12;
        chin = 1 + Math.sin(cu * Math.PI) * Math.abs(Math.sin(a)) * 0.12;
      }

      // Rostrum: more rectangular cross-section (flatten top & bottom)
      let beakShape = 1;
      if (u < 0.13) {
        const flat = Math.pow(Math.abs(Math.sin(a)), 0.65);
        beakShape = 0.72 + flat * 0.35;
      }

      // Soft rounded belly (ventral fill)
      const belly =
        Math.sin(a) < -0.15
          ? 0.92 + Math.abs(Math.sin(a)) * 0.05
          : 1;

      // Subtle dorsal ridge from midbody through peduncle
      let ridge = 1;
      if (u > 0.3 && Math.sin(a) > 0.75) {
        ridge = 1 + (Math.sin(a) - 0.75) * 0.14;
      }

      // Eye socket indent (lateral, just behind gape)
      let eyeSocket = 1;
      if (u > 0.16 && u < 0.22) {
        const eu = Math.abs(u - 0.19) / 0.03;
        const lat = Math.abs(Math.cos(a));
        if (lat > 0.7 && Math.abs(Math.sin(a)) < 0.45) {
          eyeSocket = 1 - (1 - eu) * (lat - 0.7) * 0.35;
        }
      }

      // Flipper root bulge (lateral, u ~0.28)
      let flipperRoot = 1;
      if (u > 0.25 && u < 0.34) {
        const fu = 1 - Math.abs(u - 0.29) / 0.05;
        const lat = Math.abs(Math.cos(a));
        if (lat > 0.55 && Math.sin(a) < 0.2) {
          flipperRoot = 1 + fu * (lat - 0.55) * 0.22;
        }
      }

      const px =
        Math.cos(a) * r * hx * belly * beakShape * eyeSocket * flipperRoot;
      const py =
        Math.sin(a) * r * hy * melon * chin * ridge * beakShape * eyeSocket +
        cy;

      // Micro organic noise (high-poly feel)
      const n =
        1 +
        Math.sin(a * 6 + u * 13 + seed) * 0.008 +
        Math.sin(a * 15 - u * 9) * 0.005 +
        Math.cos(a * 3 + u * 7) * 0.004;

      positions.push(px * n, py * n, z);
      countershadeColor(py - cy, r * hy, u, col);
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

  // Rostrum tip — slightly downturned (real bottlenose beak tip)
  const tip = positions.length / 3;
  positions.push(0, -0.03, -len * 0.5 - 0.28);
  colors.push(0.8, 0.84, 0.88);
  for (let k = 0; k < radN; k++) {
    indices.push(tip, k + 1, k);
  }

  // Snout tip ring fill for rounded beak end
  const tipRing = positions.length / 3;
  for (let k = 0; k < radN; k++) {
    const a = (k / radN) * Math.PI * 2;
    positions.push(
      Math.cos(a) * 0.035,
      Math.sin(a) * 0.022 - 0.02,
      -len * 0.5 - 0.12,
    );
    colors.push(0.78, 0.82, 0.86);
  }
  for (let k = 0; k < radN; k++) {
    indices.push(tip, tipRing + k, tipRing + ((k + 1) % radN));
  }

  const body = new THREE.BufferGeometry();
  body.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  body.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  body.setIndex(indices);
  body.computeVertexNormals();

  /* ── Fins: falcate dorsal + sickle pectorals ──────────────────── */

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

  // Dorsal fin — tall falcate, mid-back (refs: curved trailing edge, tip aft)
  // Base sits on body surface ~ y=0.55–0.62 at u~0.42–0.55 → z ≈ (u-0.5)*len
  {
    const baseZ0 = -0.2; // leading root
    const baseZ1 = 0.95; // trailing root
    const baseY = 0.58;
    const height = 1.05;
    const segs = 28;

    // Outer silhouette
    pushRibbon(
      (t) => {
        const z = THREE.MathUtils.lerp(baseZ0, baseZ1, t);
        // Base follows slight body curve
        const yBase = baseY - Math.sin(t * Math.PI) * 0.04;
        return [0, yBase, z];
      },
      (t) => {
        // Falcate profile: steep leading, concave trailing, tip leans aft
        let edge: number;
        if (t < 0.32) {
          edge = Math.pow(t / 0.32, 0.72);
        } else if (t < 0.55) {
          edge = 1 - (t - 0.32) * 0.08;
        } else {
          edge = 0.978 * Math.pow(1 - (t - 0.55) / 0.45, 1.35);
        }
        const tipLean = Math.pow(t, 1.1) * 0.32; // tip points aft
        const z = THREE.MathUtils.lerp(baseZ0, baseZ1, t) + tipLean;
        const y = baseY + height * edge;
        // Slight thickness
        return [0.018, y, z];
      },
      segs,
    );

    // Mid thickness membrane (high-poly)
    pushRibbon(
      (t) => {
        const z = THREE.MathUtils.lerp(baseZ0, baseZ1, t);
        return [0.04, baseY + 0.06, z];
      },
      (t) => {
        let edge: number;
        if (t < 0.32) edge = Math.pow(t / 0.32, 0.72);
        else if (t < 0.55) edge = 1 - (t - 0.32) * 0.08;
        else edge = 0.978 * Math.pow(1 - (t - 0.55) / 0.45, 1.35);
        const tipLean = Math.pow(t, 1.1) * 0.28;
        return [
          0.012,
          baseY + height * edge * 0.72,
          THREE.MathUtils.lerp(baseZ0, baseZ1, t) + tipLean,
        ];
      },
      segs,
    );

    // Leading-edge spar
    pushRibbon(
      (t) => [0, baseY + t * 0.08, baseZ0 + t * 0.05],
      (t) => {
        const edge = Math.pow(Math.min(t * 1.4, 1), 0.75);
        return [0.01, baseY + height * edge * 0.95, baseZ0 + t * 0.55 + edge * 0.15];
      },
      16,
    );
  }

  // Pectoral flippers — sickle/curved, long, tapered (side + ventral refs)
  // Root near u~0.28 → z = (0.28-0.5)*len ≈ -1.19
  for (const side of [-1, 1] as const) {
    const segs = 26;
    const rootZ = -1.15;
    const rootY = -0.1;
    const rootX = 0.42;

    // Main flipper blade — long chord, curved trailing, pointed tip
    pushRibbon(
      (t) => {
        // Root attachment line along body
        const z = rootZ + t * 0.35;
        return [rootX * side * (0.95 + t * 0.05), rootY - t * 0.04, z];
      },
      (t) => {
        // Span grows then tip tapers; swept aft; slight droop
        const span = Math.sin(t * Math.PI * 0.88) * 1.25 * (1 - t * 0.08);
        const sweep = t * 0.72; // aft sweep
        const droop = t * 0.48 + span * 0.1;
        // Leading edge more forward than trailing
        const leadBias = (1 - t) * 0.12;
        return [
          (rootX + span) * side,
          rootY - droop,
          rootZ + sweep - leadBias + t * 0.15,
        ];
      },
      segs,
    );

    // Trailing membrane (concave trailing edge of real flipper)
    pushRibbon(
      (t) => [
        rootX * 1.05 * side,
        rootY - 0.02,
        rootZ + 0.12 + t * 0.3,
      ],
      (t) => {
        const span = Math.sin(t * Math.PI * 0.9) * 0.95;
        const sweep = t * 0.85;
        return [
          (rootX + span) * side,
          rootY - t * 0.42 - span * 0.08,
          rootZ + 0.2 + sweep,
        ];
      },
      segs,
    );

    // Leading-edge ridge (stiffer leading edge of flipper)
    pushRibbon(
      (t) => [rootX * side, rootY, rootZ + t * 0.15],
      (t) => {
        const span = t * 1.15;
        return [
          (rootX + span) * side,
          rootY - t * 0.35,
          rootZ - 0.08 + t * 0.55,
        ];
      },
      18,
    );
  }

  const fins = new THREE.BufferGeometry();
  fins.setAttribute("position", new THREE.Float32BufferAttribute(finPos, 3));
  fins.setIndex(finIdx);
  fins.computeVertexNormals();

  /* ── Horizontal flukes — crescent, median notch, wide span ───── */

  const flukePos: number[] = [];
  const flukeIdx: number[] = [];
  {
    const pedZ = len * 0.5 - 0.08; // peduncle tip
    const segs = 32;
    const halfSpan = 1.35;

    for (const side of [-1, 1] as const) {
      // Leading edge of fluke (from peduncle out to tip)
      const leadStart = flukePos.length / 3;
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        // Span distribution — broad mid-lobe, rounded tip
        const span = Math.sin(t * Math.PI * 0.5) * halfSpan; // 0→1 quarter then...
        // Actually classic fluke: chord length peaks mid-lobe
        const x = (0.04 + Math.sin(t * Math.PI * 0.92) * halfSpan) * side;
        // Leading edge curves slightly forward then aft
        const zLead = pedZ + 0.05 + t * 0.55 + Math.sin(t * Math.PI) * 0.08;
        // Thin foil section
        flukePos.push(0.02 * side, 0.015, pedZ + t * 0.12);
        flukePos.push(x, Math.sin(t * Math.PI) * 0.02 * side * 0.15, zLead);
      }
      for (let i = 0; i < segs; i++) {
        const a = leadStart + i * 2;
        flukeIdx.push(a, a + 1, a + 2);
        flukeIdx.push(a + 2, a + 1, a + 3);
      }

      // Trailing edge crescent (concave aft margin + tip)
      const trailStart = flukePos.length / 3;
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const span = Math.sin(t * Math.PI * 0.95) * halfSpan;
        // Crescent trailing: mid-lobe further aft, notch near center, tip rounded
        const zTrail =
          pedZ +
          0.35 +
          Math.sin(t * Math.PI) * 0.72 +
          Math.pow(t, 1.6) * 0.15;
        flukePos.push(
          (0.06 + span * 0.35) * side,
          0,
          pedZ + 0.2 + t * 0.25,
        );
        flukePos.push((0.08 + span) * side, -0.01, zTrail);
      }
      for (let i = 0; i < segs; i++) {
        const a = trailStart + i * 2;
        flukeIdx.push(a, a + 1, a + 2);
        flukeIdx.push(a + 2, a + 1, a + 3);
      }

      // Chord fill ribs (high-poly structure)
      for (let rib = 0; rib < 8; rib++) {
        const t0 = (rib + 0.5) / 8;
        const span = Math.sin(t0 * Math.PI * 0.92) * halfSpan;
        const x = (0.08 + span) * side;
        const zL = pedZ + 0.08 + t0 * 0.5;
        const zT = pedZ + 0.35 + Math.sin(t0 * Math.PI) * 0.68;
        const rs = flukePos.length / 3;
        flukePos.push(x * 0.4, 0.02, zL);
        flukePos.push(x, 0, (zL + zT) * 0.5);
        flukePos.push(x * 0.5, -0.015, zT);
        flukePos.push(x * 0.25, 0, zL + 0.05);
        flukeIdx.push(rs, rs + 1, rs + 3);
        flukeIdx.push(rs + 1, rs + 2, rs + 3);
      }
    }

    // Median notch (distinctive cetacean fluke notch)
    {
      const segs = 12;
      const start = flukePos.length / 3;
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        // V-notch between lobes
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
      // Notch depth crease
      const ns = flukePos.length / 3;
      flukePos.push(0, 0.02, pedZ + 0.2);
      flukePos.push(0, -0.02, pedZ + 0.2);
      flukePos.push(0, 0, pedZ + 0.85);
      flukeIdx.push(ns, ns + 1, ns + 2);
    }

    // Peduncle-to-fluke keels (lateral ridges feeding power to flukes)
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

  /* ── Detail: blowhole, eyes, smile, melon crease, gape, teeth hint */

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
      const ox = Math.cos(a) * rx;
      const oy = Math.sin(a) * ry;
      const oz = Math.cos(a) * rz * 0.3;
      dPos.push(cx, cy, cz);
      dPos.push(cx + ox, cy + oy + extrude * 0.4, cz + oz);
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      dIdx.push(a, a + 1, a + 2);
      dIdx.push(a + 2, a + 1, a + 3);
    }
  };

  // Blowhole — single crescent opening on dorsal cranium (behind melon apex)
  // Real bottlenose: slightly left-of-center crescent; we center for clarity
  {
    const cx = 0;
    const cy = 0.42;
    const cz = -1.55; // u ≈ 0.21
    const segs = 18;
    // Outer crescent
    const start = dPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const a = -Math.PI * 0.55 + t * Math.PI * 1.1; // crescent arc
      const x = Math.sin(a) * 0.09;
      const z = cz + Math.cos(a) * 0.05;
      dPos.push(cx, cy, cz);
      dPos.push(x, cy + 0.035, z);
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      dIdx.push(a, a + 1, a + 2);
      dIdx.push(a + 2, a + 1, a + 3);
    }
    // Rim ridge
    const rStart = dPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const a = -Math.PI * 0.55 + t * Math.PI * 1.1;
      const x = Math.sin(a) * 0.09;
      const z = cz + Math.cos(a) * 0.05;
      dPos.push(x, cy + 0.035, z);
      dPos.push(x * 1.35, cy + 0.01, z + 0.02);
    }
    for (let i = 0; i < segs; i++) {
      const a = rStart + i * 2;
      dIdx.push(a, a + 1, a + 2);
      dIdx.push(a + 2, a + 1, a + 3);
    }
  }

  // Eyes — lateral, slightly below midline, just behind mouth corner
  for (const side of [-1, 1] as const) {
    const cx = side * 0.36;
    const cy = 0.05;
    const cz = -1.85; // u ≈ 0.16
    pushRing(cx, cy, cz, 0.055 * side * 0.4 + 0.05, 0.05, 0.04, 16, 0.02);
    // Dark pupil ring (inner)
    pushRing(cx + side * 0.01, cy, cz + 0.01, 0.028, 0.025, 0.02, 12, 0.015);
    // Pre-orbital crease
    const segs = 10;
    const start = dPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      dPos.push(side * (0.3 + t * 0.08), cy + 0.04 - t * 0.02, cz - 0.08 + t * 0.12);
      dPos.push(side * (0.32 + t * 0.08), cy + 0.02 - t * 0.02, cz - 0.06 + t * 0.12);
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      dIdx.push(a, a + 1, a + 2);
      dIdx.push(a + 2, a + 1, a + 3);
    }
  }

  // Permanent "smile" — mandibular crease (iconic bottlenose)
  for (const side of [-1, 1] as const) {
    const segs = 20;
    const start = dPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      // From near tip of gape aft and up slightly toward eye
      const z = -2.45 + t * 0.72;
      const y = -0.1 + Math.sin(t * Math.PI * 0.85) * 0.07 + t * 0.02;
      const x = side * (0.12 + t * 0.2 + Math.sin(t * Math.PI) * 0.04);
      dPos.push(x, y, z);
      dPos.push(x * 1.04, y - 0.025, z + 0.015);
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      dIdx.push(a, a + 1, a + 2);
      dIdx.push(a + 2, a + 1, a + 3);
    }
  }

  // Melon crease — groove between melon and rostrum (front + side refs)
  {
    const segs = 16;
    const start = dPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const a = -0.85 + t * 1.7;
      const x = Math.sin(a) * 0.2;
      const y = 0.14 + Math.cos(a) * 0.1;
      const z = -2.05;
      dPos.push(x * 0.9, y + 0.05, z);
      dPos.push(x, y, z + 0.05);
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      dIdx.push(a, a + 1, a + 2);
      dIdx.push(a + 2, a + 1, a + 3);
    }
  }

  // Mouth gape / jaw line under rostrum
  {
    const segs = 22;
    const start = dPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      // Long gape along beak underside
      const z = -2.7 + t * 0.55;
      const x = Math.sin((t - 0.5) * 1.1) * 0.1 * (1 - t * 0.3);
      const y = -0.08 - Math.sin(t * Math.PI) * 0.015;
      dPos.push(x * 0.7, y + 0.025, z);
      dPos.push(x, y, z + 0.01);
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      dIdx.push(a, a + 1, a + 2);
      dIdx.push(a + 2, a + 1, a + 3);
    }
  }

  // Conical teeth hint along gape (bottlenose has ~80–100 peg teeth)
  for (let row = 0; row < 2; row++) {
    const yBase = row === 0 ? -0.06 : -0.1;
    const count = 12;
    for (let i = 0; i < count; i++) {
      const t = i / (count - 1);
      const z = -2.65 + t * 0.45;
      const x = Math.sin((t - 0.5) * 0.9) * 0.08;
      const start = dPos.length / 3;
      dPos.push(x - 0.012, yBase, z);
      dPos.push(x + 0.012, yBase, z);
      dPos.push(x, yBase + (row === 0 ? -0.035 : 0.03), z + 0.008);
      dIdx.push(start, start + 1, start + 2);
    }
  }

  // Ear (tiny external meatus) — just behind eye
  for (const side of [-1, 1] as const) {
    pushRing(side * 0.4, 0.02, -1.65, 0.02, 0.018, 0.015, 8, 0.01);
  }

  // Umbilical / genital slit hint (ventral midbody) — subtle anatomical mark
  {
    const segs = 8;
    const start = dPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const z = 0.35 + t * 0.35;
      dPos.push(-0.02, -0.48, z);
      dPos.push(0.02, -0.48, z);
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      dIdx.push(a, a + 1, a + 2);
      dIdx.push(a + 2, a + 1, a + 3);
    }
  }

  // Dorsal ridge line behind dorsal fin (peduncle top)
  {
    const segs = 24;
    const start = dPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const u = 0.55 + t * 0.38;
      const z = (u - 0.5) * len;
      const r = bodyRadius(u) * bodyHeightScale(u);
      const y = r * 0.95 + spineYOffset(u);
      dPos.push(-0.015, y, z);
      dPos.push(0.015, y + 0.02, z + 0.02);
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      dIdx.push(a, a + 1, a + 2);
      dIdx.push(a + 2, a + 1, a + 3);
    }
  }

  // Lateral line (faint)
  for (const side of [-1, 1] as const) {
    const segs = 36;
    const start = dPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const u = 0.14 + t * 0.72;
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

/* ── Soft lattice ──────────────────────────────────────────────── */

function buildSoftLattice(): {
  particles: SoftParticle[];
  springs: SoftSpring[];
  spineCount: number;
  radial: number;
} {
  const len = BODY_LEN;
  const spineCount = 22;
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
    particles.push(makeParticle(0, cy, z, s === 0));
    for (let k = 0; k < radial; k++) {
      const a = (k / radial) * Math.PI * 2;
      particles.push(
        makeParticle(
          Math.cos(a) * r * hx,
          Math.sin(a) * r * hy + cy,
          z,
          false,
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
    for (let k = 0; k < radial; k++) {
      // Stiffer head (rostrum + melon hold shape)
      const u = s / (spineCount - 1);
      const headStiff = u < 0.25 ? 1.08 : 1;
      addSpring(base, base + 1 + k, 0.9 * headStiff);
      addSpring(base + 1 + k, base + 1 + ((k + 1) % radial), 0.82 * headStiff);
      addSpring(base + 1 + k, base + 1 + ((k + 2) % radial), 0.52);
      addSpring(base + 1 + k, base + 1 + ((k + 3) % radial), 0.36);
    }
    if (s < spineCount - 1) {
      const next = (s + 1) * ringSize;
      const u = s / (spineCount - 1);
      // Softer peduncle springs for fluke drive
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

/* ── Soft-body: DORSOVENTRAL undulation ─────────────────────────── */

const _diff = new THREE.Vector3();

function stepSoftBody(d: DolphinSim, dt: number, swimAmp: number, t: number) {
  const particles = d.particles;
  const ringSize = 1 + d.radial;
  const damp = Math.pow(0.91, dt * 60);

  for (let s = 0; s < d.spineCount; s++) {
    const u = s / (d.spineCount - 1);
    // Stiff head (u<0.3), flexible peduncle — wave amplitude ∝ u^1.7
    const tailWeight = Math.pow(Math.max(0, u - 0.2) / 0.8, 1.7);
    const wave =
      Math.sin(u * 3.6 - t * 5.4 + d.phase) *
      swimAmp *
      (0.08 + tailWeight * 1.85);
    const base = s * ringSize;
    const p = particles[base]!;
    if (!p.pinned) {
      p.y += wave * dt * 2.7;
    }
    for (let k = 0; k < d.radial; k++) {
      const q = particles[base + 1 + k]!;
      q.y += wave * dt * 2.4;
      // Peduncle slight lateral roll
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

  // Soft smile flex when curious
  if (d.smile > 0.2 && d.alarm < 0.35) {
    for (let s = 0; s < 4; s++) {
      const base = s * ringSize;
      for (let k = 0; k < d.radial; k++) {
        const a = (k / d.radial) * Math.PI * 2;
        if (Math.sin(a) < -0.2) {
          const q = particles[base + 1 + k]!;
          q.y -= d.smile * 0.035 * dt * 4;
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

    // Shape retention toward anatomical rest
    for (let s = 0; s < d.spineCount; s++) {
      const u = s / (d.spineCount - 1);
      const z = (u - 0.5) * BODY_LEN;
      const r = bodyRadius(u) * 0.94;
      const hy = bodyHeightScale(u);
      const hx = bodyWidthScale(u);
      const cy = spineYOffset(u);
      const base = s * ringSize;
      const center = particles[base]!;
      // Stronger retention in head/melon for silhouette
      const retain = u < 0.28 ? 0.18 : u > 0.75 ? 0.05 : 0.08;
      if (!center.pinned) {
        center.x += (0 - center.x) * retain;
        center.y += (cy - center.y) * retain;
        center.z += (z - center.z) * retain;
      } else {
        center.x = 0;
        center.y = cy;
        center.z = z;
      }
      for (let k = 0; k < d.radial; k++) {
        const a = (k / d.radial) * Math.PI * 2;
        const q = particles[base + 1 + k]!;
        const rx = Math.cos(a) * r * hx;
        const ry = Math.sin(a) * r * hy + cy;
        const rs = u < 0.28 ? 0.1 : 0.06;
        q.x += (rx - q.x) * rs;
        q.y += (ry - q.y) * rs;
        q.z += (z - q.z) * rs;
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
