import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { fishWorldPositions, dolphinWorldPositions, registerSharkPositions } from "./creatureRegistry";

/**
 * High-polygon great white sharks (Carcharodon carcharias).
 * Anatomy informed by multi-angle refs: side, dorsal, ventral, frontal.
 * Soft-body Verlet + springs; cruise slowly; hunt only when hungry.
 */

const SURFACE_Y = 12;
const SEABED_Y = -1.5;
const SHARK_COUNT = 2;
const SPINE_LEN = 36;
const RADIAL = 32;
const SOFT_ITERS = 4;
const BODY_LEN = 6.4;

/* ── wireframe materials (countershading via vertex colors) ─────── */

const BODY_MAT = new THREE.MeshBasicMaterial({
  vertexColors: true,
  wireframe: true,
  transparent: true,
  opacity: 0.98,
  depthWrite: false,
});

const FIN_MAT = new THREE.MeshBasicMaterial({
  color: new THREE.Color("#9ab0bc"),
  wireframe: true,
  transparent: true,
  opacity: 0.95,
  depthWrite: false,
  side: THREE.DoubleSide,
});

const DETAIL_MAT = new THREE.MeshBasicMaterial({
  color: new THREE.Color("#d4e4ec"),
  wireframe: true,
  transparent: true,
  opacity: 0.92,
  depthWrite: false,
  side: THREE.DoubleSide,
});

const TEETH_MAT = new THREE.MeshBasicMaterial({
  color: new THREE.Color("#f0f4f8"),
  wireframe: true,
  transparent: true,
  opacity: 0.95,
  depthWrite: false,
  side: THREE.DoubleSide,
});

function seeded(n: number) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/* ── Anatomical body profile (great white) ────────────────────────
 * Side: conical snout, thick midbody, narrow peduncle, lunate caudal.
 * Top:  spindle with wide pectorals, tall 1st dorsal, small 2nd dorsal.
 * Bottom: white belly, wide pectorals, pelvic + anal, mouth under snout.
 * Front: blunt-conical snout, black eye, gape, 5 gill slits.
 * u: 0 = snout tip → 1 = caudal base
 */

function bodyRadius(u: number): number {
  if (u < 0.05) return 0.035 + u * 5.2;
  if (u < 0.12) return 0.295 + (u - 0.05) * 3.4;
  if (u < 0.22) return 0.533 + (u - 0.12) * 1.55;
  if (u < 0.38) return 0.688 + (u - 0.22) * 0.55;
  if (u < 0.52) return 0.776 - (u - 0.38) * 0.35;
  if (u < 0.68) return 0.727 - (u - 0.52) * 1.15;
  if (u < 0.82) return 0.543 - (u - 0.68) * 1.85;
  if (u < 0.92) return 0.284 - (u - 0.82) * 1.1;
  return 0.174 - (u - 0.92) * 0.55;
}

/** Vertical ellipse factor — deeper mid-body, flatter peduncle */
function bodyHeightScale(u: number): number {
  if (u < 0.1) return 0.72 + u * 1.4;
  if (u < 0.35) return 0.86 + (u - 0.1) * 0.9;
  if (u < 0.55) return 1.085;
  if (u < 0.75) return 1.085 - (u - 0.55) * 0.55;
  return 0.975 - (u - 0.75) * 0.35;
}

