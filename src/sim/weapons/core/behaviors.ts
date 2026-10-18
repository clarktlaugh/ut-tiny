/**
 * The generic fire behaviors, one per `FireBehavior` (docs/DESIGN.md §8.1):
 * "adding a weapon is adding a row and, at most, one behavior function".
 *
 * - `hitscan`: instant ray (see `hitscan.ts`).
 * - `projectile`: straight projectile at `projectileSpeed`.
 * - `lob`: arcing, bouncing projectile with an optional `fuse`.
 * - `action` / `none`: nothing here; an `action` mode needs a module's `fire` hook.
 */
import type { FireBehavior } from '../../types';
import { fireHitscan } from './hitscan';
import { projectileTypeFor, type FireBehaviorFn, type FireContext } from './host';
import { add, scale } from './math';

/** Projectiles start this far along the aim from the eye, m. */
export const MUZZLE_OFFSET = 0.3;

export function fireProjectile(ctx: FireContext): void {
  spawnFromContext(ctx, 'straight');
}

export function fireLob(ctx: FireContext): void {
  spawnFromContext(ctx, 'lob');
}

function spawnFromContext(ctx: FireContext, motion: 'straight' | 'lob'): void {
  const speed = ctx.def.projectileSpeed ?? 0;
  ctx.services.spawnProjectile(
    {
      owner: ctx.shooter.id,
      weapon: ctx.weapon,
      mode: ctx.mode,
      def: ctx.def,
      projectileType: projectileTypeFor(ctx.weapon, ctx.def),
      motion,
      position: add(ctx.origin, scale(ctx.aim, MUZZLE_OFFSET)),
      velocity: scale(ctx.direction, speed),
    },
    ctx.tick,
    ctx.events,
  );
}

export const BEHAVIORS: Readonly<Record<FireBehavior, FireBehaviorFn | null>> = Object.freeze({
  hitscan: (ctx) => {
    fireHitscan(ctx);
  },
  projectile: fireProjectile,
  lob: fireLob,
  action: null,
  none: null,
});
