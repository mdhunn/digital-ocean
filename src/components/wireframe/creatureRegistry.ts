import type * as THREE from "three";

/** Live fish world positions (shared Vector3 refs updated each frame by the school). */
export const fishWorldPositions: THREE.Vector3[] = [];

export function registerFishPositions(positions: THREE.Vector3[]) {
  fishWorldPositions.length = 0;
  for (const p of positions) fishWorldPositions.push(p);
}
