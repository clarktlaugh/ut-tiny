/**
 * Splash damage (docs/DESIGN.md §5 common rules).
 *
 * Every living pawn whose capsule is within `radius` of the center and in line
 * of sight of it (map geometry only; pawns do not shield each other) takes
 * `damage × (1 − d / radius)`, where `d` is the distance from the center to
 * the capsule surface, with a knockback impulse of `momentum × (1 − d / radius)`
 * directed from the center through the pawn's capsule center. Damage goes
 * through the host's damage pipeline, which halves the instigator's own
 * splash and keeps its full momentum (rocket jumps, §5).
 */
import type { DamageResult } from '../../damage';
import { HitMask } from '../../physics/physicsWorld';
import type { DamageType, PawnId, SimEvent, Tick, Vec3, WeaponId } from '../../types';
import { distanceToPawn } from './geometry';
import type { WeaponHost } from './host';
import { UP, length, normalize, scale, sub } from './math';

export interface SplashOptions {
  center: Readonly<Vec3>;
  radius: number;
  /** Damage at the center. */
  damage: number;
  /** Knockback impulse at the center. */
  momentum: number;
  instigator: PawnId;
  weapon: WeaponId | null;
  damageType: DamageType;
  /** A pawn already hit directly, left out of the splash. */
  exclude?: PawnId;
}

export interface SplashHit {
  pawn: PawnId;
  /** Distance from the center to the pawn's capsule surface. */
  distance: number;
  /** 1 at the center, 0 at the edge. */
  falloff: number;
  result: DamageResult;
}

/** Surface tolerance for the line-of-sight ray. */
const LOS_SLACK = 0.05;

/** Linear falloff factor at `distance` from a splash of `radius`. */
export function splashFalloff(distance: number, radius: number): number {
  if (!(radius > 0)) return 0;
  return Math.max(0, Math.min(1, 1 - distance / radius));
}

/** True when nothing in the map blocks the line from `from` to `to`. */
export function hasLineOfSight(
  host: WeaponHost,
  from: Readonly<Vec3>,
  to: Readonly<Vec3>,
): boolean {
  const delta = sub(to, from);
  const dist = length(delta);
  if (dist <= LOS_SLACK) return true;
  const hit = host.physics.raycast(from, delta, dist, { mask: HitMask.World });
  return hit === null || hit.distance >= dist - LOS_SLACK;
}

/**
 * Apply a splash at `opts.center`. Emits an `explosion` event followed by the
 * damage pipeline's events for each pawn hit, in ascending pawn id order.
 */
export function applySplash(
  host: WeaponHost,
  tick: Tick,
  opts: SplashOptions,
  events: SimEvent[],
): SplashHit[] {
  events.push({
    type: 'explosion',
    tick,
    position: { ...opts.center },
    radius: opts.radius,
    damageType: opts.damageType,
    instigator: opts.instigator,
  });
  const hits: SplashHit[] = [];
  if (!(opts.radius > 0)) return hits;

  const pawns = [...host.pawns()].sort((a, b) => a.id - b.id);
  for (const pawn of pawns) {
    if (!pawn.alive || pawn.id === opts.exclude) continue;
    const distance = distanceToPawn(opts.center, pawn);
    if (distance >= opts.radius) continue;
    if (!hasLineOfSight(host, opts.center, pawn.position)) continue;

    const falloff = splashFalloff(distance, opts.radius);
    const direction = normalize(sub(pawn.position, opts.center), UP);
    const result = host.damage(
      pawn.id,
      {
        amount: opts.damage * falloff,
        damageType: opts.damageType,
        instigator: opts.instigator,
        weapon: opts.weapon,
        momentum: scale(direction, opts.momentum * falloff),
        splash: true,
      },
      tick,
    );
    if (!result) continue;
    events.push(...result.events);
    hits.push({ pawn: pawn.id, distance, falloff, result });
  }
  return hits;
}
