import { useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { TropicalFishSchool } from "./TropicalFishSchool";
import { GreatWhiteSharks } from "./GreatWhiteSharks";
import { BottlenoseDolphins } from "./BottlenoseDolphins";


/**
 * World layout (Y up):
 *   SURFACE_Y  — undulating water ceiling (always above the camera)
 *   mid-water  — camera orbit zone + indifferent CA fish school
 *   SEABED_Y   — static sea floor base + coral
 */
const SURFACE_Y = 12;
const SEABED_Y = -1.5;
const CAM_Y = 1.8;
const CAM_MAX_Y = SURFACE_Y - 3.5;
const CAM_MIN_Y = SEABED_Y + 1.1;

/* ── materials ─────────────────────────────────────────────────── */

const MAT = {
  ocean: new THREE.MeshBasicMaterial({
    color: new THREE.Color("#6ef0df"),
    wireframe: true,
    transparent: true,
    opacity: 0.88,
    depthWrite: false,
    side: THREE.DoubleSide,
  }),
  oceanDeep: new THREE.MeshBasicMaterial({
    color: new THREE.Color("#1a5c56"),
    wireframe: true,
    transparent: true,
    opacity: 0.14,
    depthWrite: false,
    side: THREE.DoubleSide,
  }),
  cliff: new THREE.MeshBasicMaterial({
    color: new THREE.Color("#d4b896"),
    wireframe: true,
    transparent: true,
    opacity: 0.85,
  }),
  cliffDark: new THREE.MeshBasicMaterial({
    color: new THREE.Color("#a8896a"),
    wireframe: true,
    transparent: true,
    opacity: 0.7,
  }),
  coralA: new THREE.MeshBasicMaterial({
    color: new THREE.Color("#f0b4a0"),
    wireframe: true,
    transparent: true,
    opacity: 0.9,
  }),
  coralB: new THREE.MeshBasicMaterial({
    color: new THREE.Color("#f4c4b0"),
    wireframe: true,
    transparent: true,
    opacity: 0.85,
  }),
  coralC: new THREE.MeshBasicMaterial({
    color: new THREE.Color("#e8a090"),
    wireframe: true,
    transparent: true,
    opacity: 0.88,
  }),
  seabed: new THREE.MeshBasicMaterial({
    color: new THREE.Color("#8a7a5c"),
    wireframe: true,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  }),
  seabedDeep: new THREE.MeshBasicMaterial({
    color: new THREE.Color("#4a5a52"),
    wireframe: true,
    transparent: true,
    opacity: 0.35,
    depthWrite: false,
  }),
  shelf: new THREE.MeshBasicMaterial({
    color: new THREE.Color("#c4a882"),
    wireframe: true,
    transparent: true,
    opacity: 0.7,
  }),
  horizon: new THREE.MeshBasicMaterial({
    color: new THREE.Color("#7fe3d4"),
    wireframe: true,
    transparent: true,
    opacity: 0.26,
    depthWrite: false,
    side: THREE.DoubleSide,
  }),
};

function seeded(n: number) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function fbm2(x: number, z: number) {
  let v = 0;
  let a = 0.5;
  let f = 1;
  for (let i = 0; i < 4; i++) {
    v += a * Math.sin(x * f * 0.08 + i) * Math.cos(z * f * 0.07 + i * 1.3);
    a *= 0.5;
    f *= 2.05;
  }
  return v;
}

/** Proximity falloff: 1 near center, 0 outside outer radius */
function nearFalloff(dist: number, inner: number, outer: number): number {
  return 1 - THREE.MathUtils.smoothstep(dist, inner, outer);
}

/**
 * Continuous sea-floor height field (relative to SEABED_Y).
 * Rises into shelves at the cliff bases so walls meet the floor.
 */
function seabedRelHeight(x: number, z: number): number {
  const dunes =
    Math.sin(x * 0.14) * 0.22 +
    Math.cos(z * 0.11) * 0.18 +
    Math.sin(x * 0.07 + z * 0.09) * 0.15 +
    fbm2(x * 0.9, z * 0.9) * 0.28;

  const leftWall = nearFalloff(Math.abs(x + 26), 2, 14);
  const rightWall = nearFalloff(Math.abs(x - 26), 2, 14);
  const backWall = nearFalloff(Math.abs(z + 28), 3, 16);
  const leftFar = nearFalloff(Math.hypot(x + 34, z + 18), 4, 16);
  const rightFar = nearFalloff(Math.hypot(x - 36, z + 16), 4, 16);

  const shelf =
    leftWall * 1.15 +
    rightWall * 1.15 +
    backWall * 1.35 +
    leftFar * 0.9 +
    rightFar * 0.9;

  const radial = Math.hypot(x * 0.7, z + 6);
  const basin = -THREE.MathUtils.smoothstep(radial, 4, 22) * 0.35;

  return dunes + shelf + basin;
}

function seabedWorldY(x: number, z: number): number {
  return SEABED_Y + seabedRelHeight(x, z);
}

/* ── Ocean surface only ────────────────────────────────────────── */

function Ocean() {
  const surface = useRef<THREE.Mesh>(null);
  const restY = useRef<Float32Array | null>(null);

  const surfaceGeo = useMemo(() => {
    const g = new THREE.PlaneGeometry(140, 120, 160, 120);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position as THREE.BufferAttribute;
    const base = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) base[i] = pos.getY(i);
    restY.current = base;
    return g;
  }, []);

  const deepGeo = useMemo(() => {
    const g = new THREE.PlaneGeometry(110, 90, 36, 28);
    g.rotateX(-Math.PI / 2);
    return g;
  }, []);

  useFrame(({ clock }) => {
    const mesh = surface.current;
    const base = restY.current;
    if (!mesh || !base) return;
    const t = clock.elapsedTime;
    const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    for (let i = 0; i < pos.count; i++) {
      const ix = i * 3;
      const x = arr[ix]!;
      const z = arr[ix + 2]!;
      const dist = Math.hypot(x * 0.85, z);
      const live = 1 - THREE.MathUtils.smoothstep(dist, 32, 60) * 0.85;
      const swell =
        Math.sin(x * 0.09 + t * 0.55) * 0.95 +
        Math.cos(z * 0.075 - t * 0.4) * 0.7;
      const chop =
        Math.sin(x * 0.32 + z * 0.22 + t * 1.2) * 0.35 +
        Math.cos(x * 0.52 - z * 0.34 + t * 1.5) * 0.18 +
        Math.sin(x * 0.8 - t * 1.75) * Math.cos(z * 0.68 + t * 1.05) * 0.12;
      const cross = Math.sin(x * 0.16 - z * 0.14 + t * 0.68) * 0.4;
      arr[ix + 1] = base[i]! + (swell + chop + cross) * live;
    }
    pos.needsUpdate = true;
  });

  return (
    <group>
      <mesh
        geometry={deepGeo}
        material={MAT.oceanDeep}
        position={[0, (SURFACE_Y + SEABED_Y) * 0.35, 0]}
      />
      <mesh
        ref={surface}
        geometry={surfaceGeo}
        material={MAT.ocean}
        position={[0, SURFACE_Y, 0]}
      />
    </group>
  );
}

