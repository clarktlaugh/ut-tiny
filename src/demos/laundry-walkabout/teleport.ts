/**
 * Teleporting pawns in a running `SimWorld` (P31).
 *
 * The world keeps each pawn's `MoverState` private, but its `CharacterMover`
 * is public and `mover.step()` is handed that state every tick. A pending
 * teleport is applied there, through the mover's own `teleport()`, right
 * before the pawn moves, so the physics capsule, velocity and ground state
 * are reset by the movement code itself and nothing in the sim is bypassed.
 *
 * A request for a dead pawn waits for its next alive tick: the world respawns
 * (step 2) before it moves pawns (step 3), so tapping a destination while dead
 * respawns straight there.
 */
import { feetOffset, pawnCapsule, type CharacterMover } from '../../sim/movement';
import type { PawnId, Pose, Vec3 } from '../../sim/types';

/** Feet are placed this far above the surface so the first tick lands cleanly. */
export const TELEPORT_LIFT = 0.02;

export interface Teleporter {
  /** On `pawn`'s next alive tick, stand it with its feet at `pose.position`, looking along `pose`. */
  request(pawn: PawnId, pose: Readonly<Pose>): void;
  /** The request waiting for `pawn`, if any. */
  pending(pawn: PawnId): Readonly<Pose> | undefined;
  /** Forget every request. */
  clear(): void;
  /** Restore the mover's own `step`. Pending requests are dropped. */
  dispose(): void;
}

/** Capsule center for feet at `feet` with the mover's current capsule for `crouching`. */
export function centerForFeet(
  feet: Readonly<Vec3>,
  crouching: boolean,
  mover: Pick<CharacterMover, 'config'>,
): Vec3 {
  return {
    x: feet.x,
    y: feet.y + feetOffset(pawnCapsule(crouching, mover.config)) + TELEPORT_LIFT,
    z: feet.z,
  };
}

/** Wrap `mover.step` so pending requests are applied before a pawn moves. */
export function installTeleporter(mover: CharacterMover): Teleporter {
  const pending = new Map<PawnId, Pose>();
  const before = mover.step;
  const original = before.bind(mover);
  mover.step = (pawn, state, input, tick) => {
    const pose = pending.get(pawn);
    if (!pose) return original(pawn, state, input, tick);
    pending.delete(pawn);
    mover.teleport(pawn, state, centerForFeet(pose.position, state.crouching, mover), pose.yaw);
    state.pitch = pose.pitch;
    // This tick's command still carries the view from before the teleport.
    return original(pawn, state, { ...input, yaw: pose.yaw, pitch: pose.pitch }, tick);
  };
  return {
    request(pawn, pose) {
      pending.set(pawn, {
        position: { ...pose.position },
        yaw: pose.yaw,
        pitch: pose.pitch,
      });
    },
    pending: (pawn) => pending.get(pawn),
    clear: () => pending.clear(),
    dispose() {
      pending.clear();
      mover.step = before;
    },
  };
}
