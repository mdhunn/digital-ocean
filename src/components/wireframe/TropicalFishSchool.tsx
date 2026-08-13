import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { registerFishPositions } from "./creatureRegistry";
import { qualityRuntime, softItersFor } from "./quality";
import {
  consumeFixedSteps,
  makeParticle,
  solveSprings,
  SOFT_FIXED_DT,
  verletIntegrate,
  type SoftParticle,
  type SoftSpring,
} from "./softBody";

/**
 * Soft-body cellular-automata tropical fish school.
 * Fish NEVER read pointer/mouse/tap — only swim via CA + boids + soft body.
 */

const SURFACE_Y = 12;
const SEABED_Y = -1.5;
const SCHOOL_COUNT = 16;
const SPINE_LEN = 20;
const RADIAL = 22;
const SOFT_ITERS = 3;

/* ── wireframe materials (match ocean palette, readable mid-water) ─ */

const FISH_MATS = [
  new THREE.MeshBasicMaterial({
    color: new THREE.Color("#ff8a4c"),
    wireframe: true,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
  }),
  new THREE.MeshBasicMaterial({
    color: new THREE.Color("#ffd24a"),
    wireframe: true,
    transparent: true,
    opacity: 0.94,
    depthWrite: false,
  }),
  new THREE.MeshBasicMaterial({
    color: new THREE.Color("#5ef0c8"),
    wireframe: true,
    transparent: true,
    opacity: 0.94,
    depthWrite: false,
  }),
  new THREE.MeshBasicMaterial({
    color: new THREE.Color("#ffb0c8"),
    wireframe: true,
    transparent: true,
    opacity: 0.93,
    depthWrite: false,
  }),
  new THREE.MeshBasicMaterial({
    color: new THREE.Color("#b8ff6a"),
    wireframe: true,
    transparent: true,
    opacity: 0.94,
    depthWrite: false,
  }),
  new THREE.MeshBasicMaterial({
    color: new THREE.Color("#7ec8ff"),
    wireframe: true,
    transparent: true,
    opacity: 0.93,
    depthWrite: false,
  }),
];

const FIN_MAT = new THREE.MeshBasicMaterial({
  color: new THREE.Color("#ffe8c8"),
  wireframe: true,
  transparent: true,
  opacity: 0.8,
  depthWrite: false,
  side: THREE.DoubleSide,
});

function seeded(n: number) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/* ── Rest-shape profile: tropical fish silhouette along +Z (head −Z) ─
 * Body length runs Z so Object3D.lookAt can aim the head along heading.
 */

function bodyRadius(u: number): number {
  // u: 0 head → 1 tail tip
  if (u < 0.08) return 0.1 + u * 4.5;
  if (u < 0.22) return 0.46 + (u - 0.08) * 1.15;
  if (u < 0.55) return 0.62 - (u - 0.22) * 0.28;
  if (u < 0.78) return 0.53 - (u - 0.55) * 1.1;
  if (u < 0.9) return 0.28 - (u - 0.78) * 0.95;
  return 0.16 + (u - 0.9) * 0.06;
}

function bodyHeightScale(u: number): number {
  if (u < 0.15) return 0.8 + u * 2;
  if (u < 0.5) return 1.2;
  if (u < 0.75) return 1.2 - (u - 0.5) * 0.65;
  return 0.9;
}

function bodyLength(): number {
  return 2.1;
}

/* ── Cellular automata (Rule-90-ish aquatic ring) ──────────────── */

class SchoolCA {
  cells: Uint8Array;
  next: Uint8Array;
  readonly n: number;
  tickAccum = 0;
  readonly period: number;

