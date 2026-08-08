import type * as THREE from "three";

/** Live fish world positions (shared Vector3 refs updated each frame by the school). */
export const fishWorldPositions: THREE.Vector3[] = [];

/** Live shark world positions — dolphins/mermaids read these to flee when hunted. */
export const sharkWorldPositions: THREE.Vector3[] = [];

/** Live dolphin world positions — sharks may pursue when hungry. */
export const dolphinWorldPositions: THREE.Vector3[] = [];

/** Live mermaid world positions — sharks may pursue when hungry. */
export const mermaidWorldPositions: THREE.Vector3[] = [];

export function registerFishPositions(positions: THREE.Vector3[]) {
  fishWorldPositions.length = 0;
  for (const p of positions) fishWorldPositions.push(p);
}

export function registerSharkPositions(positions: THREE.Vector3[]) {
  sharkWorldPositions.length = 0;
  for (const p of positions) sharkWorldPositions.push(p);
}

export function registerDolphinPositions(positions: THREE.Vector3[]) {
  dolphinWorldPositions.length = 0;
  for (const p of positions) dolphinWorldPositions.push(p);
}

export function registerMermaidPositions(positions: THREE.Vector3[]) {
  mermaidWorldPositions.length = 0;
  for (const p of positions) mermaidWorldPositions.push(p);
}
