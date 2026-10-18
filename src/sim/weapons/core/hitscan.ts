/**
 * Hitscan fire behavior (docs/DESIGN.md §5): an instant ray from the eye,
 * damage at the first thing hit.
 *
 * The ray is cast against map geometry and pawn capsules (the shooter's
 * excluded) up to `HITSCAN_RANGE`. Shootable projectiles (Redeemer warhead)
 * and translocator discs are not physics colliders, so they are tested as
 * spheres against the same ray and the nearest hit wins. A hit above the
 * pawn's head line is a headshot for modes with `headshotMultiplier`.
 *
 * Emits a `hitscan` event (for beams and tracers) and then the damage
 * pipeline's events.
 */
import { NO_ENTITY, type EntityId, type PawnId, type Vec3 } from '../../types';
import { headshotHeight } from './geometry';
import { damageTypeFor, type FireContext, type ProjectileRecord } from './host';
import { add, raySphere, scale } from './math';

/** Maximum trace length, m. */
export const HITSCAN_RANGE = 500;

export interface HitscanResult {
  from: Vec3;
  to: Vec3;
  hitPawn: PawnId;
  headshot: boolean;
  /** Projectile the shot hit instead of a pawn or the map, else `NO_ENTITY`. */
  hitProjectile: EntityId;
}

/** Whether a hitscan shot can stop on this projectile. */
export function isShootable(rec: Readonly<ProjectileRecord>): boolean {
  return rec.hitRadius > 0 && (rec.state.health > 0 || rec.state.projectileType === 'disc');
}

export function fireHitscan(ctx: FireContext): HitscanResult {
  const { host, origin, direction, shooter, def } = ctx;
  const ray = host.physics.raycast(origin, direction, HITSCAN_RANGE, { ignoreActor: shooter.id });
  let maxDistance = ray?.distance ?? HITSCAN_RANGE;

  let projectile: ProjectileRecord | null = null;
  for (const rec of ctx.services.projectiles()) {
    if (!isShootable(rec)) continue;
    const t = raySphere(origin, direction, rec.state.position, rec.hitRadius);
    if (t !== null && t < maxDistance) {
      maxDistance = t;
      projectile = rec;
    }
  }

  const to = add(origin, scale(direction, maxDistance));
  const result: HitscanResult = {
    from: { ...origin },
    to,
    hitPawn: NO_ENTITY,
    headshot: false,
    hitProjectile: projectile?.state.id ?? NO_ENTITY,
  };

  let target: ReturnType<typeof host.pawn> | undefined;
  if (!projectile && ray?.collider.kind === 'actor') {
    const pawn = host.pawn(ray.collider.entity);
    if (pawn?.alive) {
      target = pawn;
      result.hitPawn = pawn.id;
      result.headshot = def.headshotMultiplier !== undefined && ray.point.y > headshotHeight(pawn);
    }
  }

  ctx.events.push({
    type: 'hitscan',
    tick: ctx.tick,
    pawn: shooter.id,
    weapon: ctx.weapon,
    from: result.from,
    to: { ...to },
    hitPawn: result.hitPawn,
    headshot: result.headshot,
  });

  if (projectile) {
    ctx.services.damageProjectile(
      projectile.state.id,
      def.damage,
      shooter.id,
      ctx.tick,
      ctx.events,
    );
  } else if (target) {
    const multiplier = result.headshot ? (def.headshotMultiplier ?? 1) : 1;
    const hit = host.damage(
      target.id,
      {
        amount: def.damage * multiplier,
        damageType: damageTypeFor(ctx.weapon, ctx.mode),
        instigator: shooter.id,
        weapon: ctx.weapon,
        momentum: scale(direction, def.momentum ?? 0),
        splash: false,
      },
      ctx.tick,
    );
    if (hit) ctx.events.push(...hit.events);
  }
  return result;
}
