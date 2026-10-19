/**
 * `BotSenses` over a `SimWorld` (or anything with its `physics` and
 * `pickups`): line of sight is a world-geometry raycast, take rules come from
 * the pickup system. Bots run on the host, so reading the live world is fine.
 */
import { HitMask, type PhysicsWorld } from '../../sim/physics';
import type { PickupSystem } from '../../sim/pickups';
import type { BotSenses } from './types';

export interface SensesSource {
  physics: Pick<PhysicsWorld, 'raycast'>;
  pickups: Pick<PickupSystem, 'canTake'>;
}

export function worldSenses(world: SensesSource): BotSenses {
  return {
    canSee: (from, to) => {
      const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
      const dist = Math.hypot(d.x, d.y, d.z);
      if (!(dist > 0)) return true;
      return world.physics.raycast(from, d, dist, { mask: HitMask.World }) === null;
    },
    canTake: (pawn, pickup) => world.pickups.canTake(pawn, pickup),
  };
}
