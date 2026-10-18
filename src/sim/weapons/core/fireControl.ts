/**
 * Fire control helpers (docs/DESIGN.md §5): rate of fire, loading, spread.
 *
 * Rate: a shot sets `nextFireTick = tick + rate × 60`; both modes share the
 * cooldown. Loading (`loadMax`): the first press loads one projectile at
 * once, holding loads another every `loadTime`, releasing fires them all as a
 * salvo (ammo is spent as each loads). Spread: `def.spread` is the half-angle
 * of the cone at full heat; heat rises `HEAT_PER_SHOT` per shot and cools
 * `HEAT_COOL_PER_SECOND` while the weapon is not firing, so the first shot
 * after a pause is exact and sustained fire opens up (§5 assault rifle).
 */
import type { Rng } from '../../rng';
import { TICK_DT, TICK_RATE, type FireModeDef, type Vec3 } from '../../types';
import type { PawnWeaponState, SalvoContext } from './host';
import { copy, deflect } from './math';

/** Heat added per shot; four shots reach full spread. */
export const HEAT_PER_SHOT = 0.34;
/** Heat lost per second while not firing. */
export const HEAT_COOL_PER_SECOND = 1.5;

export function createPawnWeaponState(): PawnWeaponState {
  return {
    nextFireTick: 0,
    loading: null,
    heat: 0,
    primaryWasDown: false,
    altWasDown: false,
    heldWeapon: null,
    custom: {},
  };
}

/** Ticks between shots for a mode, at least 1. */
export function rateTicks(def: Readonly<FireModeDef>): number {
  return Math.max(1, Math.round(def.rate * TICK_RATE));
}

/** Ticks per additional loaded projectile, at least 1. */
export function loadTicks(def: Readonly<FireModeDef>): number {
  return Math.max(1, Math.round((def.loadTime ?? def.rate) * TICK_RATE));
}

/** Projectiles one press can load: `loadMax`, or 1 for ordinary modes. */
export function loadMaxOf(def: Readonly<FireModeDef>): number {
  return Math.max(1, Math.floor(def.loadMax ?? 1));
}

/** Cool the heat by one tick's worth. */
export function coolHeat(state: PawnWeaponState): void {
  state.heat = Math.max(0, state.heat - HEAT_COOL_PER_SECOND * TICK_DT);
}

/** Heat the weapon by one shot. */
export function heatUp(state: PawnWeaponState): void {
  state.heat = Math.min(1, state.heat + HEAT_PER_SHOT);
}

/** Effective cone half-angle for a mode at the pawn's current heat. */
export function effectiveSpread(def: Readonly<FireModeDef>, heat: number): number {
  return (def.spread ?? 0) * Math.max(0, Math.min(1, heat));
}

/**
 * A random direction in a cone of `halfAngle` around unit `aim`, uniform over
 * the cone's solid angle. Consumes two RNG values; none when the angle is 0.
 */
export function spreadDirection(aim: Readonly<Vec3>, halfAngle: number, rng: Rng): Vec3 {
  if (!(halfAngle > 0)) return copy(aim);
  const angle = halfAngle * Math.sqrt(rng.nextFloat());
  const theta = rng.nextFloat() * 2 * Math.PI;
  return deflect(aim, angle, theta);
}

/**
 * Default salvo pattern: a horizontal fan centered on the aim with
 * `def.spread` radians between neighbours (rocket launcher primary, §5).
 */
export function fanSalvoDirection(ctx: SalvoContext): Vec3 {
  const step = ctx.def.spread ?? 0;
  const offset = (ctx.index - (ctx.count - 1) / 2) * step;
  return deflect(ctx.aim, Math.abs(offset), offset >= 0 ? 0 : Math.PI);
}
