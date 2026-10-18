/**
 * Types shared by the weapon framework (docs/DESIGN.md §5, §8.1).
 *
 * - `WeaponHost`: what the framework needs from the world (physics, RNG, the
 *   weapon table, pawn lookup, the damage pipeline, entity ids).
 * - `WeaponModule`: the per-weapon hooks P14+ implement. See README.md in
 *   this directory for the pattern.
 * - The context objects handed to behaviors and hooks.
 *
 * Nothing here touches the DOM, Three.js or wall-clock time.
 */
import type { DamageInfo, DamageResult } from '../../damage';
import type { InventoryState, WeaponTable } from '../../inventory';
import type { PhysicsWorld, ShapeHit } from '../../physics/physicsWorld';
import type { Rng } from '../../rng';
import type {
  DamageType,
  EntityId,
  FireModeDef,
  InputCommand,
  PawnId,
  PawnState,
  ProjectileState,
  ProjectileType,
  RulesConfig,
  SimEvent,
  Tick,
  Vec3,
  WeaponId,
} from '../../types';

export type FireMode = 'primary' | 'alt';

/** Services the world provides to the weapon framework. */
export interface WeaponHost {
  readonly physics: PhysicsWorld;
  readonly rng: Rng;
  readonly weapons: WeaponTable;
  readonly rules: Readonly<RulesConfig>;
  /** Allocate a fresh entity id for a projectile. */
  allocateEntityId(): EntityId;
  /** A pawn's snapshot state, or undefined. */
  pawn(id: PawnId): PawnState | undefined;
  /** Every pawn, in a stable order (ascending id). */
  pawns(): Iterable<PawnState>;
  /**
   * Route a hit through the damage pipeline (`damagePawn` in `src/sim/pawn.ts`)
   * and apply its knockback to the target's mover. Returns the result, or
   * undefined when `target` is not a pawn. The framework emits `result.events`.
   */
  damage(target: PawnId, info: DamageInfo, tick: Tick): DamageResult | undefined;
}

/** Why a projectile left the world. */
export type RemoveReason = 'detonated' | 'destroyed' | 'expired' | 'ownerRemoved';

export type ProjectileMotion =
  /** Constant velocity, no gravity (rockets, the Redeemer). */
  | 'straight'
  /** Gravity, bounces, comes to rest (grenades, mines, the disc). */
  | 'lob';

/** What `WeaponServices.spawnProjectile` needs. */
export interface ProjectileSpawn {
  owner: PawnId;
  weapon: WeaponId;
  mode: FireMode;
  def: Readonly<FireModeDef>;
  projectileType: ProjectileType;
  motion: ProjectileMotion;
  position: Readonly<Vec3>;
  velocity: Readonly<Vec3>;
  /** Steered by the owner's yaw/pitch input until impact (§5.1). */
  guided?: boolean;
  /** Hit points if it can be shot down; defaults to `def.projectileHealth` or 0. */
  health?: number;
  /** Ticks until detonation; defaults to `def.fuse` (0 = no fuse). */
  fuseTicks?: number;
  /** Collision sphere radius; defaults to `PROJECTILE_RADIUS`. */
  radius?: number;
  /** Radius hitscan shots test against for shootable projectiles; defaults to `radius`. */
  hitRadius?: number;
  /** Bounce restitution for lobs; defaults to `LOB_RESTITUTION`. */
  restitution?: number;
  /** Detonate in place when the owner dies (guided warhead, §5.1). Defaults to `guided`. */
  detonateOnOwnerDeath?: boolean;
}

/** A live projectile: the snapshot state plus sim-private bookkeeping. */
export interface ProjectileRecord {
  state: ProjectileState;
  weapon: WeaponId;
  mode: FireMode;
  def: Readonly<FireModeDef>;
  motion: ProjectileMotion;
  radius: number;
  hitRadius: number;
  restitution: number;
  spawnTick: Tick;
  /** The owner's capsule is ignored by the sweep until this tick. */
  ownerSafeUntil: Tick;
  bounces: number;
  detonateOnOwnerDeath: boolean;
  /** Scratch space for weapon modules. */
  custom: Record<string, number>;
}

/** A salvo being loaded by holding fire (`FireModeDef.loadMax`). */
export interface LoadingState {
  mode: FireMode;
  /** Projectiles loaded so far (ammo already spent). */
  count: number;
  /** Tick at which the next one loads. */
  nextLoadTick: Tick;
}

/** Sim-private fire-control state for one pawn (not part of the snapshot). */
export interface PawnWeaponState {
  /** First tick the held weapon may fire again; shared by both modes. */
  nextFireTick: Tick;
  loading: LoadingState | null;
  /** Spread heat 0..1: grows per shot, cools while not firing. */
  heat: number;
  primaryWasDown: boolean;
  altWasDown: boolean;
  /** Weapon the state was last reset for; a change resets heat, loading and `custom`. */
  heldWeapon: WeaponId | null;
  /** Scratch space for weapon modules (zoom level, load-mode toggle, ...). */
  custom: Record<string, number>;
}

