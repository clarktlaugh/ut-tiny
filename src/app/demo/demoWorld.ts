/**
 * `DemoWorld`: the first playable `World` (docs/DESIGN.md §8.1), wiring the
 * merged systems together for the laundry-room demo:
 *
 *   PhysicsWorld (P6) → CharacterMover (P7) → pawn life rules (P12) →
 *   WeaponSystem with the assault / rocket / shock modules (P13, P14) →
 *   VolumeSystem jump pads and kill volumes (P11) → PickupSystem (P18) →
 *   SpawnSelector respawns (P11).
 *
 * It is deliberately small: no rules module (frags are counted here), no
 * snapshot codec, no bots beyond scripted target dummies (`dummyController`).
 * Everything the renderer, HUD and audio need arrives through the `World`
 * contract: `step` returns the tick's events and `getState` a fresh snapshot.
 */
import { PICKUPS } from '../../data/pickups';
import { WEAPONS } from '../../data/weapons';
import {
  fallDamageInfo,
  killVolumeInfo,
  type DamageInfo,
  type DamageResult,
} from '../../sim/damage';
import type { WeaponTable } from '../../sim/inventory';
import {
  CharacterMover,
  createMoverState,
  type MoverState,
  type MovementConfig,
} from '../../sim/movement';
import {
  createPawnRecord,
  damagePawn,
  respawnPawn,
  syncFromMover,
  tickPawn,
  wantsRespawn,
  type PawnContext,
  type PawnRecord,
} from '../../sim/pawn';
import { HitMask, PhysicsWorld } from '../../sim/physics';
import { PickupSystem } from '../../sim/pickups';
import { Rng } from '../../sim/rng';
import { SpawnSelector, planRespawn } from '../../sim/spawn';
import {
  NO_ENTITY,
  NULL_INPUT,
  type EntityId,
  type EntityState,
  type InputCommand,
  type MapDef,
  type MatchState,
  type PawnId,
  type PawnState,
  type PlayerId,
  type PlayerProfile,
  type PlayerScore,
  type RulesConfig,
  type SimEvent,
  type Tick,
  type Vec3,
  type WeaponId,
  type World,
  type WorldOptions,
  type WorldState,
  TICK_DT,
} from '../../sim/types';
import { VolumeSystem } from '../../sim/volumes';
import { ASSAULT_MODULE } from '../../sim/weapons/assault';
import { WeaponSystem, type WeaponHost, type WeaponModule } from '../../sim/weapons/core';
import { ROCKET_MODULE } from '../../sim/weapons/rocket';
import { SHOCK_MODULE } from '../../sim/weapons/shock';

/** Deathmatch rules for the demo: no limits, weapon stay, 2 s protection, 1 s respawn. */
export const DEMO_RULES: Readonly<RulesConfig> = Object.freeze({
  fragLimit: 0,
  timeLimit: 0,
  weaponStay: true,
  spawnProtection: 2,
  respawnDelay: 1,
  udamageEnabled: true,
});

/** Everyone spawns with the M2 arsenal so the demo is fun from the first second. */
export const DEMO_LOADOUT: readonly WeaponId[] = Object.freeze(['assault', 'rocket', 'shock']);

export interface DemoWorldOptions {
  map: MapDef;
  seed?: number;
  rules?: Readonly<RulesConfig>;
  weapons?: WeaponTable;
  loadout?: readonly WeaponId[];
  movement?: MovementConfig;
  modules?: readonly WeaponModule[];
}

interface PlayerEntry {
  pawn: PawnId;
  profile: PlayerProfile;
  frags: number;
  deaths: number;
  suicides: number;
  spree: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);

export class DemoWorld implements World, WeaponHost {
  tick: Tick = 0;
  readonly options: Readonly<WorldOptions>;
  readonly rng: Rng;
  readonly rules: Readonly<RulesConfig>;
  readonly weapons: WeaponTable;
  readonly mover: CharacterMover;
  readonly volumes: VolumeSystem;
  readonly spawns: SpawnSelector;
  readonly pickups: PickupSystem;
  readonly weaponSystem: WeaponSystem;

