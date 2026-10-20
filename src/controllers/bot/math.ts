/** Small vector helpers for the bot controller (horizontal = x/z plane). */
import type { Vec3 } from '../../sim/types';

export function horizontalDistance(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function distance(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Unit horizontal direction from `from` to `to`, or null when they coincide. */
export function horizontalDirection(from: Readonly<Vec3>, to: Readonly<Vec3>): Vec3 | null {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return null;
  return { x: dx / len, y: 0, z: dz / len };
}

/** Unit horizontal vector, or null for a zero vector. */
export function normalizeHorizontal(v: Readonly<Vec3>): Vec3 | null {
  const len = Math.hypot(v.x, v.z);
  if (len < 1e-6) return null;
  return { x: v.x / len, y: 0, z: v.z / len };
}

export function copy(v: Readonly<Vec3>): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

/** Travel estimate that counts height as expensive: ledges need pads or links. */
export function travelDistance(from: Readonly<Vec3>, to: Readonly<Vec3>): number {
  return horizontalDistance(from, to) + 2 * Math.abs(to.y - from.y);
}
