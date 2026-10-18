/**
 * Small vector helpers for the weapon framework. Plain `Vec3` objects, no
 * Three.js (docs/DESIGN.md §8.1).
 */
import type { Vec3 } from '../../types';

export const ZERO: Readonly<Vec3> = Object.freeze({ x: 0, y: 0, z: 0 });
export const UP: Readonly<Vec3> = Object.freeze({ x: 0, y: 1, z: 0 });

export function vec(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function copy(v: Readonly<Vec3>): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

export function add(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(v: Readonly<Vec3>, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

export function dot(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

export function length(v: Readonly<Vec3>): number {
  return Math.hypot(v.x, v.y, v.z);
}

export function distance(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Unit vector, or `fallback` (default +Y) for a zero or non-finite input. */
export function normalize(v: Readonly<Vec3>, fallback: Readonly<Vec3> = UP): Vec3 {
  const len = length(v);
  if (!(len > 0) || !Number.isFinite(len)) return copy(fallback);
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

/** Reflect `v` off a surface with unit normal `n`. */
export function reflect(v: Readonly<Vec3>, n: Readonly<Vec3>): Vec3 {
  const d = 2 * dot(v, n);
  return { x: v.x - d * n.x, y: v.y - d * n.y, z: v.z - d * n.z };
}

/**
 * Unit view direction for `yaw` / `pitch`, matching the pawn convention
 * (`forwardVector` in `src/sim/movement/kinematics.ts`): yaw 0 looks down −Z,
 * positive pitch looks up.
 */
export function directionFromAngles(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  // `0 -` rather than unary minus so a straight shot reads as 0, not -0.
  return { x: 0 - Math.sin(yaw) * cp, y: Math.sin(pitch), z: 0 - Math.cos(yaw) * cp };
}

/** Yaw and pitch of a direction; the inverse of `directionFromAngles`. */
export function anglesFromDirection(dir: Readonly<Vec3>): { yaw: number; pitch: number } {
  const horizontal = Math.hypot(dir.x, dir.z);
  return { yaw: Math.atan2(-dir.x, -dir.z), pitch: Math.atan2(dir.y, horizontal) };
}

/** Wrap an angle difference into (−π, π]. */
export function wrapAngle(a: number): number {
  let r = a % (2 * Math.PI);
  if (r > Math.PI) r -= 2 * Math.PI;
  if (r <= -Math.PI) r += 2 * Math.PI;
  return r;
}

/** Orthonormal right and up vectors for a unit `forward`. */
export function basisFor(forward: Readonly<Vec3>): { right: Vec3; up: Vec3 } {
  const ref = Math.abs(forward.y) > 0.99 ? vec(1, 0, 0) : UP;
  const right = normalize(cross(forward, ref), vec(1, 0, 0));
  const up = normalize(cross(right, forward), UP);
  return { right, up };
}

/**
 * Rotate a unit `forward` by `angle` radians toward the direction at `theta`
 * around it (0 = right, π/2 = up).
 */
export function deflect(forward: Readonly<Vec3>, angle: number, theta: number): Vec3 {
  if (angle === 0) return copy(forward);
  const { right, up } = basisFor(forward);
  const s = Math.sin(angle);
  const c = Math.cos(angle);
  const ox = Math.cos(theta) * s;
  const oy = Math.sin(theta) * s;
  return normalize({
    x: forward.x * c + right.x * ox + up.x * oy,
    y: forward.y * c + right.y * ox + up.y * oy,
    z: forward.z * c + right.z * ox + up.z * oy,
  });
}

/** Closest point to `p` on the segment `a`–`b`. */
export function closestPointOnSegment(
  p: Readonly<Vec3>,
  a: Readonly<Vec3>,
  b: Readonly<Vec3>,
): Vec3 {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  if (len2 === 0) return copy(a);
  const t = Math.min(1, Math.max(0, dot(sub(p, a), ab) / len2));
  return add(a, scale(ab, t));
}

/**
 * Distance along a ray from `origin` in unit `dir` to the first intersection
 * with a sphere, or null when the ray misses or starts past it.
 */
export function raySphere(
  origin: Readonly<Vec3>,
  dir: Readonly<Vec3>,
  center: Readonly<Vec3>,
  radius: number,
): number | null {
  const oc = sub(origin, center);
  const b = dot(oc, dir);
  const c = dot(oc, oc) - radius * radius;
  if (c <= 0) return 0;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : null;
}
