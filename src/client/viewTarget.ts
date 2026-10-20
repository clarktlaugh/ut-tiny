/**
 * View-target resolution and camera placement (docs/DESIGN.md §5.1, §8.3).
 *
 * `DefaultViewTargetResolver` implements the `ViewTargetResolver` contract
 * from `src/render/viewTarget.ts`: the local pawn's eyes normally, the
 * Redeemer warhead while guiding, the translocator disc while the disc-camera
 * button is held, and a spectator view when the local pawn does not exist.
 * `cameraPoseFor` turns a resolved target into a camera pose. Both are pure so
 * the client's camera logic is tested without a renderer.
 */
import type {
  OverlayKind,
  ViewTarget,
  ViewTargetResolver,
  ViewTargetSettings,
} from '../render/viewTarget';
import {
  NO_ENTITY,
  type EntityState,
  type PawnId,
  type PawnState,
  type Pose,
  type ProjectileState,
  type Quat,
  type Vec3,
  type WorldState,
} from '../sim/types';
import { anglesFromDirection } from '../sim/weapons/core/math';
import { eyePosition } from '../sim/weapons/core/geometry';

export const DEFAULT_VIEW_TARGET_SETTINGS: Readonly<ViewTargetSettings> = Object.freeze({
  discCamListener: 'body',
  allowPip: false,
});

/** Speed below which a disc in flight keeps its last look direction (m/s). */
export const VELOCITY_LOOK_MIN_SPEED = 0.5;

export function findEntity(
  state: Readonly<WorldState>,
  id: number,
): Readonly<EntityState> | undefined {
  if (id === NO_ENTITY) return undefined;
  for (const e of state.entities) if (e.id === id) return e;
  return undefined;
}

export function findPawn(state: Readonly<WorldState>, id: PawnId): Readonly<PawnState> | undefined {
  const e = findEntity(state, id);
  return e?.kind === 'pawn' ? e : undefined;
}

function findProjectile(
  state: Readonly<WorldState>,
  id: number,
): Readonly<ProjectileState> | undefined {
  const e = findEntity(state, id);
  return e?.kind === 'projectile' ? e : undefined;
}

function pawnTarget(pawn: Readonly<PawnState>): ViewTarget {
  const overlay: OverlayKind = pawn.zoom > 1 ? 'zoom' : 'none';
  return {
    kind: 'pawn',
    entityId: pawn.id,
    orientation: 'eye',
    overlay,
    showViewModel: pawn.alive,
    mouseLook: true,
    listener: 'body',
    bodyPip: false,
  };
}

export class DefaultViewTargetResolver implements ViewTargetResolver {
  resolve(
    state: Readonly<WorldState>,
    localPawn: PawnId,
    settings: Readonly<ViewTargetSettings>,
  ): ViewTarget {
    const pawn = findPawn(state, localPawn);
    if (!pawn) {
      return {
        kind: 'spectator',
        entityId: NO_ENTITY,
        orientation: 'freeLook',
        overlay: 'none',
        showViewModel: false,
        mouseLook: true,
        listener: 'target',
        bodyPip: false,
      };
    }
    if (pawn.alive && pawn.guiding !== NO_ENTITY) {
      const warhead = findProjectile(state, pawn.guiding);
      if (warhead) {
        return {
          kind: 'warhead',
          entityId: warhead.id,
          orientation: 'nose',
          overlay: 'redeemerCam',
          showViewModel: false,
          // The mouse steers the warhead through the pawn's aim, not the camera.
          mouseLook: false,
          listener: 'target',
          bodyPip: settings.allowPip,
        };
      }
    }
    if (pawn.alive && pawn.viewingDisc && pawn.disc !== NO_ENTITY) {
      const disc = findProjectile(state, pawn.disc);
      if (disc) {
        return {
          kind: 'disc',
          entityId: disc.id,
          orientation: disc.landed ? 'freeLook' : 'velocity',
          overlay: disc.disrupted ? 'static' : 'translocatorCam',
          showViewModel: false,
          mouseLook: disc.landed,
          listener: settings.discCamListener,
          bodyPip: settings.allowPip,
        };
      }
    }
    return pawnTarget(pawn);
  }
}

/** Forward direction (−Z rotated by `q`). */
export function quatForward(q: Readonly<Quat>): Vec3 {
  // Third column of the rotation matrix, negated.
  return {
    x: -2 * (q.x * q.z + q.w * q.y),
    y: -2 * (q.y * q.z - q.w * q.x),
    z: -(1 - 2 * (q.x * q.x + q.y * q.y)),
  };
}

/** Inputs for one frame's camera placement. */
export interface CameraInputs {
  target: Readonly<ViewTarget>;
  state: Readonly<WorldState>;
  /** Interpolated position of the target entity this frame, if it has a view. */
  position: Readonly<Vec3> | undefined;
  /** The local player's look angles (smooth, ahead of the last tick). */
  look: { yaw: number; pitch: number };
  /** Last pose, kept when the target has none (death cam, spectator). */
  previous: Readonly<Pose> | null;
}

/**
 * Camera pose for a view target. Pawn eyes use the player's look angles;
 * a disc in flight looks along its velocity, at rest it uses free look; the
 * warhead looks along its nose. A dead pawn keeps the last pose (death cam).
 */
export function cameraPoseFor(input: CameraInputs): Pose | null {
  const { target, state, position, look, previous } = input;
  const entity = findEntity(state, target.entityId);
  if (target.kind === 'pawn') {
    if (!entity || entity.kind !== 'pawn' || !entity.alive) return previous;
    const eye = eyePosition({ position: position ?? entity.position, crouching: entity.crouching });
    return { position: eye, yaw: look.yaw, pitch: look.pitch };
  }
  if (!entity) return previous;
  const at = { ...(position ?? entity.position) };
  if (target.orientation === 'nose' && entity.kind === 'projectile') {
    return { position: at, ...anglesFromDirection(quatForward(entity.orientation)) };
  }
  if (target.orientation === 'velocity' && entity.kind === 'projectile') {
    const v = entity.velocity;
    if (Math.hypot(v.x, v.y, v.z) >= VELOCITY_LOOK_MIN_SPEED) {
      return { position: at, ...anglesFromDirection(v) };
    }
    return { position: at, yaw: previous?.yaw ?? look.yaw, pitch: previous?.pitch ?? look.pitch };
  }
  return { position: at, yaw: look.yaw, pitch: look.pitch };
}
