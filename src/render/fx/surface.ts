/**
 * Surface probes: how the FX system finds the wall or floor behind a hit so
 * it can orient decals and settle gibs. The default probe raycasts the static
 * scene meshes; tests can pass a plain function.
 */
import { Raycaster, Vector3, type Object3D } from 'three';
import type { Vec3 } from '../../sim/types';

export interface SurfaceHit {
  point: Vec3;
  normal: Vec3;
  distance: number;
}

/**
 * Cast from `origin` along `direction` (unit) up to `maxDistance`. Returns the
 * first surface, or null. Called at event time only, never per frame.
 */
export type SurfaceProbe = (
  origin: Readonly<Vec3>,
  direction: Readonly<Vec3>,
  maxDistance: number,
) => SurfaceHit | null;

/** A probe that never finds anything: no decals, gibs fall forever. */
export const NO_SURFACE: SurfaceProbe = () => null;

/** Infinite horizontal floor at `y`; handy for tests and empty scenes. */
export function flatFloorProbe(y: number): SurfaceProbe {
  return (origin, direction, maxDistance) => {
    if (direction.y >= -1e-6) return null;
    const t = (origin.y - y) / -direction.y;
    if (t < 0 || t > maxDistance) return null;
    return {
      point: { x: origin.x + direction.x * t, y, z: origin.z + direction.z * t },
      normal: { x: 0, y: 1, z: 0 },
      distance: t,
    };
  };
}

const rayOrigin = new Vector3();
const rayDir = new Vector3();

/**
 * Raycast probe over `objects` (recursively), e.g. a `MapView`'s brushes and
 * props. World matrices are refreshed on each call, so the probe is correct
 * before the first render too.
 */
export function raycastProbe(objects: readonly Object3D[]): SurfaceProbe {
  const raycaster = new Raycaster();
  return (origin, direction, maxDistance) => {
    for (const o of objects) o.updateWorldMatrix(true, true);
    rayOrigin.set(origin.x, origin.y, origin.z);
    rayDir.set(direction.x, direction.y, direction.z);
    if (rayDir.lengthSq() < 1e-12) return null;
    rayDir.normalize();
    raycaster.set(rayOrigin, rayDir);
    raycaster.near = 0;
    raycaster.far = maxDistance;
    const hits = raycaster.intersectObjects(objects as Object3D[], true);
    const hit = hits[0];
    if (!hit) return null;
    const n = hit.normal ?? hit.face?.normal;
    const normal = n ? { x: n.x, y: n.y, z: n.z } : { x: -rayDir.x, y: -rayDir.y, z: -rayDir.z };
    return {
      point: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
      normal,
      distance: hit.distance,
    };
  };
}
