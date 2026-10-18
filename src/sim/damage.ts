/**
 * Damage pipeline (docs/DESIGN.md §5 common rules, §6, §8.1).
 *
 * `applyDamage(target, info, ctx)` is the one entry point every damage source
 * goes through: weapons, splash, fall damage, damage and kill volumes,
 * telefrags and suicides. Order of operations:
 *
 *   dead or spawn-protected target → ignored
 *   → UDamage on the instigator doubles it
 *   → own splash damage is scaled by `PAWN_STATS.selfDamageScale` (50 %)
 *   → rounded to whole hit points
 *   → shield absorbs first, the rest comes off health
 *   → `damage` event, then a `death` event when health reaches 0.
 *
 * Knockback: every hit carries a momentum vector. The pipeline turns it into
 * a velocity change (`DamageResult.velocityChange`, momentum / `PAWN_MASS`);
 * the world adds it to the pawn's `MoverState` through `CharacterMover.launch`
 * so the movement code stays the only writer of velocity. Self-inflicted
 * splash keeps its full momentum, which is what makes rocket jumps work.
 *
 * Pure with respect to its inputs: no RNG, no wall-clock, no physics.
 */
import {
  NO_ENTITY,
  PAWN_STATS,
  TICK_RATE,
  type DamageType,
  type PawnId,
  type PawnState,
  type RulesConfig,
  type SimEvent,
  type Tick,
  type Vec3,
  type WeaponId,
} from './types';

/** Damage types that come from an explosion; own hits of these are scaled down (§5). */
export const SPLASH_DAMAGE_TYPES: ReadonlySet<DamageType> = new Set<DamageType>([
  'grenade',
  'mine',
  'rocket',
  'redeemer',
]);

/**
 * Damage types that kill outright regardless of health, shield and spawn
 * protection: falling into a kill volume, being telefragged, suiciding.
 */
export const LETHAL_DAMAGE_TYPES: ReadonlySet<DamageType> = new Set<DamageType>([
  'telefrag',
  'killVolume',
  'suicide',
]);

/** Pawn mass for knockback: velocity change = momentum / mass. */
export const PAWN_MASS = 1;

/** UDamage multiplier (§6). */
export const UDAMAGE_SCALE = 2;

/** What hit the pawn. */
export interface DamageInfo {
  /** Raw damage before UDamage, self-damage scaling and shield. */
  amount: number;
  damageType: DamageType;
  /** Pawn responsible, or `NO_ENTITY` for environmental damage (falls, volumes). */
  instigator: PawnId;
  /** Weapon responsible, for the kill feed; null for environmental damage. */
  weapon: WeaponId | null;
  /** Knockback impulse; defaults to none. */
  momentum?: Readonly<Vec3>;
  /** Whether this is splash damage. Defaults to `SPLASH_DAMAGE_TYPES.has(damageType)`. */
  splash?: boolean;
  /** Death-message key (kill volumes), copied onto the death event. */
  message?: string;
}

export interface DamageContext {
  tick: Tick;
  /** Supplies `respawnDelay` for the dead pawn's `respawnAt`. */
  rules: Readonly<Pick<RulesConfig, 'respawnDelay'>>;
  /** The instigating pawn, if it is a pawn; used for UDamage. */
  instigatorPawn?: Readonly<PawnState>;
}

export interface DamageResult {
  /** False when the hit was ignored (dead target, spawn protection, zero damage). */
  applied: boolean;
  /** Hit points dealt after scaling and rounding (shield + health). */
  amount: number;
  shieldAbsorbed: number;
  healthLost: number;
  killed: boolean;
  /** Add this to the target's velocity (zero vector when ignored). */
  velocityChange: Vec3;
  /** `damage` and, if the hit killed, `death`, in that order. */
  events: SimEvent[];
}

const ZERO: Readonly<Vec3> = Object.freeze({ x: 0, y: 0, z: 0 });

function ignored(): DamageResult {
  return {
    applied: false,
    amount: 0,
    shieldAbsorbed: 0,
    healthLost: 0,
    killed: false,
    velocityChange: { ...ZERO },
    events: [],
  };
}

/** True while spawn protection blocks damage of this type on `pawn` at `tick`. */
export function isSpawnProtected(
  pawn: Readonly<PawnState>,
  tick: Tick,
  damageType: DamageType,
): boolean {
  return tick < pawn.spawnProtectedUntil && !LETHAL_DAMAGE_TYPES.has(damageType);
}

/**
 * Damage after UDamage and self-splash scaling, rounded to whole points.
 * Any positive hit deals at least 1.
 */
