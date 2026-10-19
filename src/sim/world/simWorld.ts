/**
 * World v1 (docs/DESIGN.md §8.1, P29): the `World` from `src/sim/types.ts`,
 * built by wiring the existing sim systems together.
 *
 * One `step()` runs one 1/60 s tick, `t = previous tick + 1`, in this order:
 *
 *  0. Queued events: `entitySpawned` for the map's pickups, jump pads and
 *     volumes on the first tick; `addPlayer` / `removePlayer` bookkeeping.
 *  1. Inputs: every pawn gets its command (or `NULL_INPUT`), sanitised.
 *  2. Respawns, ascending pawn id: `wantsRespawn` → `planRespawn` (spawn
 *     scoring against the live pawns, seeded noise) → `respawnPawn` and a
 *     fresh `MoverState` + capsule at the spawn.
 *  3. Life and movement, ascending: `tickPawn` (overheal decay, spawn
 *     protection, switching), then `CharacterMover.step`; fall damage goes
 *     through the damage pipeline.
 *  4. Physics refresh → `VolumeSystem.update`: kill volumes, damage volumes,
 *     jump pad launches.
 *  5. Firing, ascending: `WeaponSystem.tickPawn`.
 *  6. Projectiles: `WeaponSystem.step`.
 *  7. Pickups: `PickupSystem.update`.
 *  8. Match rules (`MatchRules.update`), then the snapshot.
 *
 * Deaths can happen in steps 3–7. Each one is queued and handled right after
 * the call that caused it: the capsule leaves the physics world, the weapon
 * system detonates guided warheads (`onPawnDied`), and weapon stay resets.
 *
 * Dead pawns have no capsule, do not move and cannot be hit; they keep their
 * last position in the snapshot. `PawnState.position` is the capsule center.
 *
 * Determinism: no wall-clock, no `Math.random`; all randomness comes from
 * the world's one `Rng`; every loop runs in ascending entity id. Entity ids
 * come from one counter and are never reused.
 */
import { fallDamageInfo, killPawn, type DamageInfo, type DamageResult } from '../damage';
import type { WeaponTable } from '../inventory';
import {
  CharacterMover,
  DEFAULT_MOVEMENT,
  createMoverState,
  type MovementConfig,
  type MoverState,
} from '../movement';
import {
  createPawnRecord,
  damagePawn,
  respawnPawn,
  syncFromMover,
  tickPawn,
  wantsRespawn,
  type PawnContext,
  type PawnRecord,
} from '../pawn';
import { HitMask, PhysicsWorld, type LoadMapOptions, type SensorEvent } from '../physics';
import { PickupSystem } from '../pickups';
import { Rng } from '../rng';
import { SpawnSelector, planRespawn, type SpawnQuery } from '../spawn';
import {
  Buttons,
  NO_ENTITY,
  NULL_INPUT,
  TICK_DT,
  type EntityId,
  type EntityState,
  type InputCommand,
  type JumpPadState,
  type PawnId,
  type PawnState,
  type PlayerId,
  type PlayerProfile,
  type RulesConfig,
  type SimEvent,
  type Tick,
  type Vec3,
  type VolumeState,
  type World,
  type WorldOptions,
  type WorldState,
} from '../types';
import { VolumeSystem } from '../volumes';
import { ASSAULT_MODULE } from '../weapons/assault';
import { WeaponSystem, type WeaponHost, type WeaponModule } from '../weapons/core';
import { ROCKET_MODULE } from '../weapons/rocket';
import { SHOCK_MODULE } from '../weapons/shock';
import { DISC_PLACEHOLDER_MODULE } from './discPlaceholder';
import { sanitizeInput } from './input';
import { BasicMatchRules, type MatchRules, type MatchView } from './matchRules';

/** Weapon modules every world registers. Later packets add theirs via `WorldExtras.modules`. */
export const DEFAULT_WEAPON_MODULES: readonly WeaponModule[] = Object.freeze([
  DISC_PLACEHOLDER_MODULE,
  ASSAULT_MODULE,
  ROCKET_MODULE,
  SHOCK_MODULE,
]);