  private readonly loadout: readonly WeaponId[];
  private readonly records = new Map<PawnId, PawnRecord>();
  private readonly movers = new Map<PawnId, MoverState>();
  private readonly players = new Map<PlayerId, PlayerEntry>();
  private nextId: EntityId = 1;
  private stateCache: WorldState | null = null;

  private constructor(
    readonly physics: PhysicsWorld,
    options: DemoWorldOptions,
  ) {
    this.rules = options.rules ?? DEMO_RULES;
    this.weapons = options.weapons ?? WEAPONS;
    this.loadout = options.loadout ?? DEMO_LOADOUT;
    this.rng = new Rng(options.seed ?? 1);
    this.options = {
      map: options.map,
      seed: options.seed ?? 1,
      rules: this.rules,
      weapons: this.weapons,
      pickups: PICKUPS,
    };
    this.mover = new CharacterMover(physics, options.movement);
    this.volumes = new VolumeSystem(options.map);
    this.spawns = new SpawnSelector(options.map.spawns);
    this.pickups = new PickupSystem({
      map: options.map,
      rules: this.rules,
      weapons: this.weapons,
      allocateId: () => this.allocateEntityId(),
    });
    this.weaponSystem = new WeaponSystem(
      this,
      options.modules ?? [ASSAULT_MODULE, ROCKET_MODULE, SHOCK_MODULE],
    );
  }

  /** Load the map into a fresh physics world and build the demo world over it. */
  static async create(options: DemoWorldOptions): Promise<DemoWorld> {
    const physics = await PhysicsWorld.fromMap(options.map);
    physics.step();
    return new DemoWorld(physics, options);
  }

  // -- WeaponHost -----------------------------------------------------------

  allocateEntityId(): EntityId {
    return this.nextId++;
  }

  pawn(id: PawnId): PawnState | undefined {
    return this.records.get(id)?.state;
  }

  *pawns(): Iterable<PawnState> {
    for (const id of this.sortedPawnIds()) {
      const rec = this.records.get(id);
      if (rec) yield rec.state;
    }
  }

  damage(target: PawnId, info: DamageInfo, tick: Tick): DamageResult | undefined {
    const rec = this.records.get(target);
    if (!rec) return undefined;
    const instigatorPawn = this.records.get(info.instigator)?.state;
    const result = damagePawn(
      rec,
      info,
      instigatorPawn ? { tick, rules: this.rules, instigatorPawn } : { tick, rules: this.rules },
    );
    const ms = this.movers.get(target);
    if (result.applied && ms && rec.state.alive) {
      const dv = result.velocityChange;
      ms.velocity.x += dv.x;
      ms.velocity.y += dv.y;
      ms.velocity.z += dv.z;
      // Knockback with lift takes the pawn off the ground (rocket jumps, §5).
      if (dv.y > 0.5 && ms.grounded) {
        ms.grounded = false;
        ms.airborne = 'launch';
      }
      rec.state.velocity = { ...ms.velocity };
    }
    if (result.killed) this.onDeath(rec, info, tick, result.events);
    return result;
  }

  // -- World ----------------------------------------------------------------

  addPlayer(playerId: PlayerId, profile: PlayerProfile): PawnId {
    const existing = this.players.get(playerId);
    if (existing) return existing.pawn;
    const id = this.allocateEntityId();
    const rec = createPawnRecord(id, playerId, this.tick);
    this.records.set(id, rec);
    this.players.set(playerId, {
      pawn: id,
      profile,
      frags: 0,
      deaths: 0,
      suicides: 0,
      spree: 0,
    });
    this.stateCache = null;
    return id;
  }

  removePlayer(playerId: PlayerId): void {
    const entry = this.players.get(playerId);
    if (!entry) return;
    const id = entry.pawn;
    this.players.delete(playerId);
    this.records.delete(id);
    this.movers.delete(id);
    if (this.physics.actorPosition(id)) this.physics.removeActor(id);
    this.weaponSystem.removeOwner(id, this.tick);
    this.pickups.removePawn(id);
    this.volumes.removePawn(id);
    this.stateCache = null;
  }