/** Projectile services the framework exposes to behaviors and modules. */
export interface WeaponServices {
  spawnProjectile(spawn: ProjectileSpawn, tick: Tick, events: SimEvent[]): ProjectileRecord;
  projectile(id: EntityId): ProjectileRecord | undefined;
  projectiles(): Iterable<ProjectileRecord>;
  projectilesOf(owner: PawnId): ProjectileRecord[];
  /** Detonate a projectile where it is (splash and all). No-op for unknown ids. */
  detonate(id: EntityId, tick: Tick, events: SimEvent[]): void;
  /** Remove a projectile without detonating it. No-op for unknown ids. */
  destroy(id: EntityId, tick: Tick, events: SimEvent[]): void;
  /**
   * Hurt a shootable projectile (`health > 0`) or disrupt an enemy's disc.
   * Returns true when the projectile was destroyed.
   */
  damageProjectile(
    id: EntityId,
    amount: number,
    byPawn: PawnId,
    tick: Tick,
    events: SimEvent[],
  ): boolean;
}

/** One shot of one fire mode. */
export interface FireContext {
  host: WeaponHost;
  services: WeaponServices;
  tick: Tick;
  shooter: PawnState;
  state: PawnWeaponState;
  weapon: WeaponId;
  mode: FireMode;
  def: Readonly<FireModeDef>;
  /** Eye position the shot starts from. */
  origin: Vec3;
  /** Unit view direction before spread. */
  aim: Vec3;
  /** Unit shot direction after spread or salvo pattern. */
  direction: Vec3;
  /** Position within a loaded salvo; `{ index: 0, count: 1 }` for a single shot. */
  salvo: { index: number; count: number };
  /** Append events here, in the order they should be reported. */
  events: SimEvent[];
}

export type FireBehaviorFn = (ctx: FireContext) => void;

/** Direction request for one projectile of a loaded salvo. */
export interface SalvoContext {
  host: WeaponHost;
  shooter: Readonly<PawnState>;
  def: Readonly<FireModeDef>;
  mode: FireMode;
  aim: Readonly<Vec3>;
  index: number;
  count: number;
}

export type ImpactAction =
  /** Direct damage to a hit pawn, then splash, then removal. */
  | 'detonate'
  /** Reflect off the surface (lobs); comes to rest when slow on a floor. */
  | 'bounce'
  /** Remove silently (no explosion). */
  | 'destroy';

export interface ImpactContext {
  host: WeaponHost;
  services: WeaponServices;
  tick: Tick;
  projectile: ProjectileRecord;
  hit: ShapeHit;
  /** The living pawn hit, if the sweep stopped on a pawn capsule. */
  hitPawn: PawnState | undefined;
  events: SimEvent[];
}

/** Per-tick hook while a living pawn holds the weapon; runs before fire control. */
export interface HoldContext {
  host: WeaponHost;
  services: WeaponServices;
  tick: Tick;
  pawn: PawnState;
  inventory: InventoryState;
  state: PawnWeaponState;
  weapon: WeaponId;
  input: Readonly<InputCommand>;
  /** Fire buttons that went down this tick. */
  pressed: { primary: boolean; alt: boolean };
  events: SimEvent[];
}

/**
 * Per-weapon hooks. Everything is optional: a weapon whose rows in
 * `src/data/weapons.ts` describe it fully needs no module at all.
 */
export interface WeaponModule {
  id: WeaponId;
  /** Replace the generic behavior of a fire mode (required for `action` modes). */
  fire?: Partial<Record<FireMode, FireBehaviorFn>>;
  /** Direction of each projectile in a loaded salvo. Default: horizontal fan of `def.spread`. */
  salvoDirection?: (ctx: SalvoContext) => Vec3;
  /** What a projectile fired by this weapon does on contact. Default: see `defaultImpact`. */
  onImpact?: (ctx: ImpactContext) => ImpactAction;
  /** Runs every tick the pawn holds this weapon (zoom, detonate mines, mode toggles). */
  update?: (ctx: HoldContext) => void;
  /** A projectile fired by this weapon left the world. */
  onProjectileRemoved?: (
    projectile: ProjectileRecord,
    reason: RemoveReason,
    ctx: { host: WeaponHost; tick: Tick; events: SimEvent[] },
  ) => void;
}

/** Damage type a weapon deals (§5). Both modes of a weapon share one. */
export function damageTypeFor(weapon: WeaponId, mode: FireMode = 'primary'): DamageType {
  switch (weapon) {
    case 'teleporter':
      return 'telefrag';
    case 'assault':
      return mode === 'alt' ? 'grenade' : 'bullet';
    case 'mines':
      return 'mine';
    case 'rocket':
      return 'rocket';
    case 'sniper':
      return 'sniper';
    case 'shock':
    case 'shockScoped':
      return 'shock';
    case 'redeemer':
      return 'redeemer';
  }
}

/** Projectile type the generic behaviors spawn for a weapon. */
export function projectileTypeFor(weapon: WeaponId, def: Readonly<FireModeDef>): ProjectileType {
  if (weapon === 'teleporter') return 'disc';
  if (weapon === 'redeemer') return 'redeemer';
  return def.behavior === 'lob' ? 'grenade' : 'rocket';
}
