/** Shared Verlet / spring helpers — stable, allocation-free. */

export type SoftParticle = {
  x: number;
  y: number;
  z: number;
  px: number;
  py: number;
  pz: number;
  pinned: boolean;
};

export type SoftSpring = {
  a: number;
  b: number;
  rest: number;
  stiff: number;
};

export const SOFT_FIXED_DT = 1 / 60;
const MAX_PARTICLE_SPEED = 7.5;
const STRETCH_LIMIT = 1.32;

export function makeParticle(
  x: number,
  y: number,
  z: number,
  pinned = false,
): SoftParticle {
  return { x, y, z, px: x, py: y, pz: z, pinned };
}

/** Integrate Verlet with damping + speed clamp (prevents lattice explosions). */
export function verletIntegrate(
  particles: SoftParticle[],
  dt: number,
  dampBase: number,
) {
  const damp = Math.pow(dampBase, dt * 60);
  const maxStep = MAX_PARTICLE_SPEED * dt;
  for (const p of particles) {
    if (p.pinned) {
      p.px = p.x;
      p.py = p.y;
      p.pz = p.z;
      continue;
    }
    let vx = (p.x - p.px) * damp;
    let vy = (p.y - p.py) * damp;
    let vz = (p.z - p.pz) * damp;
    const sp = Math.hypot(vx, vy, vz);
    if (sp > maxStep && sp > 1e-8) {
      const s = maxStep / sp;
      vx *= s;
      vy *= s;
      vz *= s;
    }
    p.px = p.x;
    p.py = p.y;
    p.pz = p.z;
    p.x += vx;
    p.y += vy;
    p.z += vz;
  }
}

/** Distance constraints with extra pull-back past stretch limit. */
export function solveSprings(particles: SoftParticle[], springs: SoftSpring[]) {
  for (const s of springs) {
    const a = particles[s.a]!;
    const b = particles[s.b]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const d = Math.hypot(dx, dy, dz) || 1e-6;
    let corr = ((d - s.rest) / d) * 0.5 * s.stiff;
    if (d > s.rest * STRETCH_LIMIT) {
      corr += ((d - s.rest * STRETCH_LIMIT) / d) * 0.28;
    }
    if (!a.pinned) {
      a.x += dx * corr;
      a.y += dy * corr;
      a.z += dz * corr;
    }
    if (!b.pinned) {
      b.x -= dx * corr;
      b.y -= dy * corr;
      b.z -= dz * corr;
    }
  }
}

export function consumeFixedSteps(
  acc: { v: number },
  dt: number,
  maxSteps = 2,
): number {
  acc.v += Math.min(dt, 0.08);
  let n = 0;
  while (acc.v >= SOFT_FIXED_DT && n < maxSteps) {
    acc.v -= SOFT_FIXED_DT;
    n++;
  }
  return n;
}