  pawnFor(playerId: PlayerId): PawnId {
    return this.players.get(playerId)?.pawn ?? NO_ENTITY;
  }

  getEntity(id: EntityId): Readonly<EntityState> | undefined {
    return this.getState().entities.find((e) => e.id === id);
  }

  getState(): Readonly<WorldState> {
    if (this.stateCache) return this.stateCache;
    const entities: EntityState[] = [];
    for (const s of this.pawns()) entities.push(clonePawn(s));
    for (const p of this.weaponSystem.projectileStates()) {
      entities.push({ ...p, position: { ...p.position }, velocity: { ...p.velocity } });
    }
    for (const p of this.pickups.states()) entities.push({ ...p, takenBy: [...p.takenBy] });
    this.stateCache = {
      tick: this.tick,
      time: this.tick * TICK_DT,
      rngState: this.rng.getState(),
      entities,
      match: this.matchState(),
    };
    return this.stateCache;
  }

  step(inputs: ReadonlyMap<PawnId, InputCommand>): readonly SimEvent[] {
    const tick = this.tick;
    const events: SimEvent[] = [];
    if (tick === 0) events.push(...this.pickups.spawnEvents(tick));
    const ctx: PawnContext = {
      tick,
      rules: this.rules,
      weapons: this.weapons,
      loadout: this.loadout,
    };

    // Pawns: life rules, movement, firing.
    for (const id of this.sortedPawnIds()) {
      const rec = this.records.get(id);
      if (!rec) continue;
      const input = inputs.get(id) ?? NULL_INPUT;
      if (!rec.state.alive) {
        if (wantsRespawn(rec, input, tick)) this.respawn(rec, ctx, events);
        continue;
      }
      events.push(...tickPawn(rec, input, ctx));
      const ms = this.movers.get(id);
      if (ms) {
        const moved = this.mover.step(id, ms, input, tick);
        syncFromMover(rec.state, ms);
        events.push(...moved.events);
        if (moved.fallDamage > 0) {
          const r = this.damage(id, fallDamageInfo(moved.fallDamage), tick);
          if (r) events.push(...r.events);
        }
      }
      if (rec.state.alive) events.push(...this.weaponSystem.tickPawn(rec, input, tick));
    }

    // Sensors: jump pads, kill and damage volumes.
    const sensorEvents = this.physics.step();
    const vu = this.volumes.update(tick, sensorEvents, {
      isAlive: (pawn) => this.records.get(pawn)?.state.alive ?? false,
    });
    // Kill-volume deaths go through the damage pipeline below, so drop the system's own.
    events.push(...vu.events.filter((e) => e.type !== 'death'));
    for (const launch of vu.launches) {
      const ms = this.movers.get(launch.pawn);
      const rec = this.records.get(launch.pawn);
      if (!ms || !rec) continue;
      this.mover.launch(ms, launch.velocity);
      syncFromMover(rec.state, ms);
    }
    for (const kill of vu.kills) {
      const r = this.damage(kill.pawn, killVolumeInfo(kill.message), tick);
      if (r) events.push(...r.events);
    }
    for (const d of vu.damage) {
      const r = this.damage(
        d.pawn,
        { amount: d.amount, damageType: 'damageVolume', instigator: NO_ENTITY, weapon: null },
        tick,
      );
      if (r) events.push(...r.events);
    }

    // Projectiles, then pickups.
    events.push(...this.weaponSystem.step(tick, inputs));
    events.push(...this.pickups.update(tick, this.records.values()).events);

    this.tick++;
    this.stateCache = null;
    return events;
  }

  // -- Internals ------------------------------------------------------------

  /** Put a living pawn's capsule center at `position` (debug and tests). */
  teleportPawn(pawn: PawnId, position: Readonly<Vec3>, yaw?: number): boolean {
    const rec = this.records.get(pawn);
    const ms = this.movers.get(pawn);
    if (!rec || !ms || !rec.state.alive) return false;
    this.mover.teleport(pawn, ms, position, yaw);
    syncFromMover(rec.state, ms);
    this.stateCache = null;
    return true;
  }