/** Optional extras beyond the contract's `WorldOptions`. */
export interface WorldExtras {
  /** Extra weapon modules, registered after (and so replacing) the defaults. */
  modules?: readonly WeaponModule[];
  /** Match rules; defaults to `BasicMatchRules` (P23 supplies the real ones). */
  rules?: MatchRules;
  /** Movement tuning; the world keeps and uses this object, so live edits apply. */
  movement?: MovementConfig;
  /** Prop collision geometry for the physics world. */
  propGeometry?: LoadMapOptions['propGeometry'];
}

/** Per-pawn data the world keeps beside the `PawnRecord`. */
interface PawnSlot {
  rec: PawnRecord;
  playerId: PlayerId;
  profile: PlayerProfile;
  /** Movement state for the current life; null while dead. */
  mover: MoverState | null;
  /**
   * Fire buttons are ignored until released: set when the pawn respawns with
   * one held, so the press that respawned it neither fires nor ends spawn
   * protection.
   */
  holdFire: boolean;
}

const FIRE_BUTTONS = Buttons.Fire | Buttons.AltFire;

/** Build a world: loads the map into a fresh Rapier world. */
export async function createWorld(
  options: WorldOptions,
  extras: WorldExtras = {},
): Promise<SimWorld> {
  const physics = await PhysicsWorld.fromMap(
    options.map,
    extras.propGeometry ? { propGeometry: extras.propGeometry } : {},
  );
  return new SimWorld(options, physics, extras);
}

export class SimWorld implements World {
  readonly options: Readonly<WorldOptions>;
  readonly physics: PhysicsWorld;
  readonly rng: Rng;
  readonly mover: CharacterMover;
  readonly weapons: WeaponSystem;
  readonly pickups: PickupSystem;
  readonly volumes: VolumeSystem;
  readonly spawns: SpawnSelector;
  readonly rules: MatchRules;

  private currentTick: Tick = 0;
  private nextId: EntityId = 1;
  private readonly slots = new Map<PawnId, PawnSlot>();
  private readonly players = new Map<PlayerId, PawnId>();
  private readonly jumpPadStates: JumpPadState[] = [];
  private readonly volumeStates: VolumeState[] = [];
  /** Events reported at the start of the next step. */
  private pending: SimEvent[] = [];
  /** Pawns killed since the last `drainDeaths`. */
  private deaths: PawnId[] = [];
  /** Sensor transitions from physics refreshes not yet given to the volume system. */
  private sensorBuffer: SensorEvent[] = [];
  private snapshot: WorldState;
  private entityIndex: Map<EntityId, EntityState> | null = null;

  constructor(options: WorldOptions, physics: PhysicsWorld, extras: WorldExtras = {}) {
    this.options = options;
    this.physics = physics;
    this.rng = new Rng(options.seed);
    this.mover = new CharacterMover(physics, extras.movement ?? { ...DEFAULT_MOVEMENT });
    this.rules = extras.rules ?? new BasicMatchRules(options.rules);
    this.spawns = new SpawnSelector(options.map.spawns);
    this.volumes = new VolumeSystem(options.map);
    this.pickups = new PickupSystem({
      map: options.map,
      rules: options.rules,
      weapons: options.weapons,
      pickups: options.pickups,
      allocateId: () => this.allocateId(),
    });
    options.map.jumpPads.forEach((pad, placementIndex) => {
      this.jumpPadStates.push({
        id: this.allocateId(),
        kind: 'jumpPad',
        position: { ...pad.position },
        placementIndex,
      });
    });
    options.map.volumes.forEach((vol, placementIndex) => {
      const { min, max } = vol.box;
      this.volumeStates.push({
        id: this.allocateId(),
        kind: 'volume',
        position: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
        placementIndex,
        volumeKind: vol.kind,
      });
    });
    this.weapons = new WeaponSystem(this.weaponHost(), [
      ...DEFAULT_WEAPON_MODULES,
      ...(extras.modules ?? []),
    ]);

    for (const p of this.pickups.states()) this.queueSpawned(p.id, 'pickup');
    for (const p of this.jumpPadStates) this.queueSpawned(p.id, 'jumpPad');
    for (const v of this.volumeStates) this.queueSpawned(v.id, 'volume');

    this.stepPhysics();
    this.snapshot = this.buildSnapshot();
  }