export function scaledDamage(
  target: Readonly<PawnState>,
  info: Readonly<DamageInfo>,
  ctx: Readonly<DamageContext>,
): number {
  if (!(info.amount > 0)) return 0;
  let amount = info.amount;
  const inst = ctx.instigatorPawn;
  if (inst && inst.id === info.instigator && ctx.tick < inst.udamageUntil) amount *= UDAMAGE_SCALE;
  const splash = info.splash ?? SPLASH_DAMAGE_TYPES.has(info.damageType);
  if (splash && info.instigator === target.id) amount *= PAWN_STATS.selfDamageScale;
  return Math.max(1, Math.round(amount));
}

/** Respawn-eligible tick for a pawn that dies at `tick`. */
export function respawnTickAfterDeath(
  tick: Tick,
  rules: Readonly<Pick<RulesConfig, 'respawnDelay'>>,
): Tick {
  return tick + Math.max(0, Math.round(rules.respawnDelay * TICK_RATE));
}

/**
 * Apply one hit to `target`, mutating its health, shield and (on death) its
 * life state. Returns what happened and the events to emit.
 */
export function applyDamage(
  target: PawnState,
  info: Readonly<DamageInfo>,
  ctx: Readonly<DamageContext>,
): DamageResult {
  if (!target.alive) return ignored();
  if (isSpawnProtected(target, ctx.tick, info.damageType)) return ignored();

  const lethal = LETHAL_DAMAGE_TYPES.has(info.damageType);
  const amount = lethal
    ? Math.max(1, Math.ceil(target.health + target.shield))
    : scaledDamage(target, info, ctx);
  if (amount <= 0) return ignored();

  // Shield absorbs first (§8.1); lethal types go straight through it.
  const shieldAbsorbed = lethal ? 0 : Math.min(target.shield, amount);
  target.shield -= shieldAbsorbed;
  const healthLost = lethal ? target.health : Math.min(target.health, amount - shieldAbsorbed);
  target.health -= healthLost;

  const m = info.momentum ?? ZERO;
  const momentum = { x: m.x, y: m.y, z: m.z };
  const velocityChange = {
    x: momentum.x / PAWN_MASS,
    y: momentum.y / PAWN_MASS,
    z: momentum.z / PAWN_MASS,
  };

  const events: SimEvent[] = [
    {
      type: 'damage',
      tick: ctx.tick,
      target: target.id,
      instigator: info.instigator,
      amount,
      damageType: info.damageType,
      momentum,
    },
  ];

  const killed = target.health <= 0;
  if (killed) {
    killPawn(target, ctx.tick, ctx.rules);
    const death: SimEvent = {
      type: 'death',
      tick: ctx.tick,
      victim: target.id,
      killer: info.instigator,
      damageType: info.damageType,
      weapon: info.weapon,
    };
    if (info.message !== undefined) death.message = info.message;
    events.push(death);
  }

  return { applied: true, amount, shieldAbsorbed, healthLost, killed, velocityChange, events };
}

/**
 * Put a pawn into the dead state. Clears per-life state the pawn owns
 * directly (zoom, disc view, pending switch); the weapon framework reacts to
 * the `death` event for entities it owns (recall the disc, detonate a guided
 * warhead, §5.1) and clears `disc` / `guiding` itself.
 */
export function killPawn(
  pawn: PawnState,
  tick: Tick,
  rules: Readonly<Pick<RulesConfig, 'respawnDelay'>>,
): void {
  pawn.alive = false;
  pawn.health = 0;
  pawn.shield = 0;
  pawn.velocity = { x: 0, y: 0, z: 0 };
  pawn.pendingWeapon = null;
  pawn.viewingDisc = false;
  pawn.zoom = 1;
  pawn.udamageUntil = 0;
  pawn.spawnProtectedUntil = 0;
  pawn.respawnAt = respawnTickAfterDeath(tick, rules);
}

/** Landing damage from `MoveResult.fallDamage` (§4); environmental, no knockback. */
export function fallDamageInfo(amount: number): DamageInfo {
  return { amount, damageType: 'fall', instigator: NO_ENTITY, weapon: null };
}

/** A pawn killing itself on purpose (console `suicide`, §6: −1 frag). */
export function suicideInfo(pawn: PawnId): DamageInfo {
  return { amount: 0, damageType: 'suicide', instigator: pawn, weapon: null };
}

/** Falling into a kill volume (§8.5); `message` is the volume's death message. */
export function killVolumeInfo(message?: string): DamageInfo {
  const info: DamageInfo = {
    amount: 0,
    damageType: 'killVolume',
    instigator: NO_ENTITY,
    weapon: null,
  };
  if (message !== undefined) info.message = message;
  return info;
}