  /** The local pawn's live movement state (for the demo camera); undefined while dead. */
  moverState(pawn: PawnId): Readonly<MoverState> | undefined {
    return this.movers.get(pawn);
  }

  /** Scores by player id, for the HUD. */
  scoreFor(playerId: PlayerId): Readonly<PlayerScore> | undefined {
    const e = this.players.get(playerId);
    if (!e) return undefined;
    return {
      playerId,
      name: e.profile.name,
      isBot: e.profile.isBot,
      frags: e.frags,
      deaths: e.deaths,
      suicides: e.suicides,
      spree: e.spree,
    };
  }

  /** Display name of a pawn's player, for the kill feed. */
  nameOf(pawn: PawnId): string {
    const rec = this.records.get(pawn);
    if (!rec) return '?';
    return this.players.get(rec.state.playerId)?.profile.name ?? rec.state.playerId;
  }

  private sortedPawnIds(): number[] {
    return [...this.records.keys()].sort((a, b) => a - b);
  }

  private respawn(rec: PawnRecord, ctx: PawnContext, events: SimEvent[]): void {
    const id = rec.state.id;
    const enemies: Vec3[] = [];
    for (const other of this.pawns()) {
      if (other.id !== id && other.alive) enemies.push(other.position);
    }
    const plan = planRespawn(
      id,
      ctx.tick,
      this.spawns,
      {
        enemies,
        canSee: (from, to) => {
          const d = sub(to, from);
          const dist = len(d);
          if (dist < 1e-3) return true;
          return this.physics.raycast(from, d, dist, { mask: HitMask.World }) === null;
        },
      },
      this.rng,
    );
    events.push(...respawnPawn(rec, plan.pose, ctx));
    let ms = this.movers.get(id);
    if (!ms) {
      ms = createMoverState(plan.center, plan.pose.yaw);
      this.movers.set(id, ms);
    }
    ms.crouching = false;
    if (!this.physics.actorPosition(id)) this.mover.addPawn(id, ms);
    this.mover.teleport(id, ms, plan.center, plan.pose.yaw);
    syncFromMover(rec.state, ms);
  }

  private onDeath(rec: PawnRecord, info: DamageInfo, tick: Tick, events: SimEvent[]): void {
    const id = rec.state.id;
    events.push(...this.weaponSystem.onPawnDied(id, tick));
    this.pickups.onPawnDied(id);
    this.volumes.removePawn(id);
    if (this.physics.actorPosition(id)) this.physics.removeActor(id);
    const ms = this.movers.get(id);
    if (ms) ms.velocity = { x: 0, y: 0, z: 0 };

    const victim = this.players.get(rec.state.playerId);
    if (victim) {
      victim.deaths++;
      victim.spree = 0;
    }
    const killerRec = this.records.get(info.instigator);
    const killer = killerRec ? this.players.get(killerRec.state.playerId) : undefined;
    if (!killer || killer === victim) {
      if (victim) {
        victim.suicides++;
        victim.frags--;
      }
    } else {
      killer.frags++;
      killer.spree++;
    }
  }

  private matchState(): MatchState {
    const scores: PlayerScore[] = [];
    for (const [playerId] of this.players) {
      const s = this.scoreFor(playerId);
      if (s) scores.push({ ...s });
    }
    scores.sort((a, b) => b.frags - a.frags || a.deaths - b.deaths);
    return {
      phase: 'playing',
      fragLimit: this.rules.fragLimit,
      timeLimit: this.rules.timeLimit,
      elapsed: this.tick * TICK_DT,
      scores,
      winner: null,
    };
  }
}

function clonePawn(s: PawnState): PawnState {
  return {
    ...s,
    position: { ...s.position },
    velocity: { ...s.velocity },
    owned: [...s.owned],
    ammo: { ...s.ammo },
  };
}
