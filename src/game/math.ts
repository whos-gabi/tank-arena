import * as THREE from "three";

export function angleLerp(current: number, target: number, smoothing: number) {
  const delta = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + delta * smoothing;
}

export function approachVector(
  current: THREE.Vector3,
  target: THREE.Vector3,
  delta: number,
  responsiveness: number,
) {
  const factor = 1 - Math.exp(-delta * responsiveness);
  current.lerp(target, factor);
}

export function forwardFromHeading(heading: number) {
  return new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading));
}

export function circleIntersectsBox(position: THREE.Vector3, radius: number, box: THREE.Box3) {
  const closestX = THREE.MathUtils.clamp(position.x, box.min.x, box.max.x);
  const closestZ = THREE.MathUtils.clamp(position.z, box.min.z, box.max.z);
  const dx = position.x - closestX;
  const dz = position.z - closestZ;
  return dx * dx + dz * dz < radius * radius;
}
