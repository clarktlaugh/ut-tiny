/**
 * Pawn lifecycle (docs/DESIGN.md §6, §8.1): creation, respawn, per-tick life
 * rules, and syncing the snapshot state from the movement state.
 *
 * A `PawnRecord` is what the world keeps per pawn: the public `PawnState`
 * (snapshotted, read by renderer/HUD/bots) plus small sim-private bookkeeping
 * that the contract does not expose (switch timer, fire-press detection).
 *
 * Life cycle:
 *   createPawnRecord → dead, may respawn at once
 *   wantsRespawn     → after `RulesConfig.respawnDelay`, a Fire press respawns;
 *                      after `AUTO_RESPAWN_SECONDS` it happens regardless (§6)
 *   respawnPawn      → full health, no shield, spawn loadout, spawn protection
 *   tickPawn         → overheal decay, spawn protection ends on firing,
 *                      weapon switching
 *   damage.ts        → killPawn on death; `respawnAt` set from the rules
 *
 * The world picks the spawn pose (spawn selection is a rules concern, P23)
 * and teleports the pawn's `MoverState` to it.
 */
import { applyDamage, type DamageContext, type DamageInfo, type DamageResult } from './damage';
import {
  DEFAULT_LOADOUT,
  createInventoryState,
  resetInventory,
  tickInventory,
  type InventoryState,
  type WeaponTable,
} from './inventory';
import type { MoverState } from './movement/mover';
import {
  Buttons,
  PAWN_STATS,
  TICK_RATE,
  type EntityId,
  type InputCommand,
  type PawnState,
  type PlayerId,
  type Pose,
  type RulesConfig,
  type SimEvent,
  type Tick,
  type WeaponId,
  NO_ENTITY,
} from './types';

/** A dead pawn respawns on its own this long after dying, Fire or not (§6). */
export const AUTO_RESPAWN_SECONDS = 2;

/** Health above this decays (§6). */
export const BASE_HEALTH = PAWN_STATS.health;

export interface PawnRecord {
  state: PawnState;
  inventory: InventoryState;
  /** Fire bit from the previous tick, for press detection while dead. */
  fireWasDown: boolean;
  /** Tick of the most recent death, for the auto-respawn timer. */
  diedAt: Tick;
}

/** Everything the per-pawn rules need from the world. */
export interface PawnContext {
  tick: Tick;
  rules: Readonly<RulesConfig>;
  weapons: WeaponTable;
  /** Spawn loadout; defaults to `DEFAULT_LOADOUT`. */
  loadout?: readonly WeaponId[];
}

/** A new pawn: dead, at the origin, allowed to respawn immediately. */
export function createPawnRecord(id: EntityId, playerId: PlayerId, tick: Tick = 0): PawnRecord {
  return {
    state: {
      id,
      kind: 'pawn',
      position: { x: 0, y: 0, z: 0 },
      playerId,
      alive: false,
      health: 0,
      shield: 0,
      velocity: { x: 0, y: 0, z: 0 },
      yaw: 0,
      pitch: 0,
      grounded: false,
      crouching: false,
      weapon: null,
      pendingWeapon: null,
      owned: [],
      ammo: {},
      spawnProtectedUntil: 0,
      respawnAt: tick,
      guiding: NO_ENTITY,
      disc: NO_ENTITY,
      viewingDisc: false,
      zoom: 1,
      udamageUntil: 0,
    },
    inventory: createInventoryState(),
    fireWasDown: false,
    // Far enough back that a fresh pawn is already past the auto-respawn time.
    diedAt: tick - AUTO_RESPAWN_SECONDS * TICK_RATE,
  };
}

/** Tick at which a dead pawn respawns without pressing Fire. */
export function autoRespawnTick(rec: Readonly<PawnRecord>): Tick {
  return Math.max(rec.state.respawnAt, rec.diedAt + AUTO_RESPAWN_SECONDS * TICK_RATE);
}

/**
 * Whether a dead pawn should respawn this tick: the minimum delay has passed
 * and Fire was pressed (not merely held since death), or the auto-respawn time
 * has come. Call once per tick per dead pawn; it tracks the Fire edge.
 */