/* ── Sea floor (static) — meets cliff bases ────────────────────── */

function buildSeafloorGeometry(): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(120, 100, 96, 80);
  g.rotateX(-Math.PI / 2);
  const pos = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, seabedRelHeight(pos.getX(i), pos.getZ(i)));
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

function buildCliffFootGeometry(
  cx: number,
  cz: number,
  radius: number,
  seed: number,
): THREE.BufferGeometry {
  const segs = 36;
  const rings = 10;
  const positions: number[] = [];
  const push = (x: number, y: number, z: number) => {
    positions.push(x, y, z);
  };

  for (let r = 0; r < rings; r++) {
    const t0 = r / rings;
    const t1 = (r + 1) / rings;
    const rad0 = radius * t0;
    const rad1 = radius * t1;
    for (let s = 0; s < segs; s++) {
      const a0 = (s / segs) * Math.PI * 2;
      const a1 = ((s + 1) / segs) * Math.PI * 2;
      const pts: [number, number][] = [
        [cx + Math.cos(a0) * rad0, cz + Math.sin(a0) * rad0],
        [cx + Math.cos(a1) * rad0, cz + Math.sin(a1) * rad0],
        [cx + Math.cos(a0) * rad1, cz + Math.sin(a0) * rad1],
        [cx + Math.cos(a1) * rad1, cz + Math.sin(a1) * rad1],
      ];
      const ys = pts.map(([x, z]) => {
        const edge = t1;
        const bump =
          (1 - edge) * 0.05 +
          edge * (0.55 + seeded(x * 3 + z * 7 + seed) * 0.35);
        return (
          seabedRelHeight(x, z) +
          bump * THREE.MathUtils.smoothstep(edge, 0.15, 0.95)
        );
      });
      push(pts[0]![0], ys[0]!, pts[0]![1]);
      push(pts[2]![0], ys[2]!, pts[2]![1]);
      push(pts[1]![0], ys[1]!, pts[1]![1]);
      push(pts[1]![0], ys[1]!, pts[1]![1]);
      push(pts[2]![0], ys[2]!, pts[2]![1]);
      push(pts[3]![0], ys[3]!, pts[3]![1]);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}

function SeaFloor() {
  const floor = useMemo(() => buildSeafloorGeometry(), []);
  const detail = useMemo(() => {
    const g = new THREE.PlaneGeometry(70, 55, 70, 55);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      pos.setY(
        i,
        seabedRelHeight(x, z) +
          Math.sin(x * 0.9 + z * 0.4) * 0.04 +
          Math.cos(z * 1.1) * 0.03,
      );
    }
    pos.needsUpdate = true;
    return g;
  }, []);

  const feet = useMemo(
    () => [
      buildCliffFootGeometry(-26, -4, 12, 1),
      buildCliffFootGeometry(26, -2, 12, 2),
      buildCliffFootGeometry(0, -28, 16, 3),
      buildCliffFootGeometry(-34, -18, 11, 4),
      buildCliffFootGeometry(36, -16, 11, 5),
    ],
    [],
  );

  return (
    <group position={[0, SEABED_Y, 0]}>
      <mesh geometry={floor} material={MAT.seabedDeep} />
      <mesh geometry={detail} material={MAT.seabed} />
      {feet.map((g, i) => (
        <mesh key={i} geometry={g} material={MAT.shelf} />
      ))}
    </group>
  );
}

/* ── Cliffs ────────────────────────────────────────────────────── */

function buildCliffGeometry(seed: number): THREE.BufferGeometry {
  const segsX = 48;
  const segsY = 36;
  const width = 70;
  const height = 34;
  const depth = 28;
  const geo = new THREE.PlaneGeometry(width, height, segsX, segsY);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const arr = pos.array as Float32Array;

  for (let i = 0; i < pos.count; i++) {
    const ix = i * 3;
    const u = arr[ix]!;
    const v = arr[ix + 1]!;
    const ny = (v + height / 2) / height;
    const nx = u / (width / 2);
    const noise =
      fbm2(u * 1.2 + seed * 10, v * 1.1 + seed * 7) * 4.5 +
      Math.sin(u * 0.35 + seed) * 1.8 +
      Math.cos(v * 0.55 + seed * 2) * 1.2;
    const ledge =
      Math.max(0, Math.sin(ny * Math.PI * 3.2 + seed) * 1.4) *
      (0.4 + Math.abs(nx) * 0.3);
    const profile = (1 - ny * 0.55) * depth * 0.35 + noise + ledge;
    const valley = Math.pow(Math.abs(Math.sin(u * 0.12 + seed * 3)), 1.6) * 3.5;
    arr[ix + 2] = profile - valley * (0.4 + ny * 0.5);
    if (ny > 0.88) {
      arr[ix + 1] += seeded(i + seed * 100) * 1.6 - 0.4;
      arr[ix + 2] += seeded(i * 3 + seed) * 2.2;
    }
    if (ny < 0.18) {
      const foot = 1 - ny / 0.18;
      arr[ix + 2] = arr[ix + 2]! * (0.4 + ny * 2.2) + foot * 2.8;
      arr[ix + 1] = -height / 2 + foot * 0.2 + seeded(i) * 0.15;
    }
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

function Cliffs() {
  const left = useMemo(() => buildCliffGeometry(1.1), []);
  const right = useMemo(() => buildCliffGeometry(2.7), []);
  const back = useMemo(() => buildCliffGeometry(4.3), []);
  const leftFar = useMemo(() => buildCliffGeometry(6.2), []);
  const rightFar = useMemo(() => buildCliffGeometry(8.9), []);

  const cliffHeight = 34;
  const midY = SEABED_Y + cliffHeight / 2 - 0.3;

  return (
    <group>
      <mesh
        geometry={left}
        material={MAT.cliff}
        position={[-26, midY, -4]}
        rotation={[0, Math.PI / 2.15, 0]}
      />
      <mesh
        geometry={right}
        material={MAT.cliff}
        position={[26, midY + 0.15, -2]}
        rotation={[0, -Math.PI / 2.1, 0]}
      />
      <mesh
        geometry={back}
        material={MAT.cliffDark}
        position={[0, midY + 0.4, -28]}
      />
      <mesh
        geometry={leftFar}
        material={MAT.cliffDark}
        position={[-34, midY + 0.8, -18]}
        rotation={[0, Math.PI / 2.4, 0]}
        scale={[0.85, 1.1, 0.9]}
      />
      <mesh
        geometry={rightFar}
        material={MAT.cliffDark}
        position={[36, midY + 0.6, -16]}
        rotation={[0, -Math.PI / 2.5, 0]}
        scale={[0.9, 1.05, 0.95]}
      />
    </group>
  );
}

/* ── Coral resting on sea floor ────────────────────────────────── */

function buildCoralGeometry(seed: number, branches: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const addSegment = (
    a: THREE.Vector3,
    b: THREE.Vector3,
    radialSegs: number,
    radiusA: number,
    radiusB: number,
  ) => {
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    if (len < 0.01) return;
    dir.normalize();
    const up = Math.abs(dir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const n1 = new THREE.Vector3().crossVectors(dir, up).normalize();
    const n2 = new THREE.Vector3().crossVectors(dir, n1).normalize();
    const rings = Math.max(3, Math.floor(len * 4));
    for (let r = 0; r < rings; r++) {
      const t0 = r / rings;
      const t1 = (r + 1) / rings;
      const c0 = new THREE.Vector3().lerpVectors(a, b, t0);
      const c1 = new THREE.Vector3().lerpVectors(a, b, t1);
      const rad0 = THREE.MathUtils.lerp(radiusA, radiusB, t0);
      const rad1 = THREE.MathUtils.lerp(radiusA, radiusB, t1);
      for (let s = 0; s < radialSegs; s++) {
        const a0 = (s / radialSegs) * Math.PI * 2;
        const a1 = ((s + 1) / radialSegs) * Math.PI * 2;
        const p00 = c0.clone().addScaledVector(n1, Math.cos(a0) * rad0).addScaledVector(n2, Math.sin(a0) * rad0);
        const p01 = c0.clone().addScaledVector(n1, Math.cos(a1) * rad0).addScaledVector(n2, Math.sin(a1) * rad0);
        const p10 = c1.clone().addScaledVector(n1, Math.cos(a0) * rad1).addScaledVector(n2, Math.sin(a0) * rad1);
        const p11 = c1.clone().addScaledVector(n1, Math.cos(a1) * rad1).addScaledVector(n2, Math.sin(a1) * rad1);
        positions.push(p00.x, p00.y, p00.z, p10.x, p10.y, p10.z, p01.x, p01.y, p01.z);
        positions.push(p01.x, p01.y, p01.z, p10.x, p10.y, p10.z, p11.x, p11.y, p11.z);
      }
    }
  };

  type Branch = {
    origin: THREE.Vector3;
    dir: THREE.Vector3;
    length: number;
    radius: number;
    depth: number;
  };

  const queue: Branch[] = [
    {
      origin: new THREE.Vector3(0, 0, 0),
      dir: new THREE.Vector3(0, 1, 0),
      length: 1.8 + seeded(seed) * 1.2,
      radius: 0.28 + seeded(seed + 1) * 0.12,
      depth: 0,
    },
  ];

  let count = 0;
  while (queue.length && count < branches) {
    const b = queue.shift()!;
    count++;
    const end = b.origin.clone().addScaledVector(b.dir, b.length);
    const mid = b.origin
      .clone()
      .addScaledVector(b.dir, b.length * 0.5)
      .add(
        new THREE.Vector3(
          (seeded(seed + count * 3) - 0.5) * 0.35,
          0,
          (seeded(seed + count * 5) - 0.5) * 0.35,
        ),
      );
    addSegment(b.origin, mid, 5, b.radius, b.radius * 0.75);
    addSegment(mid, end, 5, b.radius * 0.75, b.radius * 0.4);
    if (b.depth < 4) {
      const splits = b.depth === 0 ? 3 : 2 + (seeded(seed + count) > 0.55 ? 1 : 0);
      for (let s = 0; s < splits; s++) {
        const yaw = (s / splits) * Math.PI * 2 + seeded(seed + count + s) * 0.8;
        const pitch = 0.35 + seeded(seed * 2 + count + s) * 0.55;
        const dir = new THREE.Vector3(
          Math.sin(pitch) * Math.cos(yaw),
          Math.cos(pitch) * (0.7 + seeded(count + s) * 0.5),
          Math.sin(pitch) * Math.sin(yaw),
        ).normalize();
        queue.push({
          origin: end.clone(),
          dir,
          length: b.length * (0.45 + seeded(seed + s * 9 + count) * 0.3),
          radius: b.radius * (0.45 + seeded(seed + s) * 0.2),
          depth: b.depth + 1,
        });
      }
    }
  }

  const padR = 0.55 + seeded(seed + 9) * 0.3;
  const padSegs = 12;
  for (let s = 0; s < padSegs; s++) {
    const a0 = (s / padSegs) * Math.PI * 2;
    const a1 = ((s + 1) / padSegs) * Math.PI * 2;
    positions.push(0, 0.02, 0);
    positions.push(Math.cos(a0) * padR, 0.02, Math.sin(a0) * padR);
    positions.push(Math.cos(a1) * padR, 0.02, Math.sin(a1) * padR);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function CoralField() {
  const colonies = useMemo(() => {
    const items: {
      geo: THREE.BufferGeometry;
      position: [number, number, number];
      scale: number;
      rot: number;
      mat: THREE.MeshBasicMaterial;
    }[] = [];
    const mats = [MAT.coralA, MAT.coralB, MAT.coralC];

    const xz: [number, number][] = [
      [-7, -8],
      [-11, -4],
      [-4, -12],
      [5, -10],
      [10, -6],
      [3, -14],
      [-14, -12],
      [13, -13],
      [-2, -6],
      [8, -16],
      [-16, -6],
      [1, -18],
      [-9, -16],
      [12, -9],
      [-5, -15],
      [0, -9],
      [16, -17],
      [-18, -15],
      [6, -4],
      [-12, -18],
      [-20, -6],
      [-18, -2],
      [-22, -10],
      [20, -4],
      [18, -8],
      [22, -12],
      [-6, -22],
      [4, -24],
      [0, -20],
      [10, -22],
    ];

    for (let i = 0; i < xz.length; i++) {
      const [x, z] = xz[i]!;
      const y = seabedWorldY(x, z) + 0.02;
      items.push({
        geo: buildCoralGeometry(i * 17.13 + 3.1, 12 + (i % 6)),
        position: [x, y, z],
        scale: 0.85 + seeded(i * 2.2) * 1.15,
        rot: seeded(i * 4.1) * Math.PI * 2,
        mat: mats[i % mats.length]!,
      });
    }
    return items;
  }, []);

  const group = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const g = group.current;
    if (!g) return;
    g.children.forEach((child, i) => {
      child.rotation.z = Math.sin(t * 0.45 + i * 0.7) * 0.03;
      child.rotation.x = Math.cos(t * 0.35 + i * 0.5) * 0.02;
    });
  });

  return (
    <group ref={group}>
      {colonies.map((c, i) => (
        <mesh
          key={i}
          geometry={c.geo}
          material={c.mat}
          position={c.position}
          scale={c.scale}
          rotation={[0, c.rot, 0]}
        />
      ))}
    </group>
  );
}

/* ── Sky above the waterline ───────────────────────────────────── */

function SkyWire() {
  const sun = useMemo(() => new THREE.IcosahedronGeometry(3.8, 2), []);
  const ring = useMemo(() => new THREE.TorusGeometry(22, 0.12, 6, 100), []);
  const ring2 = useMemo(() => new THREE.TorusGeometry(30, 0.08, 5, 84), []);
  const dome = useMemo(
    () => new THREE.SphereGeometry(80, 48, 24, 0, Math.PI * 2, 0, Math.PI * 0.45),
    [],
  );
  const sunMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: new THREE.Color("#f5c6a8"),
        wireframe: true,
        transparent: true,
        opacity: 0.65,
      }),
    [],
  );
  const domeMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: new THREE.Color("#8ecfc4"),
        wireframe: true,
        transparent: true,
        opacity: 0.07,
        side: THREE.BackSide,
        depthWrite: false,
      }),
    [],
  );
  const sunRef = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (sunRef.current) {
      sunRef.current.rotation.y = clock.elapsedTime * 0.05;
      sunRef.current.rotation.z = clock.elapsedTime * 0.03;
    }
  });

  return (
    <group>
      <mesh geometry={dome} material={domeMat} position={[0, SURFACE_Y + 2, 0]} />
      <mesh
        ref={sunRef}
        geometry={sun}
        material={sunMat}
        position={[-6, SURFACE_Y + 9, -14]}
      />
      <mesh
        geometry={ring}
        material={MAT.horizon}
        position={[0, SURFACE_Y + 0.25, 0]}
        rotation={[Math.PI / 2, 0, 0]}
      />
      <mesh
        geometry={ring2}
        material={MAT.horizon}
        position={[0, SURFACE_Y + 0.5, 0]}
        rotation={[Math.PI / 2, 0, 0.12]}
      />
    </group>
  );
}