  constructor(n: number, period = 0.11) {
    this.n = n;
    this.period = period;
    this.cells = new Uint8Array(n);
    this.next = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      this.cells[i] = seeded(i * 3.17 + 9) > 0.62 ? 1 : 0;
    }
    this.cells[Math.floor(n / 2)] = 1;
  }

  step(dt: number) {
    this.tickAccum += dt;
    while (this.tickAccum >= this.period) {
      this.tickAccum -= this.period;
      const c = this.cells;
      const nx = this.next;
      const n = this.n;
      for (let i = 0; i < n; i++) {
        const L = c[(i - 1 + n) % n]!;
        const C = c[i]!;
        const R = c[(i + 1) % n]!;
        const xor = L ^ R;
        const clump = L & R & (C ^ 1);
        nx[i] = (xor | clump) & 1;
      }
      let sum = 0;
      for (let i = 0; i < n; i++) sum += nx[i]!;
      if (sum < 2) {
        nx[Math.floor(seeded(sum + this.tickAccum) * n)] = 1;
        nx[Math.floor(seeded(sum * 7.1) * n)] = 1;
      }
      this.cells.set(nx);
    }
  }

  sample(i: number): number {
    return this.cells[((i % this.n) + this.n) % this.n]!;
  }

  field(i: number): number {
    const n = this.n;
    const a = this.cells[(i - 1 + n) % n]!;
    const b = this.cells[i % n]!;
    const c = this.cells[(i + 1) % n]!;
    return a * 0.25 + b * 0.5 + c * 0.25;
  }
}

/* ── Soft-body particle helpers ────────────────────────────────── */

/* ── One high-poly soft fish ───────────────────────────────────── */

type FishSim = {
  id: number;
  mesh: THREE.Mesh;
  finMesh: THREE.Mesh;
  particles: SoftParticle[];
  springs: SoftSpring[];
  spineCount: number;
  radial: number;
  restVerts: Float32Array;
  influence: Uint16Array;
  weights: Float32Array;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  heading: THREE.Vector3;
  yaw: number;
  pitch: number;
  speed: number;
  baseSpeed: number;
  phase: number;
  scale: number;
  matIndex: number;
  caIndex: number;
  finRest: Float32Array;
  finInfluence: Uint16Array;
  finWeights: Float32Array;
};