/** Lateral width — slightly wider mid, keeled peduncle */
function bodyWidthScale(u: number): number {
  if (u < 0.15) return 0.78 + u * 0.9;
  if (u < 0.45) return 0.915 + (u - 0.15) * 0.18;
  if (u < 0.75) return 0.97 - (u - 0.45) * 0.35;
  // lateral keels near peduncle widen slightly in X
  if (u < 0.9) return 0.865 + Math.sin(((u - 0.75) / 0.15) * Math.PI) * 0.12;
  return 0.82;
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

type SharkSim = {
  id: number;
  mesh: THREE.Mesh;
  finMesh: THREE.Mesh;
  detailMesh: THREE.Mesh;
  teethMesh: THREE.Mesh;
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
  teethRest: Float32Array;
  teethInfluence: Uint16Array;
  teethWeights: Float32Array;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  heading: THREE.Vector3;
  yaw: number;
  pitch: number;
  speed: number;
  baseSpeed: number;
  phase: number;
  scale: number;
  /** 0 = full, 1 = starving. Hunts only when above HUNGER_THRESHOLD. */
  hunger: number;
  huntTarget: THREE.Vector3 | null;
  biteCooldown: number;
  patrolAngle: number;
  jawOpen: number;
};

const HUNGER_THRESHOLD = 0.62;
const HUNGER_RATE = 0.018; // per second — slow build
const BITE_RANGE = 1.35;
const HUNT_DETECT = 16;

/* ── High-poly body geometry ───────────────────────────────────── */

function countershadeColor(y: number, r: number, out: THREE.Color) {
  // Ventral white → lateral grey → dorsal steel (classic great white)
  const ny = y / Math.max(r, 0.05);
  if (ny < -0.12) {
    out.setRGB(0.95, 0.97, 0.99);
  } else if (ny < 0.08) {
    const t = (ny + 0.12) / 0.2;
    out.setRGB(0.95 - t * 0.28, 0.97 - t * 0.22, 0.99 - t * 0.16);
  } else if (ny < 0.45) {
    const t = (ny - 0.08) / 0.37;
    out.setRGB(0.72 - t * 0.14, 0.8 - t * 0.12, 0.86 - t * 0.1);
  } else {
    out.setRGB(0.52, 0.62, 0.7);
  }
}

function buildSharkGeometry(seed: number): {
  body: THREE.BufferGeometry;
  fins: THREE.BufferGeometry;
  detail: THREE.BufferGeometry;
  teeth: THREE.BufferGeometry;
} {
  const len = BODY_LEN;
  const spineN = SPINE_LEN;
  const radN = RADIAL;
  const positions: number[] = [];
  const colors: number[] = [];
  const col = new THREE.Color();

  // Spindle body: head at −Z, caudal at +Z (lookAt convention matches fish)
  for (let s = 0; s <= spineN; s++) {
    const u = s / spineN;
    const z = (u - 0.5) * len;
    const r = bodyRadius(u);
    const hy = bodyHeightScale(u);
    const hx = bodyWidthScale(u);
    // slight dorsal ridge + ventral flattening
    for (let k = 0; k <= radN; k++) {
      const a = (k / radN) * Math.PI * 2;
      // Flatten belly slightly (great white ventral plane)
      const bellyFlat = a > Math.PI && a < Math.PI * 2 ? 0.88 + Math.sin(a) * 0.04 : 1;
      // Dorsal ridge
      const dorsalRidge = a > 0.4 && a < Math.PI - 0.4 ? 1 + Math.cos(a) * 0.04 : 1;
      // Gill-region lateral compression hint
      const gillBulge =
        u > 0.12 && u < 0.28 ? 1 + Math.abs(Math.cos(a)) * 0.06 : 1;
      const px = Math.cos(a) * r * hx * gillBulge * bellyFlat;
      const py = Math.sin(a) * r * hy * dorsalRidge;
      // micro surface noise for organic high-poly look
      const n =
        1 +
        Math.sin(a * 5 + u * 9 + seed) * 0.012 +
        Math.sin(a * 11 - u * 7) * 0.008;
      positions.push(px * n, py * n, z);
      countershadeColor(py, r * hy, col);
      // snout tip slightly lighter
      if (u < 0.08) col.lerp(new THREE.Color("#c8d4dc"), 0.25);
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

  // Snout tip cap (−Z) — pointed conical
  const snoutTip = positions.length / 3;
  positions.push(0, -0.02, -len * 0.5 - 0.18);
  colors.push(0.75, 0.8, 0.85);
  for (let k = 0; k < radN; k++) {
    indices.push(snoutTip, k + 1, k);
  }

  // Caudal peduncle base ring already at spineN; lunate caudal built in fins

  const body = new THREE.BufferGeometry();
  body.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  body.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  body.setIndex(indices);
  body.computeVertexNormals();

  /* ── Fins (high-poly) from multi-angle anatomy ───────────────────
   * 1st dorsal: tall triangle, slightly aft of mid-body
   * 2nd dorsal: small, near peduncle
   * Pectorals: wide, swept, slightly down-angled
   * Pelvics: smaller paired
   * Anal: small, opposite 2nd dorsal
   * Caudal: lunate crescent, upper lobe slightly larger
   * Lateral keels: peduncle ridges
   */

  const finPos: number[] = [];
  const finIdx: number[] = [];

  const pushRibbon = (
    pts: [number, number, number][],
    halfW: number,
    axis: "x" | "y" = "x",
  ) => {
    const start = finPos.length / 3;
    for (let i = 0; i < pts.length; i++) {
      const [x, y, z] = pts[i]!;
      if (axis === "x") {
        finPos.push(x - halfW, y, z);
        finPos.push(x + halfW, y, z);
      } else {
        finPos.push(x, y - halfW, z);
        finPos.push(x, y + halfW, z);
      }
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = start + i * 2;
      finIdx.push(a, a + 1, a + 2);
      finIdx.push(a + 2, a + 1, a + 3);
    }
  };

  // First dorsal — tall falcate triangle (side + top refs)
  {
    const segs = 20;
    const baseZ0 = -0.15;
    const baseZ1 = 1.05;
    const baseY = 0.62;
    const height = 1.15;
    const start = finPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const z = THREE.MathUtils.lerp(baseZ0, baseZ1, t);
      // leading edge steeper, trailing slightly concave
      const edge =
        t < 0.35
          ? Math.pow(t / 0.35, 0.85)
          : Math.pow(1 - (t - 0.35) / 0.65, 1.15);
      const tipLean = t * 0.12;
      finPos.push(0, baseY, z);
      finPos.push(0.03, baseY + height * edge, z + tipLean);
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      finIdx.push(a, a + 1, a + 2);
      finIdx.push(a + 2, a + 1, a + 3);
    }
  }

  // Second dorsal — small
  {
    const segs = 10;
    const start = finPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const z = 1.85 + t * 0.45;
      const edge = Math.sin(t * Math.PI);
      finPos.push(0, 0.28, z);
      finPos.push(0.02, 0.28 + 0.22 * edge, z + 0.02);
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      finIdx.push(a, a + 1, a + 2);
      finIdx.push(a + 2, a + 1, a + 3);
    }
  }

  // Anal fin
  {
    const segs = 10;
    const start = finPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const z = 1.9 + t * 0.4;
      const edge = Math.sin(t * Math.PI);
      finPos.push(0, -0.22, z);
      finPos.push(0.02, -0.22 - 0.18 * edge, z + 0.02);
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      finIdx.push(a, a + 1, a + 2);
      finIdx.push(a + 2, a + 1, a + 3);
    }
  }

  // Pectoral fins — wide, slightly down-canted (top + side refs)
  for (const side of [-1, 1] as const) {
    const segs = 18;
    const start = finPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      // root near gills → tip
      const z = -0.55 + t * 0.95;
      const span = Math.sin(t * Math.PI * 0.92) * 1.45;
      const droop = t * 0.38;
      const sweep = t * 0.55;
      finPos.push(0.38 * side, -0.12, -0.55 + t * 0.15);
      finPos.push(
        (0.38 + span) * side,
        -0.12 - droop - span * 0.08,
        -0.55 + sweep + t * 0.35,
      );
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      finIdx.push(a, a + 1, a + 2);
      finIdx.push(a + 2, a + 1, a + 3);
    }
    // fill membrane with extra cross ribs for high-poly look
    const midStart = finPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const span = Math.sin(t * Math.PI * 0.92) * 0.85;
      const droop = t * 0.22;
      finPos.push(0.45 * side, -0.14, -0.5 + t * 0.2);
      finPos.push(
        (0.45 + span) * side,
        -0.14 - droop,
        -0.4 + t * 0.5,
      );
    }
    for (let i = 0; i < segs; i++) {
      const a = midStart + i * 2;
      finIdx.push(a, a + 1, a + 2);
      finIdx.push(a + 2, a + 1, a + 3);
    }
  }

  // Pelvic fins
  for (const side of [-1, 1] as const) {
    const segs = 10;
    const start = finPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const span = Math.sin(t * Math.PI) * 0.42;
      finPos.push(0.2 * side, -0.35, 0.85 + t * 0.15);
      finPos.push(
        (0.2 + span) * side,
        -0.35 - span * 0.35,
        0.9 + t * 0.35,
      );
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      finIdx.push(a, a + 1, a + 2);
      finIdx.push(a + 2, a + 1, a + 3);
    }
  }

  // Caudal — lunate / crescent (heterocercal upper lobe slightly larger)
  {
    const segs = 24;
    // upper lobe
    const uStart = finPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const z = len * 0.5 - 0.05 + t * 1.35;
      const y = Math.sin(t * Math.PI * 0.55) * 1.05 + t * 0.15;
      const chord = 0.08 + Math.sin(t * Math.PI) * 0.22 * (1 - t * 0.35);
      finPos.push(0, y * 0.15, len * 0.5 - 0.08 + t * 0.2);
      finPos.push(0, y, z);
      // thickness
      void chord;
    }
    for (let i = 0; i < segs; i++) {
      const a = uStart + i * 2;
      finIdx.push(a, a + 1, a + 2);
      finIdx.push(a + 2, a + 1, a + 3);
    }
    // lower lobe (slightly smaller)
    const lStart = finPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const z = len * 0.5 - 0.05 + t * 1.15;
      const y = -(Math.sin(t * Math.PI * 0.55) * 0.88 + t * 0.1);
      finPos.push(0, y * 0.12, len * 0.5 - 0.08 + t * 0.18);
      finPos.push(0, y, z);
    }
    for (let i = 0; i < segs; i++) {
      const a = lStart + i * 2;
      finIdx.push(a, a + 1, a + 2);
      finIdx.push(a + 2, a + 1, a + 3);
    }
    // caudal membrane fill (crescent web)
    const cStart = finPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const ang = -0.95 + t * 1.9;
      const rr = 0.55 + Math.cos(ang) * 0.15;
      finPos.push(0, 0, len * 0.5 + 0.15);
      finPos.push(0, Math.sin(ang) * rr * 1.1, len * 0.5 + 0.15 + Math.cos(ang) * rr * 0.9);
    }
    for (let i = 0; i < segs; i++) {
      const a = cStart + i * 2;
      finIdx.push(a, a + 1, a + 2);
      finIdx.push(a + 2, a + 1, a + 3);
    }
  }

  // Lateral keels at peduncle
  for (const side of [-1, 1] as const) {
    pushRibbon(
      [
        [0.12 * side, 0, 2.0],
        [0.28 * side, 0, 2.35],
        [0.22 * side, 0, 2.7],
        [0.08 * side, 0, 2.95],
      ],
      0.04,
      "y",
    );
  }

  const fins = new THREE.BufferGeometry();
  fins.setAttribute("position", new THREE.Float32BufferAttribute(finPos, 3));
  fins.setIndex(finIdx);
  fins.computeVertexNormals();

  /* ── Detail: gill slits (5), eyes, mouth outline, ampullae ─────── */

  const dPos: number[] = [];
  const dIdx: number[] = [];

  // 5 gill slits each side (front + side refs) — behind head
  for (const side of [-1, 1] as const) {
    for (let g = 0; g < 5; g++) {
      const z = -1.55 + g * 0.22;
      const segs = 8;
      const start = dPos.length / 3;
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const y = -0.28 + t * 0.72;
        const x = side * (0.48 + Math.sin(t * Math.PI) * 0.06 + g * 0.012);
        dPos.push(x * 0.92, y, z);
        dPos.push(x, y, z + 0.04);
      }
      for (let i = 0; i < segs; i++) {
        const a = start + i * 2;
        dIdx.push(a, a + 1, a + 2);
        dIdx.push(a + 2, a + 1, a + 3);
      }
    }
  }

  // Eyes — black sockets as small rings (side + front)
  for (const side of [-1, 1] as const) {
    const segs = 12;
    const cx = side * 0.42;
    const cy = 0.12;
    const cz = -2.35;
    const start = dPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      dPos.push(cx, cy, cz);
      dPos.push(
        cx + Math.cos(a) * 0.09 * side * 0.3 + Math.cos(a) * 0.02,
        cy + Math.sin(a) * 0.08,
        cz + Math.cos(a) * 0.06,
      );
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      dIdx.push(a, a + 1, a + 2);
      dIdx.push(a + 2, a + 1, a + 3);
    }
  }

  // Mouth gape outline under snout (front + bottom refs)
  {
    const segs = 20;
    const start = dPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const a = -Math.PI * 0.55 + t * Math.PI * 1.1;
      const x = Math.sin(a) * 0.38;
      const y = -0.22 + Math.cos(a) * 0.06;
      const z = -2.55 + Math.abs(Math.sin(a)) * 0.12;
      dPos.push(x * 0.7, y + 0.06, z + 0.08);
      dPos.push(x, y, z);
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      dIdx.push(a, a + 1, a + 2);
      dIdx.push(a + 2, a + 1, a + 3);
    }
  }

  // Lateral line
  for (const side of [-1, 1] as const) {
    const segs = 28;
    const start = dPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const u = 0.1 + t * 0.75;
      const z = (u - 0.5) * len;
      const r = bodyRadius(u) * bodyWidthScale(u);
      dPos.push(side * r * 0.98, 0.02, z);
      dPos.push(side * r * 1.02, 0.02, z + 0.04);
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

  /* ── Teeth (triangular rows) ──────────────────────────────────── */

  const tPos: number[] = [];
  const tIdx: number[] = [];
  for (let row = 0; row < 2; row++) {
    const yBase = row === 0 ? -0.18 : -0.32;
    const zBase = -2.52 + row * 0.04;
    const count = 14;
    for (let i = 0; i < count; i++) {
      const t = i / (count - 1);
      const a = -0.9 + t * 1.8;
      const x = Math.sin(a) * 0.32;
      const z = zBase + Math.abs(Math.sin(a)) * 0.06;
      const start = tPos.length / 3;
      // triangular tooth
      tPos.push(x - 0.025, yBase, z);
      tPos.push(x + 0.025, yBase, z);
      tPos.push(x, yBase + (row === 0 ? -0.11 : 0.11), z + 0.02);
      tIdx.push(start, start + 1, start + 2);
    }
  }

  const teeth = new THREE.BufferGeometry();
  teeth.setAttribute("position", new THREE.Float32BufferAttribute(tPos, 3));
  teeth.setIndex(tIdx);
  teeth.computeVertexNormals();

  void seed;
  return { body, fins, detail, teeth };
}