/* ── Camera locked under the surface ───────────────────────────── */

function CameraRig() {
  const controls = useRef<OrbitControlsImpl>(null);
  const { camera, size } = useThree();

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const c = controls.current;
    if (!c) return;

    c.target.y = THREE.MathUtils.clamp(
      4.2 + Math.sin(t * 0.18) * 0.2,
      CAM_MIN_Y + 1,
      SURFACE_Y - 4,
    );
    c.target.x = Math.sin(t * 0.09) * 0.35;
    c.update();

    if (camera.position.y > CAM_MAX_Y) camera.position.y = CAM_MAX_Y;
    if (camera.position.y < CAM_MIN_Y) camera.position.y = CAM_MIN_Y;
  });

  const portrait = size.height > size.width;

  return (
    <OrbitControls
      ref={controls}
      enablePan={false}
      enableDamping
      dampingFactor={0.05}
      rotateSpeed={0.48}
      zoomSpeed={0.55}
      minDistance={portrait ? 4 : 3.5}
      maxDistance={portrait ? 14 : 16}
      minPolarAngle={Math.PI * 0.42}
      maxPolarAngle={Math.PI * 0.92}
      autoRotate
      autoRotateSpeed={0.14}
      target={[0, 4.5, -1]}
      makeDefault
      touches={{
        ONE: THREE.TOUCH.ROTATE,
        TWO: THREE.TOUCH.DOLLY_PAN,
      }}
    />
  );
}

function SceneContent() {
  return (
    <>
      <color attach="background" args={["#05121a"]} />
      <fog attach="fog" args={["#081820", 12, 42]} />
      <ambientLight intensity={1} />
      <CameraRig />
      <SeaFloor />
      <Ocean />
      <Cliffs />
      <CoralField />
      <TropicalFishSchool />
      <GreatWhiteSharks />
      <BottlenoseDolphins />
      <SkyWire />
    </>
  );
}

export function WireframeScene() {
  return (
    <Canvas
      dpr={[1, 1.75]}
      gl={{
        antialias: true,
        alpha: false,
        powerPreference: "high-performance",
        stencil: false,
      }}
      camera={{ position: [3.2, CAM_Y, 7.5], fov: 68, near: 0.1, far: 180 }}
      style={{ width: "100%", height: "100%", background: "#05121a" }}
      onCreated={({ gl, camera }) => {
        gl.setClearColor(new THREE.Color("#05121a"), 1);
        gl.outputColorSpace = THREE.SRGBColorSpace;
        camera.lookAt(0, SURFACE_Y - 1, 0);
      }}
    >
      <SceneContent />
    </Canvas>
  );
}