  get tick(): Tick {
    return this.currentTick;
  }

  /** Movement tuning in use (shared with the dev tuning panel). */
  get movement(): MovementConfig {
    return this.mover.config;
  }

  // -- World interface ------------------------------------------------------

  step(inputs: ReadonlyMap<PawnId, InputCommand>): readonly SimEvent[] {
    const t = this.currentTick + 1;
    const events: SimEvent[] = this.pending.map((e) => ({ ...e, tick: t }) as SimEvent);
    this.pending = [];

    const ids = this.pawnIds();
    const resolved = new Map<PawnId, InputCommand>();
    for (const id of ids) {
      const slot = this.slots.get(id);
      if (!slot) continue;
      resolved.set(id, sanitizeInput(inputs.get(id) ?? NULL_INPUT, slot.rec.state));
    }
    const ctx: PawnContext = { tick: t, rules: this.options.rules, weapons: this.options.weapons };

    // 2. Respawns.
    let respawned = false;
    for (const id of ids) {
      const slot = this.slots.get(id);
      const input = resolved.get(id);
      if (!slot || !input) continue;
      if (!wantsRespawn(slot.rec, input, t)) continue;
      this.respawn(slot, ctx, events);
      if (input.buttons & FIRE_BUTTONS) slot.holdFire = true;
      respawned = true;
    }
    if (respawned) this.stepPhysics();
    for (const id of ids) {
      const slot = this.slots.get(id);
      const input = resolved.get(id);
      if (!slot?.holdFire || !input) continue;
      if (input.buttons & FIRE_BUTTONS) input.buttons &= ~FIRE_BUTTONS;
      else slot.holdFire = false;
    }

    // 3. Life rules and movement.
    for (const id of ids) {
      const slot = this.slots.get(id);
      const input = resolved.get(id);
      if (!slot || !input || !slot.rec.state.alive || !slot.mover) continue;
      events.push(...tickPawn(slot.rec, input, ctx));
      const state = slot.rec.state;
      const moveInput: InputCommand =
        state.guiding !== NO_ENTITY
          ? { ...NULL_INPUT, yaw: slot.mover.yaw, pitch: slot.mover.pitch }
          : input;
      const moved = this.mover.step(id, slot.mover, moveInput, t);
      events.push(...moved.events);
      syncFromMover(state, slot.mover);
      if (moved.fallDamage > 0) this.damage(id, fallDamageInfo(moved.fallDamage), t, events);
      this.drainDeaths(t, events);
    }

    // 4. Volumes and jump pads.
    this.stepPhysics();
    const sensorEvents = this.sensorBuffer;
    this.sensorBuffer = [];
    const vol = this.volumes.update(t, sensorEvents, {
      isAlive: (pawn) => this.slots.get(pawn)?.rec.state.alive ?? false,
      entityFor: (kind, index) =>
        (kind === 'jumpPad' ? this.jumpPadStates[index] : this.volumeStates[index])?.id ??
        NO_ENTITY,
    });
    for (const kill of vol.kills) {
      const slot = this.slots.get(kill.pawn);
      if (!slot?.rec.state.alive) continue;
      killPawn(slot.rec.state, t, this.options.rules);
      slot.rec.diedAt = t;
      slot.rec.fireWasDown = true;
      this.deaths.push(kill.pawn);
    }
    events.push(...vol.events);
    for (const hurt of vol.damage) {
      this.damage(
        hurt.pawn,
        { amount: hurt.amount, damageType: 'damageVolume', instigator: NO_ENTITY, weapon: null },
        t,
        events,
      );
    }
    for (const launch of vol.launches) {
      const slot = this.slots.get(launch.pawn);
      if (slot?.mover && slot.rec.state.alive) this.mover.launch(slot.mover, launch.velocity);
    }
    this.drainDeaths(t, events);

    // 5. Firing.
    for (const id of ids) {
      const slot = this.slots.get(id);
      const input = resolved.get(id);
      if (!slot || !input) continue;
      events.push(...this.weapons.tickPawn(slot.rec, input, t));
      this.drainDeaths(t, events);
    }

    // 6. Projectiles.
    events.push(...this.weapons.step(t, resolved));
    this.drainDeaths(t, events);

    // 7. Pickups.
    events.push(...this.pickups.update(t, this.records()).events);

    // Knockback and pad launches changed mover velocities after the sync above.
    for (const slot of this.slots.values()) {
      if (slot.mover && slot.rec.state.alive) syncFromMover(slot.rec.state, slot.mover);
    }

    // 8. Rules and snapshot.
    this.currentTick = t;
    events.push(...this.rules.update(events, this.matchView()));
    this.snapshot = this.buildSnapshot();
    return events;
  }

