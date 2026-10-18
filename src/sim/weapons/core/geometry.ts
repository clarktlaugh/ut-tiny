/**
 * Pawn geometry the weapon framework needs: eye position, capsule segment,
 * head zone. Derived from the §3 capsule (1.8 m, radius 0.4, eye 1.6 m) and
 * the movement packet's crouch scaling so sweeps, traces and splash agree
 * with what the physics world holds.
 */
import { DEFAULT_MOVEMENT, feetOffset, pawnCapsule } from '../../movement';
import type { CapsuleDims } from '../../physics/physicsWorld';
import type { PawnState, Vec3 } from '../../types';
import { closestPointOnSegment, distance } from './math';

/** Eye height above the feet when standing (§3). */
export const EYE_HEIGHT = 1.6;

/** Height of the head zone at the top of the capsule, for headshots. */
export const HEAD_HEIGHT = 0.3;

/** Capsule of a pawn in its current stance. */
export function capsuleOf(pawn: Readonly<Pick<PawnState, 'crouching'>>): CapsuleDims {
  return pawnCapsule(pawn.crouching, DEFAULT_MOVEMENT);
}

/** Eye position: `EYE_HEIGHT` above the feet, scaled with the crouch height. */
export function eyePosition(pawn: Readonly<Pick<PawnState, 'position' | 'crouching'>>): Vec3 {
  const capsule = capsuleOf(pawn);
  const scale = pawn.crouching ? DEFAULT_MOVEMENT.crouchHeightScale : 1;
  return {
    x: pawn.position.x,
    y: pawn.position.y - feetOffset(capsule) + EYE_HEIGHT * scale,
    z: pawn.position.z,
  };
}

/** World-space height above which a hit on the pawn counts as a headshot. */
export function headshotHeight(pawn: Readonly<Pick<PawnState, 'position' | 'crouching'>>): number {
  const capsule = capsuleOf(pawn);
  return pawn.position.y + capsule.halfHeight + capsule.radius - HEAD_HEIGHT;
}

/** Shortest distance from `point` to the pawn's capsule surface (0 when inside). */
export function distanceToPawn(
  point: Readonly<Vec3>,
  pawn: Readonly<Pick<PawnState, 'position' | 'crouching'>>,
): number {
  const capsule = capsuleOf(pawn);
  const p = pawn.position;
  const a = { x: p.x, y: p.y - capsule.halfHeight, z: p.z };
  const b = { x: p.x, y: p.y + capsule.halfHeight, z: p.z };
  return Math.max(0, distance(point, closestPointOnSegment(point, a, b)) - capsule.radius);
}