export function wantsRespawn(rec: PawnRecord, input: Readonly<InputCommand>, tick: Tick): boolean {
  const fireDown = (input.buttons & Buttons.Fire) !== 0;
  const pressed = fireDown && !rec.fireWasDown;
  rec.fireWasDown = fireDown;
  if (rec.state.alive) return false;
  if (tick >= autoRespawnTick(rec)) return true;
  return pressed && tick >= rec.state.respawnAt;
}

/**
 * Bring a pawn to life at `pose`: 100 health, 0 shield, the spawn loadout,
 * spawn protection for `RulesConfig.spawnProtection`. Returns the `respawn`
 * event. The caller moves the pawn's `MoverState` to the pose.
 */
export function respawnPawn(rec: PawnRecord, pose: Readonly<Pose>, ctx: PawnContext): SimEvent[] {
  const s = rec.state;
  s.alive = true;
  s.health = PAWN_STATS.health;
  s.shield = 0;
  s.position = { ...pose.position };
  s.velocity = { x: 0, y: 0, z: 0 };
  s.yaw = pose.yaw;
  s.pitch = pose.pitch;
  s.grounded = false;
  s.crouching = false;
  s.guiding = NO_ENTITY;
  s.disc = NO_ENTITY;
  s.viewingDisc = false;
  s.udamageUntil = 0;
  s.spawnProtectedUntil = ctx.tick + Math.round(ctx.rules.spawnProtection * TICK_RATE);
  resetInventory(s, rec.inventory, ctx.loadout ?? DEFAULT_LOADOUT, ctx.weapons);
  return [
    {
      type: 'respawn',
      tick: ctx.tick,
      pawn: s.id,
      pose: { position: { ...pose.position }, yaw: pose.yaw, pitch: pose.pitch },
    },
  ];
}

/** True when the pawn is holding a fire button this tick. */
export function isFiring(input: Readonly<InputCommand>): boolean {
  return (input.buttons & (Buttons.Fire | Buttons.AltFire)) !== 0;
}

/**
 * Overheal decay: health above 100 drops by 1 once per simulated second (§6),
 * on ticks that are a multiple of `TICK_RATE`, never below 100.
 */
export function decayOverheal(state: PawnState, tick: Tick): void {
  if (state.alive && state.health > BASE_HEALTH && tick % TICK_RATE === 0) {
    state.health = Math.max(BASE_HEALTH, state.health - PAWN_STATS.overhealDecayPerSecond);
  }
}

/**
 * Per-tick life rules for a living pawn, run before movement and firing:
 * overheal decay, spawn protection ending on fire, weapon switching.
 * Dead pawns are left alone (see `wantsRespawn`).
 */
export function tickPawn(
  rec: PawnRecord,
  input: Readonly<InputCommand>,
  ctx: PawnContext,
): SimEvent[] {
  const s = rec.state;
  if (!s.alive) return [];
  decayOverheal(s, ctx.tick);
  if (isFiring(input) && ctx.tick < s.spawnProtectedUntil) s.spawnProtectedUntil = ctx.tick;
  rec.fireWasDown = (input.buttons & Buttons.Fire) !== 0;
  return tickInventory(s, rec.inventory, input, ctx.tick, ctx.weapons);
}

/**
 * Apply damage to a pawn record and remember when it died. Thin wrapper over
 * `applyDamage` so the auto-respawn timer starts at the right tick.
 */
export function damagePawn(
  rec: PawnRecord,
  info: Readonly<DamageInfo>,
  ctx: Readonly<DamageContext>,
): DamageResult {
  const result = applyDamage(rec.state, info, ctx);
  if (result.killed) {
    rec.diedAt = ctx.tick;
    rec.fireWasDown = true;
  }
  return result;
}

/** Copy movement results into the snapshot state (position is the capsule center). */
export function syncFromMover(state: PawnState, mover: Readonly<MoverState>): void {
  state.position = { ...mover.position };
  state.velocity = { ...mover.velocity };
  state.yaw = mover.yaw;
  state.pitch = mover.pitch;
  state.grounded = mover.grounded;
  state.crouching = mover.crouching;
}