  addPlayer(playerId: PlayerId, profile: PlayerProfile): PawnId {
    const existing = this.players.get(playerId);
    if (existing !== undefined) return existing;
    const id = this.allocateId();
    const rec = createPawnRecord(id, playerId, this.currentTick);
    this.slots.set(id, { rec, playerId, profile: { ...profile }, mover: null, holdFire: false });
    this.players.set(playerId, id);
    this.queueSpawned(id, 'pawn');
    this.pending.push(...this.rules.addPlayer(playerId, profile, this.currentTick + 1));
    this.snapshot = this.buildSnapshot();
    return id;
  }

  removePlayer(playerId: PlayerId): void {
    const id = this.players.get(playerId);
    if (id === undefined) return;
    const t = this.currentTick + 1;
    const slot = this.slots.get(id);
    this.pending.push(...this.weapons.removeOwner(id, t));
    this.physics.removeActor(id);
    this.volumes.removePawn(id);
    this.pickups.removePawn(id);
    this.slots.delete(id);
    this.players.delete(playerId);
    if (slot) this.pending.push({ type: 'entityDestroyed', tick: t, id, kind: 'pawn' });
    this.pending.push(...this.rules.removePlayer(playerId, t));
    this.stepPhysics();
    this.snapshot = this.buildSnapshot();
  }

  pawnFor(playerId: PlayerId): PawnId {
    return this.players.get(playerId) ?? NO_ENTITY;
  }

  getState(): Readonly<WorldState> {
    return this.snapshot;
  }

  getEntity(id: EntityId): Readonly<EntityState> | undefined {
    if (!this.entityIndex) {
      this.entityIndex = new Map(this.snapshot.entities.map((e) => [e.id, e]));
    }
    return this.entityIndex.get(id);
  }

  // -- Extras ---------------------------------------------------------------

  /** Profile a participant joined with (bot skill lives here; `PawnState` has no field for it). */
  profileFor(playerId: PlayerId): Readonly<PlayerProfile> | undefined {
    const id = this.players.get(playerId);
    return id === undefined ? undefined : this.slots.get(id)?.profile;
  }

  /** Participant owning a pawn, or undefined. */
  playerFor(pawn: PawnId): PlayerId | undefined {
    return this.slots.get(pawn)?.playerId;
  }

  /** True while the pawn is inside a water volume. */
  inWater(pawn: PawnId): boolean {
    return this.volumes.inWater(pawn);
  }

  /** Free the Rapier world. The world is unusable afterwards. */
  dispose(): void {
    this.physics.dispose();
  }

  // -- Internals ------------------------------------------------------------

  private allocateId(): EntityId {
    return this.nextId++;
  }

  private queueSpawned(id: EntityId, kind: EntityState['kind']): void {
    this.pending.push({ type: 'entitySpawned', tick: this.currentTick + 1, id, kind });
  }

  private pawnIds(): PawnId[] {
    return [...this.slots.keys()].sort((a, b) => a - b);
  }

  private records(): PawnRecord[] {
    return this.pawnIds()
      .map((id) => this.slots.get(id)?.rec)
      .filter((rec): rec is PawnRecord => rec !== undefined);
  }

  /** Refresh physics queries; sensor transitions wait for the volume step. */
  private stepPhysics(): void {
    this.sensorBuffer.push(...this.physics.step());
  }