/* ── Soft lattice (higher res for large body) ──────────────────── */

function buildSoftLattice(): {
  particles: SoftParticle[];
  springs: SoftSpring[];
  spineCount: number;
  radial: number;
} {
  const len = BODY_LEN;
  const spineCount = 18;
  const radial = 10;
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
        makeParticle(
          Math.cos(a) * r * hx,
          Math.sin(a) * r * hy,
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
      addSpring(base, base + 1 + k, 0.88);
      addSpring(base + 1 + k, base + 1 + ((k + 1) % radial), 0.78);
      addSpring(base + 1 + k, base + 1 + ((k + 2) % radial), 0.48);
      addSpring(base + 1 + k, base + 1 + ((k + 3) % radial), 0.32);
    }
    if (s < spineCount - 1) {
      const next = (s + 1) * ringSize;
      addSpring(base, next, 0.96);
      for (let k = 0; k < radial; k++) {
        addSpring(base + 1 + k, next + 1 + k, 0.72);
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

function createShark(id: number): SharkSim {
  const seed = id * 23.7 + 4.1;
  const { body, fins, detail, teeth } = buildSharkGeometry(seed);
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
  const teethRest = new Float32Array(
    (teeth.attributes.position as THREE.BufferAttribute).array as Float32Array,
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
  const teethBind = bindMeshToLattice(
    teethRest,
    lattice.particles,
    lattice.spineCount,
    lattice.radial,
  );

  // Larger than fish; spawn near the school so they enter the default view
  const scale = 1.05 + seeded(seed) * 0.35;
  const angle = (id / SHARK_COUNT) * Math.PI * 2 + seeded(seed + 1) * 0.8 + 0.6;
  const radius = 5.5 + seeded(seed + 2) * 3.5;
  const pos = new THREE.Vector3(
    Math.cos(angle) * radius,
    3.5 + seeded(seed + 3) * 2.8,
    Math.sin(angle) * radius * 0.7 - 2,
  );
  const yaw = angle + Math.PI;
  const heading = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  // Much slower than tropical fish (fish baseSpeed ~1.05–1.8)
  const baseSpeed = 0.32 + seeded(seed + 5) * 0.12;

  const mesh = new THREE.Mesh(body, BODY_MAT);
  mesh.scale.setScalar(scale);
  mesh.frustumCulled = false;

  const finMesh = new THREE.Mesh(fins, FIN_MAT);
  finMesh.scale.setScalar(scale);
  finMesh.frustumCulled = false;

  const detailMesh = new THREE.Mesh(detail, DETAIL_MAT);
  detailMesh.scale.setScalar(scale);
  detailMesh.frustumCulled = false;

  const teethMesh = new THREE.Mesh(teeth, TEETH_MAT);
  teethMesh.scale.setScalar(scale);
  teethMesh.frustumCulled = false;

  return {
    id,
    mesh,
    finMesh,
    detailMesh,
    teethMesh,
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
    teethRest,
    teethInfluence: teethBind.influence,
    teethWeights: teethBind.weights,
    pos,
    vel: heading.clone().multiplyScalar(baseSpeed),
    heading,
    yaw,
    pitch: 0,
    speed: baseSpeed,
    baseSpeed,
    phase: seeded(seed + 6) * Math.PI * 2,
    scale,
    hunger: id === 0 ? 0.7 : 0.2 + seeded(seed + 7) * 0.35,
    huntTarget: null,
    biteCooldown: 0,
    patrolAngle: angle,
    jawOpen: 0,
  };
}

/* ── Soft-body step — caudal-driven undulation (thunniform) ────── */

const _diff = new THREE.Vector3();

function stepSoftBody(shark: SharkSim, dt: number, swimAmp: number, t: number) {
  const particles = shark.particles;
  const ringSize = 1 + shark.radial;
  const damp = Math.pow(0.92, dt * 60);

  // Great whites: stiff front, flexible rear — wave stronger toward tail
  for (let s = 0; s < shark.spineCount; s++) {
    const u = s / (shark.spineCount - 1);
    const tailWeight = Math.pow(u, 1.6);
    const wave =
      Math.sin(u * 4.2 - t * 4.5 + shark.phase) *
      swimAmp *
      (0.15 + tailWeight * 1.6);
    const base = s * ringSize;
    const p = particles[base]!;
    if (!p.pinned) {
      p.x += wave * dt * 2.4;
    }
    for (let k = 0; k < shark.radial; k++) {
      const q = particles[base + 1 + k]!;
      q.x += wave * dt * 2.1;
      // slight vertical roll of peduncle
      q.y +=
        Math.sin(u * 2.4 - t * 3.2 + shark.phase) *
        swimAmp *
        0.12 *
        tailWeight *
        dt;
    }
  }

  // Jaw soft flex when open
  if (shark.jawOpen > 0.05) {
    for (let s = 0; s < 3; s++) {
      const base = s * ringSize;
      for (let k = 0; k < shark.radial; k++) {
        const a = (k / shark.radial) * Math.PI * 2;
        if (Math.sin(a) < -0.2) {
          const q = particles[base + 1 + k]!;
          q.y -= shark.jawOpen * 0.15 * dt * 8;
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
    for (const s of shark.springs) {
      const a = particles[s.a]!;
      const b = particles[s.b]!;
      _diff.set(b.x - a.x, b.y - a.y, b.z - a.z);
      const d = _diff.length() || 1e-6;
      const corr = ((d - s.rest) / d) * 0.5 * s.stiff;
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
    for (let s = 0; s < shark.spineCount; s++) {
      const u = s / (shark.spineCount - 1);
      const z = (u - 0.5) * BODY_LEN;
      const r = bodyRadius(u) * 0.94;
      const hy = bodyHeightScale(u);
      const hx = bodyWidthScale(u);
      const base = s * ringSize;
      const center = particles[base]!;
      const retain = u < 0.35 ? 0.14 : 0.08;
      if (!center.pinned) {
        center.x += (0 - center.x) * retain;
        center.y += (0 - center.y) * retain;
        center.z += (z - center.z) * retain;
      } else {
        center.x = 0;
        center.y = 0;
        center.z = z;
      }
      for (let k = 0; k < shark.radial; k++) {
        const a = (k / shark.radial) * Math.PI * 2;
        const q = particles[base + 1 + k]!;
        const rx = Math.cos(a) * r * hx;
        const ry = Math.sin(a) * r * hy;
        q.x += (rx - q.x) * 0.06;
        q.y += (ry - q.y) * 0.06;
        q.z += (z - q.z) * 0.06;
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

/* ── AI: patrol slow / hunt when hungry ────────────────────────── */

const _steer = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _look = new THREE.Vector3();
const _fwd = new THREE.Vector3();

function findNearestPrey(from: THREE.Vector3): THREE.Vector3 | null {
  let best: THREE.Vector3 | null = null;
  let bestD = HUNT_DETECT * HUNT_DETECT;
  for (const p of fishWorldPositions) {
    const d2 = from.distanceToSquared(p);
    if (d2 < bestD) {
      bestD = d2;
      best = p;
    }
  }
  // Dolphins are also potential targets when hungry, but harder to catch
  for (const p of dolphinWorldPositions) {
    const d2 = from.distanceToSquared(p);
    if (d2 < bestD) {
      bestD = d2;
      best = p;
    }
  }
  return best;
}

function aiStep(sharks: SharkSim[], dt: number) {
  for (const s of sharks) {
    s.hunger = Math.min(1, s.hunger + HUNGER_RATE * dt);
    if (s.biteCooldown > 0) s.biteCooldown -= dt;

    const hungry = s.hunger >= HUNGER_THRESHOLD;
    _steer.set(0, 0, 0);

    if (hungry && s.biteCooldown <= 0) {
      const prey = findNearestPrey(s.pos);
      s.huntTarget = prey;
      if (prey) {
        _tmp.copy(prey).sub(s.pos);
        const dist = _tmp.length() || 1e-6;
        _tmp.multiplyScalar(1 / dist);
        // deliberate pursuit — still slower than fish
        _steer.addScaledVector(_tmp, 1.6);
        // mild lead prediction
        _steer.y += THREE.MathUtils.clamp(prey.y - s.pos.y, -1, 1) * 0.35;

        if (dist < BITE_RANGE * s.scale) {
          // Strike — satiate without removing fish school
          s.hunger = 0.05 + seeded(s.id + s.phase) * 0.12;
          s.biteCooldown = 8 + seeded(s.id * 3.1) * 6;
          s.jawOpen = 1;
          s.huntTarget = null;
        } else if (dist < BITE_RANGE * 2.2) {
          s.jawOpen = THREE.MathUtils.lerp(s.jawOpen, 0.85, dt * 4);
        } else {
          s.jawOpen = THREE.MathUtils.lerp(s.jawOpen, 0.15, dt * 2);
        }
      } else {
        // Hungry but no prey nearby — slow search arc
        s.patrolAngle += dt * 0.18;
        _tmp.set(
          -Math.sin(s.patrolAngle),
          Math.sin(s.phase + s.patrolAngle) * 0.15,
          -Math.cos(s.patrolAngle),
        );
        _steer.addScaledVector(_tmp, 0.55);
        s.jawOpen = THREE.MathUtils.lerp(s.jawOpen, 0, dt * 2);
      }
    } else {
      // Satiated cruise — wide, slow patrol closer to the reef basin
      s.huntTarget = null;
      s.patrolAngle += dt * 0.12;
      const px = Math.cos(s.patrolAngle) * 7.5;
      const pz = Math.sin(s.patrolAngle) * 6 - 2;
      _tmp.set(px - s.pos.x, 0, pz - s.pos.z);
      const d = _tmp.length() || 1;
      _tmp.multiplyScalar(1 / d);
      _steer.addScaledVector(_tmp, 0.45);
      _tmp.set(
        Math.sin(s.phase * 0.3) * 0.2,
        Math.sin(s.phase * 0.22) * 0.25,
        Math.cos(s.phase * 0.28) * 0.2,
      );
      _steer.addScaledVector(_tmp, 0.3);
      s.jawOpen = THREE.MathUtils.lerp(s.jawOpen, 0, dt * 3);
    }

    // Bounds — stay in basin
    const yMin = SEABED_Y + 2.2;
    const yMax = SURFACE_Y - 5;
    if (s.pos.y < yMin) _steer.y += (yMin - s.pos.y) * 1.1;
    if (s.pos.y > yMax) _steer.y -= (s.pos.y - yMax) * 1.1;
    _steer.y += (4.2 - s.pos.y) * 0.04;

    if (s.pos.x < -18) _steer.x += 1.1;
    if (s.pos.x > 18) _steer.x -= 1.1;
    if (s.pos.z < -20) _steer.z += 1.0;
    if (s.pos.z > 10) _steer.z -= 0.85;

    // Avoid other sharks
    for (const o of sharks) {
      if (o.id === s.id) continue;
      const d2 = s.pos.distanceToSquared(o.pos);
      if (d2 < 25 && d2 > 1e-6) {
        _tmp.copy(s.pos).sub(o.pos).normalize();
        _steer.addScaledVector(_tmp, 0.8);
      }
    }

    // Speed: cruise slow; hunt only modestly faster — still < fish
    const hunting = hungry && s.huntTarget != null;
    const targetSpeed = s.baseSpeed * (hunting ? 1.85 : 1) * (0.9 + s.hunger * 0.15);
    // fish max ~3; sharks max ~0.9
    const maxSp = Math.min(targetSpeed * 1.4, 0.95);
    const minSp = targetSpeed * 0.55;

    s.vel.addScaledVector(_steer, dt * 1.4);
    const sp = s.vel.length() || 1e-6;
    if (sp > maxSp) s.vel.multiplyScalar(maxSp / sp);
    else if (sp < minSp) s.vel.multiplyScalar(minSp / sp);

    s.pos.addScaledVector(s.vel, dt);
    s.speed = s.vel.length();
    s.heading.copy(s.vel).normalize();
    s.yaw = Math.atan2(-s.heading.x, -s.heading.z);
    s.pitch = Math.asin(THREE.MathUtils.clamp(s.heading.y, -0.55, 0.55));
    // Slow phase — caudal beat slower than tropical fish
    s.phase += dt * (2.1 + s.speed * 1.8);
  }
}

function orientShark(mesh: THREE.Object3D, heading: THREE.Vector3, bank: number) {
  _fwd.copy(heading).normalize();
  _look.copy(mesh.position).sub(_fwd);
  mesh.lookAt(_look);
  mesh.rotateZ(bank);
}

/* ── React component ───────────────────────────────────────────── */

export function GreatWhiteSharks() {
  const group = useRef<THREE.Group>(null);

  const sharks = useMemo(() => {
    const list: SharkSim[] = [];
    for (let i = 0; i < SHARK_COUNT; i++) list.push(createShark(i));
    return list;
  }, []);

  const restLattices = useMemo(() => {
    return sharks.map((s) => s.particles.map((p) => ({ x: p.x, y: p.y, z: p.z })));
  }, [sharks]);

  useFrame(({ clock }, delta) => {
    const dt = Math.min(delta, 0.05);
    const t = clock.elapsedTime;
    registerSharkPositions(sharks.map((s) => s.pos));
    aiStep(sharks, dt);

    for (let i = 0; i < sharks.length; i++) {
      const s = sharks[i]!;
      const hunting = s.hunger >= HUNGER_THRESHOLD && s.huntTarget != null;
      // Soft amplitude: stronger at tail when hunting slightly more
      const swimAmp = 0.07 + s.speed * 0.06 + (hunting ? 0.04 : 0);

      stepSoftBody(s, dt, swimAmp, t + s.phase * 0.08);

      const bodyPos = s.mesh.geometry.attributes.position as THREE.BufferAttribute;
      deformMeshFromLattice(
        bodyPos,
        s.restVerts,
        s.particles,
        s.influence,
        s.weights,
        restLattices[i]!,
      );

      const finPos = s.finMesh.geometry.attributes.position as THREE.BufferAttribute;
      deformMeshFromLattice(
        finPos,
        s.finRest,
        s.particles,
        s.finInfluence,
        s.finWeights,
        restLattices[i]!,
      );

      const detPos = s.detailMesh.geometry.attributes
        .position as THREE.BufferAttribute;
      deformMeshFromLattice(
        detPos,
        s.detailRest,
        s.particles,
        s.detailInfluence,
        s.detailWeights,
        restLattices[i]!,
      );

      const teethPos = s.teethMesh.geometry.attributes
        .position as THREE.BufferAttribute;
      deformMeshFromLattice(
        teethPos,
        s.teethRest,
        s.particles,
        s.teethInfluence,
        s.teethWeights,
        restLattices[i]!,
      );

      s.mesh.position.copy(s.pos);
      s.finMesh.position.copy(s.pos);
      s.detailMesh.position.copy(s.pos);
      s.teethMesh.position.copy(s.pos);

      const bank = THREE.MathUtils.clamp(
        -s.heading.x * 0.35 + s.vel.x * 0.03,
        -0.28,
        0.28,
      );
      orientShark(s.mesh, s.heading, bank);
      s.finMesh.quaternion.copy(s.mesh.quaternion);
      s.detailMesh.quaternion.copy(s.mesh.quaternion);
      s.teethMesh.quaternion.copy(s.mesh.quaternion);
    }
  });

  return (
    <group ref={group}>
      {sharks.map((s) => (
        <group key={s.id}>
          <primitive object={s.mesh} />
          <primitive object={s.finMesh} />
          <primitive object={s.detailMesh} />
          <primitive object={s.teethMesh} />
        </group>
      ))}
    </group>
  );
}
