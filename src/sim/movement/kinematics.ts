/**
 * Pure movement math (docs/DESIGN.md §4): view vectors, input to wish
 * direction, ground and air acceleration, fall damage. No Rapier here, so
 * every rule is unit-testable without a physics world.
 *
 * Conventions: +Y is up. Yaw rotates about +Y, right-handed, so yaw 0 looks
 * down −Z (the Three.js camera default) and positive yaw turns toward −X.
 */
import { Buttons, type InputCommand, type Vec3 } from '../types';
import type { MovementConfig } from './config';

/** Pitch is clamped to ±(π/2 − ε) so the view never flips (§8.2). */
export const PITCH_LIMIT = Math.PI / 2 - 0.01;

export function clampPitch(pitch: number): number {
  if (!Number.isFinite(pitch)) return 0;
  return Math.min(PITCH_LIMIT, Math.max(-PITCH_LIMIT, pitch));
}

/** Horizontal unit vector the pawn faces at `yaw`. */
export function forwardVector(yaw: number): Vec3 {
  return { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) };
}

/** Horizontal unit vector to the pawn's right at `yaw`. */
export function rightVector(yaw: number): Vec3 {
  return { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) };
}

/**
 * Horizontal direction the input asks to move in, length 0..1 (diagonals are
 * clamped so they are no faster than straight lines).
 */
export function wishDirection(input: Readonly<InputCommand>, yaw: number): Vec3 {
  const x = clampAxis(input.moveX);
  const y = clampAxis(input.moveY);
  if (x === 0 && y === 0) return { x: 0, y: 0, z: 0 };
  const f = forwardVector(yaw);
  const r = rightVector(yaw);
  const out = { x: r.x * x + f.x * y, y: 0, z: r.z * x + f.z * y };
  const len = Math.hypot(out.x, out.z);
  if (len > 1) {
    out.x /= len;
    out.z /= len;
  }
  return out;
}

function clampAxis(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(-1, v));
}

/**
 * Horizontal unit vector of the dodge requested by `buttons`, or null when no
 * dodge bit is set. Forward wins over back, then left over right, if a
 * controller ever sets more than one.
 */
export function dodgeDirection(buttons: number, yaw: number): Vec3 | null {
  if (buttons & Buttons.DodgeForward) return forwardVector(yaw);
  if (buttons & Buttons.DodgeBack) return negate(forwardVector(yaw));
  if (buttons & Buttons.DodgeLeft) return negate(rightVector(yaw));
  if (buttons & Buttons.DodgeRight) return rightVector(yaw);
  return null;
}

/** Ground acceleration in m/s²: full speed in `groundAccelTime` seconds. */
export function groundAcceleration(cfg: Readonly<MovementConfig>): number {
  return cfg.groundSpeed / Math.max(cfg.groundAccelTime, 1e-3);
}

/**
 * Move horizontal velocity toward `wish × maxSpeed` by at most `accel × dt`.
 * Braking (no input) uses the same rate, so a pawn stops as fast as it starts.
 * Returns the new horizontal velocity (y is preserved from `velocity`).
 */
export function accelerateGround(
  velocity: Readonly<Vec3>,
  wish: Readonly<Vec3>,
  maxSpeed: number,
  accel: number,
  dt: number,
): Vec3 {
  const tx = wish.x * maxSpeed;
  const tz = wish.z * maxSpeed;
  const dx = tx - velocity.x;
  const dz = tz - velocity.z;
  const dist = Math.hypot(dx, dz);
  const limit = accel * dt;
  if (dist <= limit || dist === 0) return { x: tx, y: velocity.y, z: tz };
  const k = limit / dist;
  return { x: velocity.x + dx * k, y: velocity.y, z: velocity.z + dz * k };
}

/**
 * Air control: accelerate along the wish direction only while the speed in
 * that direction is below `maxSpeed`, so momentum from a dodge or a jump pad
 * is kept but the pawn can still steer and reverse. Returns the new velocity.
 */
export function accelerateAir(
  velocity: Readonly<Vec3>,
  wish: Readonly<Vec3>,
  maxSpeed: number,
  accel: number,
  dt: number,
): Vec3 {
  const len = Math.hypot(wish.x, wish.z);
  if (len === 0) return { ...velocity };
  const ux = wish.x / len;
  const uz = wish.z / len;
  const current = velocity.x * ux + velocity.z * uz;
  const addSpeed = maxSpeed - current;
  if (addSpeed <= 0) return { ...velocity };
  const amount = Math.min(accel * dt * len, addSpeed);
  return { x: velocity.x + ux * amount, y: velocity.y, z: velocity.z + uz * amount };
}

/** True when a surface with this normal can be stood on. */
export function isWalkable(normal: Readonly<Vec3>, cfg: Readonly<MovementConfig>): boolean {
  return normal.y >= Math.cos((cfg.walkableSlope * Math.PI) / 180);
}

/**
 * Fall damage for a landing at `impactSpeed` m/s: 0 below the threshold,
 * `fallDamageLethal` at the lethal speed, linear in between and beyond.
 */
export function fallDamage(impactSpeed: number, cfg: Readonly<MovementConfig>): number {
  const min = cfg.fallDamageMinSpeed;
  const lethal = cfg.fallDamageLethalSpeed;
  if (!(impactSpeed >= min)) return 0;
  const span = Math.max(lethal - min, 1e-6);
  return Math.round((cfg.fallDamageLethal * (impactSpeed - min)) / span);
}

// -- Small vector helpers shared with the mover ----------------------------

export function negate(v: Readonly<Vec3>): Vec3 {
  return { x: -v.x, y: -v.y, z: -v.z };
}

export function add(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function scale(v: Readonly<Vec3>, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

export function dot(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function length(v: Readonly<Vec3>): number {
  return Math.hypot(v.x, v.y, v.z);
}

/** `v` with its component along unit `normal` removed (slide along a plane). */
export function projectOnPlane(v: Readonly<Vec3>, normal: Readonly<Vec3>): Vec3 {
  const d = dot(v, normal);
  return { x: v.x - normal.x * d, y: v.y - normal.y * d, z: v.z - normal.z * d };
}

export function horizontalSpeed(v: Readonly<Vec3>): number {
  return Math.hypot(v.x, v.z);
}