  private respawn(slot: PawnSlot, ctx: PawnContext, events: SimEvent[]): void {
    const id = slot.rec.state.id;
    const others: Vec3[] = [];
    for (const other of this.pawnIds()) {
      const s = this.slots.get(other)?.rec.state;
      if (other !== id && s?.alive) others.push(s.position);
    }
    const query: SpawnQuery = {
      enemies: others,
      canSee: (from, to) => this.canSee(from, to),
    };
    const plan = planRespawn(id, ctx.tick, this.spawns, query, this.rng);
    events.push(...respawnPawn(slot.rec, plan.pose, ctx));
    const mover = createMoverState(plan.center, plan.pose.yaw);
    mover.pitch = plan.pose.pitch;
    slot.mover = mover;
    this.physics.removeActor(id);
    this.mover.addPawn(id, mover);
    syncFromMover(slot.rec.state, mover);
  }

  private canSee(from: Readonly<Vec3>, to: Readonly<Vec3>): boolean {
    const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
    const dist = Math.hypot(d.x, d.y, d.z);
    if (!(dist > 0)) return true;
    return this.physics.raycast(from, d, dist, { mask: HitMask.World }) === null;
  }

  /** Route a hit through the pipeline, apply knockback, queue a death. */
  private applyHit(target: PawnId, info: DamageInfo, tick: Tick): DamageResult | undefined {
    const slot = this.slots.get(target);
    if (!slot) return undefined;
    const instigator = this.slots.get(info.instigator)?.rec.state;
    const result = damagePawn(
      slot.rec,
      info,
      instigator
        ? { tick, rules: this.options.rules, instigatorPawn: instigator }
        : { tick, rules: this.options.rules },
    );
    if (result.killed) {
      this.deaths.push(target);
    } else if (slot.mover && result.applied) {
      const dv = result.velocityChange;
      if (dv.x !== 0 || dv.y !== 0 || dv.z !== 0) {
        const v = slot.mover.velocity;
        this.mover.launch(slot.mover, { x: v.x + dv.x, y: v.y + dv.y, z: v.z + dv.z });
      }
    }
    return result;
  }

  /** `applyHit` for the world's own damage sources; emits the result's events. */
  private damage(target: PawnId, info: DamageInfo, tick: Tick, events: SimEvent[]): void {
    const result = this.applyHit(target, info, tick);
    if (result) events.push(...result.events);
  }

  /** Handle queued deaths, including any caused by the handling itself. */
  private drainDeaths(tick: Tick, events: SimEvent[]): void {
    if (this.deaths.length === 0) return;
    while (this.deaths.length > 0) {
      const id = this.deaths.shift() as PawnId;
      const slot = this.slots.get(id);
      if (!slot) continue;
      slot.mover = null;
      this.physics.removeActor(id);
      this.pickups.onPawnDied(id);
      events.push(...this.weapons.onPawnDied(id, tick));
    }
    this.stepPhysics();
  }

  private weaponHost(): WeaponHost {
    const weapons: WeaponTable = this.options.weapons;
    const rules: Readonly<RulesConfig> = this.options.rules;
    return {
      physics: this.physics,
      rng: this.rng,
      weapons,
      rules,
      allocateEntityId: () => this.allocateId(),
      pawn: (id) => this.slots.get(id)?.rec.state,
      pawns: () => this.pawnStates(),
      damage: (target, info, tick) => this.applyHit(target, info, tick),
    };
  }

  private pawnStates(): PawnState[] {
    const out: PawnState[] = [];
    for (const id of this.pawnIds()) {
      const s = this.slots.get(id)?.rec.state;
      if (s) out.push(s);
    }
    return out;
  }

  private matchView(): MatchView {
    return {
      tick: this.currentTick,
      time: this.currentTick * TICK_DT,
      playerFor: (pawn) => this.playerFor(pawn),
    };
  }

  /** Deep copy of everything, so a held snapshot never changes under its reader. */
  private buildSnapshot(): WorldState {
    const entities: EntityState[] = [
      ...this.pawnStates(),
      ...this.weapons.projectileStates(),
      ...this.pickups.states(),
      ...this.jumpPadStates,
      ...this.volumeStates,
    ];
    entities.sort((a, b) => a.id - b.id);
    this.entityIndex = null;
    return structuredClone({
      tick: this.currentTick,
      time: this.currentTick * TICK_DT,
      rngState: this.rng.getState(),
      entities,
      match: this.rules.state(),
    });
  }
}