function buildFishGeometry(seed: number): {
  body: THREE.BufferGeometry;
  fins: THREE.BufferGeometry;
} {
  const len = bodyLength();
  const spineN = SPINE_LEN;
  const radN = RADIAL;

  // High-poly body along Z: head at −Z, tail at +Z
  const positions: number[] = [];
  const uvs: number[] = [];

  for (let s = 0; s <= spineN; s++) {
    const u = s / spineN;
    const z = (u - 0.5) * len;
    const r = bodyRadius(u);
    const hy = bodyHeightScale(u);
    for (let k = 0; k <= radN; k++) {
      const a = (k / radN) * Math.PI * 2;
      const py = Math.sin(a) * r * hy;
      const px = Math.cos(a) * r * (0.72 + seeded(seed + s * 0.1) * 0.04);
      const ridge = 1 + Math.sin(a * 4 + u * 6) * 0.035;
      positions.push(px * ridge, py * ridge, z);
      uvs.push(u, k / radN);
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

  // Cap head (−Z)
  const headCenter = positions.length / 3;
  positions.push(0, 0, -len * 0.5 - 0.1);
  uvs.push(0, 0.5);
  for (let k = 0; k < radN; k++) {
    indices.push(headCenter, k + 1, k);
  }

  // Forked caudal at +Z
  const tailBaseS = spineN;
  const tipY = 0.62 + seeded(seed) * 0.14;
  const tipZ = len * 0.5 + 0.62;
  const tipUp = positions.length / 3;
  positions.push(0, tipY, tipZ);
  uvs.push(1, 0.25);
  const tipDn = positions.length / 3;
  positions.push(0, -tipY, tipZ);
  uvs.push(1, 0.75);
  const midTail = positions.length / 3;
  positions.push(0, 0, len * 0.5 + 0.14);
  uvs.push(0.95, 0.5);

  for (let k = 0; k < radN; k++) {
    const a0 = tailBaseS * stride + k;
    const a1 = tailBaseS * stride + k + 1;
    const a = (k / radN) * Math.PI * 2;
    if (Math.sin(a) >= 0) {
      indices.push(a0, tipUp, a1);
    } else {
      indices.push(a0, a1, tipDn);
    }
  }
  indices.push(tipUp, midTail, tipDn);

  const body = new THREE.BufferGeometry();
  body.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  body.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  body.setIndex(indices);
  body.computeVertexNormals();

  // High-poly fins: dorsal + anal + paired pectorals
  const finPos: number[] = [];
  const finIdx: number[] = [];
  const pushFin = (
    baseZ0: number,
    baseZ1: number,
    baseY: number,
    height: number,
    segs: number,
  ) => {
    const start = finPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const z = THREE.MathUtils.lerp(baseZ0, baseZ1, t);
      const edge = Math.sin(t * Math.PI);
      finPos.push(0, baseY, z);
      finPos.push(0.02, baseY + height * edge, z + edge * 0.06);
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      finIdx.push(a, a + 1, a + 2);
      finIdx.push(a + 2, a + 1, a + 3);
    }
  };

  pushFin(-0.2, 0.6, 0.48, 0.62, 16);
  pushFin(-0.12, 0.4, -0.38, -0.32, 12);

  const pSeg = 14;
  for (const side of [-1, 1]) {
    const start = finPos.length / 3;
    for (let i = 0; i <= pSeg; i++) {
      const t = i / pSeg;
      const z = -0.18 + t * 0.4;
      const span = Math.sin(t * Math.PI) * 0.48;
      finPos.push(0.14 * side, -0.06, z);
      finPos.push((0.14 + span) * side, -0.1 - span * 0.22, z + 0.05);
    }
    for (let i = 0; i < pSeg; i++) {
      const a = start + i * 2;
      finIdx.push(a, a + 1, a + 2);
      finIdx.push(a + 2, a + 1, a + 3);
    }
  }

  // Eye rings — small extra detail on the head
  for (const side of [-1, 1]) {
    const start = finPos.length / 3;
    const ex = 0.22 * side;
    const ey = 0.12;
    const ez = -0.78;
    const segs = 8;
    const r = 0.07;
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      finPos.push(ex, ey, ez);
      finPos.push(ex + Math.cos(a) * r * 0.35, ey + Math.sin(a) * r, ez + Math.cos(a) * r * 0.2);
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      finIdx.push(a, a + 1, a + 2);
      finIdx.push(a + 2, a + 1, a + 3);
    }
  }

  const fins = new THREE.BufferGeometry();
  fins.setAttribute("position", new THREE.Float32BufferAttribute(finPos, 3));
  fins.setIndex(finIdx);
  fins.computeVertexNormals();

  return { body, fins };
}

