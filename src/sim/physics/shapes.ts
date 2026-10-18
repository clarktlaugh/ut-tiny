/**
 * Pure geometry helpers for turning `MapDef` brushes and props into collider
 * inputs. No Rapier calls here, so the conventions are easy to test.
 *
 * Conventions (shared with the renderer and the navmesh bake):
 * - `yaw` rotates about +Y, right-handed (positive yaw turns +X toward −Z).
 * - A `box` brush is a cuboid with full extents `size`.
 * - A `cylinder` brush stands on the Y axis: `size.x` is the diameter,
 *   `size.y` the height (`size.z` is ignored).
 * - A `ramp` brush is a wedge filling the box `size`: its bottom face is full,
 *   and its top edge runs along local +Z, so walking toward local +Z climbs.
 */
import type { Brush, Quat, Vec3 } from '../types';

/** Quaternion for a rotation of `yaw` radians about +Y. */
export function yawQuat(yaw: number): Quat {
  const h = yaw / 2;
  return { x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) };
}

/** Rotate `v` by unit quaternion `q`. */
export function rotateVec(q: Quat, v: Vec3): Vec3 {
  // v' = v + 2w(u × v) + 2u × (u × v), with u = (q.x, q.y, q.z).
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

/**
 * The six corners of a ramp brush's wedge in brush-local space (centered on
 * the brush position, before yaw). Flat array of x, y, z triples.
 */
export function rampLocalVertices(size: Vec3): Float32Array {
  const hx = size.x / 2;
  const hy = size.y / 2;
  const hz = size.z / 2;
  // prettier-ignore
  return new Float32Array([
    -hx, -hy, -hz,  hx, -hy, -hz, // low edge
    -hx, -hy,  hz,  hx, -hy,  hz, // bottom of the high side
    -hx,  hy,  hz,  hx,  hy,  hz, // top edge
  ]);
}

/** Validate that a brush has positive extents for the parts its shape uses. */
export function brushIsValid(brush: Brush): boolean {
  const { x, y, z } = brush.size;
  if (brush.shape === 'cylinder') return x > 0 && y > 0;
  return x > 0 && y > 0 && z > 0;
}

/**
 * Asset-space triangle mesh for a prop. Supplied by whoever loads the asset
 * (procedural props now, GLTF later); the physics glue applies the prop's
 * scale, rotation and position.
 */
export interface PropGeometry {
  /** Flat x, y, z triples in asset space. */
  vertices: Float32Array;
  /** Triangle indices into `vertices` (three per triangle). */
  indices: Uint32Array;
}

/** Multiply each vertex component-wise by `scale`. Returns a new array. */
export function scaleVertices(vertices: Float32Array, scale: Vec3): Float32Array {
  const out = new Float32Array(vertices.length);
  for (let i = 0; i + 2 < vertices.length; i += 3) {
    out[i] = (vertices[i] ?? 0) * scale.x;
    out[i + 1] = (vertices[i + 1] ?? 0) * scale.y;
    out[i + 2] = (vertices[i + 2] ?? 0) * scale.z;
  }
  return out;
}

/** Axis-aligned bounds of a flat vertex array: center and half extents. */
export function vertexBounds(vertices: Float32Array): { center: Vec3; half: Vec3 } {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i + 2 < vertices.length; i += 3) {
    const x = vertices[i] ?? 0;
    const y = vertices[i + 1] ?? 0;
    const z = vertices[i + 2] ?? 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  if (minX > maxX) {
    return { center: { x: 0, y: 0, z: 0 }, half: { x: 0, y: 0, z: 0 } };
  }
  return {
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 },
    half: { x: (maxX - minX) / 2, y: (maxY - minY) / 2, z: (maxZ - minZ) / 2 },
  };
}
