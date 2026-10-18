/**
 * Brush → Three.js geometry, following the conventions of the physics glue
 * (`src/sim/physics/shapes.ts`) so what you see is what you collide with:
 * - geometry is centered on the brush position; yaw rotates about +Y;
 * - `box`: full extents `size`;
 * - `cylinder`: `size.x` diameter, `size.y` height, standing on Y;
 * - `ramp`: a wedge filling `size`, top edge along local +Z.
 */
import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Vector3,
} from 'three';
import { rampLocalVertices } from '../../sim/physics/shapes';
import type { Brush, Vec3 } from '../../sim/types';

/** Radial segments for cylinder brushes. */
export const CYLINDER_SEGMENTS = 32;

/** Wedge faces as corner indices into `rampLocalVertices` (quads split into two triangles). */
// prettier-ignore
const RAMP_TRIANGLES: readonly number[] = [
  0, 1, 3,  0, 3, 2, // bottom
  0, 1, 5,  0, 5, 4, // slope
  2, 3, 5,  2, 5, 4, // back (high side)
  0, 2, 4,          // left side
  1, 3, 5,          // right side
];

/**
 * Wedge geometry for a ramp brush. Non-indexed so every face gets a flat
 * normal; triangles are wound outward (counter-clockwise seen from outside).
 */
export function rampGeometry(size: Vec3): BufferGeometry {
  const corners = rampLocalVertices(size);
  const corner = (i: number): Vector3 =>
    new Vector3(corners[i * 3] ?? 0, corners[i * 3 + 1] ?? 0, corners[i * 3 + 2] ?? 0);
  // Centroid of the wedge, used to orient each triangle outward.
  const centroid = new Vector3();
  for (let i = 0; i < 6; i++) centroid.add(corner(i));
  centroid.multiplyScalar(1 / 6);

  const positions: number[] = [];
  const ab = new Vector3();
  const ac = new Vector3();
  const n = new Vector3();
  const mid = new Vector3();
  for (let t = 0; t < RAMP_TRIANGLES.length; t += 3) {
    const a = corner(RAMP_TRIANGLES[t] ?? 0);
    let b = corner(RAMP_TRIANGLES[t + 1] ?? 0);
    let c = corner(RAMP_TRIANGLES[t + 2] ?? 0);
    n.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a));
    mid
      .copy(a)
      .add(b)
      .add(c)
      .multiplyScalar(1 / 3)
      .sub(centroid);
    if (n.dot(mid) < 0) [b, c] = [c, b];
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}

/** Geometry for one brush, in brush-local space (centered, before yaw). */
export function brushGeometry(brush: Brush): BufferGeometry {
  const { x, y, z } = brush.size;
  switch (brush.shape) {
    case 'box':
      return new BoxGeometry(x, y, z);
    case 'cylinder':
      return new CylinderGeometry(x / 2, x / 2, y, CYLINDER_SEGMENTS);
    case 'ramp':
      return rampGeometry(brush.size);
  }
}