function buildSoftLattice(seed: number): {
  particles: SoftParticle[];
  springs: SoftSpring[];
  spineCount: number;
  radial: number;
} {
  const len = bodyLength();
  const spineCount = 14;
  const radial = 8;
  const particles: SoftParticle[] = [];
  const springs: SoftSpring[] = [];

  for (let s = 0; s < spineCount; s++) {
    const u = s / (spineCount - 1);
    const z = (u - 0.5) * len;
    const r = bodyRadius(u) * 0.92;
    const hy = bodyHeightScale(u);
    particles.push(makeParticle(0, 0, z, s === 0));
    for (let k = 0; k < radial; k++) {
      const a = (k / radial) * Math.PI * 2;
      particles.push(
        makeParticle(Math.cos(a) * r * 0.72, Math.sin(a) * r * hy, z, false),
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
      addSpring(base, base + 1 + k, 0.85);
      addSpring(base + 1 + k, base + 1 + ((k + 1) % radial), 0.75);
      addSpring(base + 1 + k, base + 1 + ((k + 2) % radial), 0.45);
    }
    if (s < spineCount - 1) {
      const next = (s + 1) * ringSize;
      addSpring(base, next, 0.95);
      for (let k = 0; k < radial; k++) {
        addSpring(base + 1 + k, next + 1 + k, 0.7);
        addSpring(base + 1 + k, next + 1 + ((k + 1) % radial), 0.4);
        addSpring(base + 1 + k, next, 0.35);
      }
    }
  }

  void seed;
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
  const len = bodyLength();

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

function createFish(id: number): FishSim {
  const seed = id * 17.13 + 2.4;
  const { body, fins } = buildFishGeometry(seed);
  const lattice = buildSoftLattice(seed);

  const restVerts = new Float32Array(
    (body.attributes.position as THREE.BufferAttribute).array as Float32Array,
  );
  const finRest = new Float32Array(
    (fins.attributes.position as THREE.BufferAttribute).array as Float32Array,
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

  const matIndex = id % FISH_MATS.length;
  const scale = 0.85 + seeded(seed) * 0.55;

  // Spawn in mid-water basin in front of the default camera
  const angle = (id / SCHOOL_COUNT) * Math.PI * 2 + seeded(seed + 1) * 0.4;
  const radius = 2.5 + seeded(seed + 2) * 5.5;
  const pos = new THREE.Vector3(
    Math.cos(angle) * radius * 0.85,
    2.8 + seeded(seed + 3) * 4.5,
    Math.sin(angle) * radius * 0.7 - 2.5,
  );
  const yaw = angle + Math.PI * 0.5 + seeded(seed + 4) * 0.5;
  const heading = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const baseSpeed = 1.05 + seeded(seed + 5) * 0.75;

  const mesh = new THREE.Mesh(body, FISH_MATS[matIndex]!);
  mesh.scale.setScalar(scale);
  mesh.frustumCulled = false;

  const finMesh = new THREE.Mesh(fins, FIN_MAT);
  finMesh.scale.setScalar(scale);
  finMesh.frustumCulled = false;

  return {
    id,
    mesh,
    finMesh,
    particles: lattice.particles,
    springs: lattice.springs,
    spineCount: lattice.spineCount,
    radial: lattice.radial,
    restVerts,
    influence: bind.influence,
    weights: bind.weights,
    pos,
    vel: heading.clone().multiplyScalar(baseSpeed),
    heading,
    yaw,
    pitch: 0,
    speed: baseSpeed,
    baseSpeed,
    phase: seeded(seed + 6) * Math.PI * 2,
    scale,
    matIndex,
    caIndex: id,
    finRest,
    finInfluence: finBind.influence,
    finWeights: finBind.weights,
  };
}

/* ── Soft-body step (Verlet + constraints) ─────────────────────── */

function stepSoftBody(fish: FishSim, dt: number, swimAmp: number, t: number) {
  const particles = fish.particles;
  const ringSize = 1 + fish.radial;
  const damp = 0.9;

  // Lateral undulation in local +X (sideways flex while body aims along Z)
  for (let s = 0; s < fish.spineCount; s++) {
    const u = s / (fish.spineCount - 1);
    const wave =
      Math.sin(u * 5.8 - t * 8.2 + fish.phase) * swimAmp * (0.4 + u * 1.25);
    const base = s * ringSize;
    const p = particles[base]!;
    if (!p.pinned) {
      p.x += wave * dt * 3.2;
    }
    for (let k = 0; k < fish.radial; k++) {
      const q = particles[base + 1 + k]!;
      q.x += wave * dt * 2.8;
      q.y += Math.sin(u * 3.2 - t * 5.5 + fish.phase) * swimAmp * 0.18 * dt;
    }
  }

  verletIntegrate(particles, dt, damp);

  const iters = softItersFor(SOFT_ITERS, qualityRuntime.tier);
  for (let iter = 0; iter < iters; iter++) {
    solveSprings(particles, fish.springs);

    for (let s = 0; s < fish.spineCount; s++) {
      const u = s / (fish.spineCount - 1);
      const z = (u - 0.5) * bodyLength();
      const r = bodyRadius(u) * 0.92;
      const hy = bodyHeightScale(u);
      const base = s * ringSize;
      const center = particles[base]!;
      if (!center.pinned) {
        center.x += (0 - center.x) * 0.1;
        center.y += (0 - center.y) * 0.1;
        center.z += (z - center.z) * 0.1;
      } else {
        center.x = 0;
        center.y = 0;
        center.z = z;
      }
      for (let k = 0; k < fish.radial; k++) {
        const a = (k / fish.radial) * Math.PI * 2;
        const q = particles[base + 1 + k]!;
        const rx = Math.cos(a) * r * 0.72;
        const ry = Math.sin(a) * r * hy;
        q.x += (rx - q.x) * 0.07;
        q.y += (ry - q.y) * 0.07;
        q.z += (z - q.z) * 0.07;
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

/* ── Boids (no pointer influence) ──────────────────────────────── */

const _sep = new THREE.Vector3();
const _ali = new THREE.Vector3();
const _coh = new THREE.Vector3();
const _steer = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _look = new THREE.Vector3();
const _fwd = new THREE.Vector3();

function boidsStep(fish: FishSim[], ca: SchoolCA, dt: number) {
  const n = fish.length;
  for (let i = 0; i < n; i++) {
    const f = fish[i]!;
    _sep.set(0, 0, 0);
    _ali.set(0, 0, 0);
    _coh.set(0, 0, 0);
    let sepN = 0;
    let aliN = 0;

    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const o = fish[j]!;
      const dx = f.pos.x - o.pos.x;
      const dy = f.pos.y - o.pos.y;
      const dz = f.pos.z - o.pos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < 2.6 * 2.6 && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        _sep.x += dx / d;
        _sep.y += dy / d;
        _sep.z += dz / d;
        sepN++;
      }
      if (d2 < 8 * 8) {
        _ali.add(o.vel);
        _coh.add(o.pos);
        aliN++;
      }
    }

    _steer.set(0, 0, 0);
    if (sepN > 0) {
      _sep.multiplyScalar(1 / sepN);
      _steer.addScaledVector(_sep, 1.4);
    }
    if (aliN > 0) {
      _ali.multiplyScalar(1 / aliN).normalize();
      _steer.addScaledVector(_ali, 0.58);
      _coh.multiplyScalar(1 / aliN).sub(f.pos).normalize();
      _steer.addScaledVector(_coh, 0.42);
    }

    const field = ca.field(f.caIndex);
    const live = ca.sample(f.caIndex);
    const caAngle = (f.caIndex / Math.max(1, ca.n)) * Math.PI * 2 + field * 1.25;
    _tmp.set(-Math.sin(caAngle), (live ? 0.18 : -0.06) * field, -Math.cos(caAngle));
    _steer.addScaledVector(_tmp, 0.38 + field * 0.55);

    const wt = f.phase + f.pos.x * 0.05;
    _tmp.set(Math.sin(wt * 0.7), Math.sin(wt * 0.45) * 0.4, Math.cos(wt * 0.6));
    _steer.addScaledVector(_tmp, 0.24);

    const cx = f.pos.x;
    const cz = f.pos.z + 3;
    const radial = Math.hypot(cx, cz);
    if (radial > 14) {
      _tmp.set(-cx, 0, -(f.pos.z + 3)).normalize();
      _steer.addScaledVector(_tmp, (radial - 14) * 0.4);
    }

    const yMin = SEABED_Y + 1.6;
    const yMax = SURFACE_Y - 4.5;
    if (f.pos.y < yMin) _steer.y += (yMin - f.pos.y) * 1.3;
    if (f.pos.y > yMax) _steer.y -= (f.pos.y - yMax) * 1.3;
    _steer.y += (4.5 - f.pos.y) * 0.05;

    if (f.pos.x < -16) _steer.x += 1.3;
    if (f.pos.x > 16) _steer.x -= 1.3;
    if (f.pos.z < -18) _steer.z += 1.1;
    if (f.pos.z > 8) _steer.z -= 0.9;

    const targetSpeed = f.baseSpeed * (0.78 + field * 0.55 + live * 0.28);
    f.vel.addScaledVector(_steer, dt * 2.5);
    const sp = f.vel.length() || 1e-6;
    const maxSp = targetSpeed * 1.65;
    const minSp = targetSpeed * 0.55;
    if (sp > maxSp) f.vel.multiplyScalar(maxSp / sp);
    else if (sp < minSp) f.vel.multiplyScalar(minSp / sp);

    f.pos.addScaledVector(f.vel, dt);
    f.speed = f.vel.length();
    f.heading.copy(f.vel).normalize();
    f.yaw = Math.atan2(-f.heading.x, -f.heading.z);
    f.pitch = Math.asin(THREE.MathUtils.clamp(f.heading.y, -0.85, 0.85));
    f.phase += dt * (4.8 + f.speed * 2.4);
  }
}

function orientFish(mesh: THREE.Object3D, heading: THREE.Vector3, bank: number) {
  // Head is at −Z locally. lookAt aims +Z at target, so aim at a point
  // behind the fish so the head leads along heading.
  _fwd.copy(heading).normalize();
  _look.copy(mesh.position).sub(_fwd);
  mesh.lookAt(_look);
  mesh.rotateZ(bank);
}

/* ── React component ───────────────────────────────────────────── */

export function TropicalFishSchool() {
  const group = useRef<THREE.Group>(null);
  const ca = useMemo(() => new SchoolCA(48, 0.1), []);
  const acc = useRef({ v: 0 });

  const school = useMemo(() => {
    const fish: FishSim[] = [];
    for (let i = 0; i < SCHOOL_COUNT; i++) fish.push(createFish(i));
    registerFishPositions(fish.map((f) => f.pos));
    return fish;
  }, []);

  const restLattices = useMemo(() => {
    return school.map((f) => f.particles.map((p) => ({ x: p.x, y: p.y, z: p.z })));
  }, [school]);

  useFrame(({ clock }, delta) => {
    const dt = Math.min(delta, 0.05);
    const t = clock.elapsedTime;
    ca.step(dt);
    boidsStep(school, ca, dt);

    const steps = consumeFixedSteps(acc.current, dt);
    const stepDt = steps > 0 ? SOFT_FIXED_DT : 0;

    for (let i = 0; i < school.length; i++) {
      const f = school[i]!;
      const field = ca.field(f.caIndex);
      const swimAmp = 0.1 + field * 0.14 + f.speed * 0.045;

      if (steps > 0) {
        for (let s = 0; s < steps; s++) {
          stepSoftBody(f, stepDt, swimAmp, t + f.phase * 0.1);
        }

        const bodyPos = f.mesh.geometry.attributes.position as THREE.BufferAttribute;
        deformMeshFromLattice(
          bodyPos,
          f.restVerts,
          f.particles,
          f.influence,
          f.weights,
          restLattices[i]!,
        );

        const finPos = f.finMesh.geometry.attributes.position as THREE.BufferAttribute;
        deformMeshFromLattice(
          finPos,
          f.finRest,
          f.particles,
          f.finInfluence,
          f.finWeights,
          restLattices[i]!,
        );
      }

      f.mesh.position.copy(f.pos);
      f.finMesh.position.copy(f.pos);

      const bank = THREE.MathUtils.clamp(
        -f.heading.x * 0.55 + f.vel.x * 0.04,
        -0.4,
        0.4,
      );
      orientFish(f.mesh, f.heading, bank);
      f.finMesh.quaternion.copy(f.mesh.quaternion);
    }
  });

  return (
    <group ref={group}>
      {school.map((f) => (
        <group key={f.id}>
          <primitive object={f.mesh} />
          <primitive object={f.finMesh} />
        </group>
      ))}
    </group>
  );
}
