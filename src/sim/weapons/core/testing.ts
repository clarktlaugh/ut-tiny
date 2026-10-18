/**
 * Test host for the weapon framework: a `WeaponHost` over a `PhysicsWorld`
 * that keeps `PawnRecord`s itself and routes damage through `damagePawn`.
 * Used by the core tests and meant for per-weapon packets' tests too; it is
 * not part of the runtime world.
 */
import { WEAPONS } from '../../../data/weapons';
import type { DamageInfo, DamageResult } from '../../damage';
import type { WeaponTable } from '../../inventory';
import { createPawnRecord, damagePawn, respawnPawn, type PawnRecord } from '../../pawn';
import { PAWN_CAPSULE, PhysicsWorld } from '../../physics/physicsWorld';
import { Rng } from '../../rng';
import {
  NULL_INPUT,
  type Brush,
  type EntityId,
  type InputCommand,
  type MapDef,
  type PawnId,
  type PawnState,
  type RulesConfig,
  type Tick,
  type Vec3,
  type WeaponId,
} from '../../types';
import type { WeaponHost } from './host';

export const TEST_RULES: RulesConfig = {
  fragLimit: 20,
  timeLimit: 600,
  weaponStay: true,
  spawnProtection: 2,
  respawnDelay: 1,
  udamageEnabled: true,
};

const box = (position: Vec3, size: Vec3): Brush => ({
  shape: 'box',
  position,
  size,
  material: 'grey',
});

/**
 * Arena: 200 × 200 m floor with its top face at y = 0, a 2 m thick wall
 * across z = −40 (x from −20 to 20, 20 m tall), and a ceiling at y = 60.
 */
export function arenaMap(): MapDef {
  return {
    name: 'weapon-arena',
    scale: 40,
    brushes: [
      box({ x: 0, y: -0.5, z: 0 }, { x: 200, y: 1, z: 200 }),
      box({ x: 0, y: 10, z: -41 }, { x: 40, y: 20, z: 2 }),
      box({ x: 0, y: 60.5, z: 0 }, { x: 200, y: 1, z: 200 }),
    ],
    props: [],
    spawns: [],
    pickups: [],
    jumpPads: [],
    volumes: [],
    lights: [],
    navLinks: [],
    cameras: [],
    ambience: { loops: [], reverb: 'none' },
  };
}

/** Capsule center height of a standing pawn whose feet are on y = 0. */
export const STANDING_CENTER_Y = PAWN_CAPSULE.halfHeight + PAWN_CAPSULE.radius;

export interface TestPawnOptions {
  /** Feet position; the capsule center is placed `STANDING_CENTER_Y` above it. */
  feet?: Vec3;
  yaw?: number;
  pitch?: number;
  weapon?: WeaponId;
  /** Weapons to own besides the spawn loadout. */
  give?: WeaponId[];
}

export class TestHost implements WeaponHost {
  readonly rng: Rng;
  readonly rules = TEST_RULES;
  readonly records = new Map<PawnId, PawnRecord>();
  private nextId: EntityId = 1;

  constructor(
    readonly physics: PhysicsWorld,
    readonly weapons: WeaponTable = WEAPONS,
    seed = 1,
  ) {
    this.rng = new Rng(seed);
  }

  static async create(map: MapDef = arenaMap(), seed = 1): Promise<TestHost> {
    const physics = await PhysicsWorld.fromMap(map);
    physics.step();
    return new TestHost(physics, WEAPONS, seed);
  }

  allocateEntityId(): EntityId {
    return this.nextId++;
  }

  pawn(id: PawnId): PawnState | undefined {
    return this.records.get(id)?.state;
  }

  *pawns(): Iterable<PawnState> {
    const ids = [...this.records.keys()].sort((a, b) => a - b);
    for (const id of ids) {
      const rec = this.records.get(id);
      if (rec) yield rec.state;
    }
  }

  damage(target: PawnId, info: DamageInfo, tick: Tick): DamageResult | undefined {
    const rec = this.records.get(target);
    if (!rec) return undefined;
    const instigator = this.records.get(info.instigator)?.state;
    const result = damagePawn(
      rec,
      info,
      instigator
        ? { tick, rules: this.rules, instigatorPawn: instigator }
        : { tick, rules: this.rules },
    );
    const v = rec.state.velocity;
    const dv = result.velocityChange;
    rec.state.velocity = { x: v.x + dv.x, y: v.y + dv.y, z: v.z + dv.z };
    return result;
  }

  /**
   * Add a living pawn with its spawn protection already over, holding
   * `weapon` (default: the spawn loadout's best), standing with its feet at
   * `feet`. Its capsule is registered with the physics world.
   */
  addPawn(options: TestPawnOptions = {}, tick: Tick = 0): PawnRecord {
    const id = this.allocateEntityId();
    const feet = options.feet ?? { x: 0, y: 0, z: 0 };
    const position = { x: feet.x, y: feet.y + STANDING_CENTER_Y, z: feet.z };
    const rec = createPawnRecord(id, `p${id}`, tick);
    respawnPawn(
      rec,
      { position, yaw: options.yaw ?? 0, pitch: options.pitch ?? 0 },
      { tick, rules: this.rules, weapons: this.weapons },
    );
    rec.state.spawnProtectedUntil = 0;
    for (const w of options.give ?? []) {
      if (!rec.state.owned.includes(w)) rec.state.owned.push(w);
      const ammo = this.weapons[w].ammo;
      if (ammo) rec.state.ammo[w] = ammo.start;
    }
    if (options.weapon) {
      if (!rec.state.owned.includes(options.weapon)) rec.state.owned.push(options.weapon);
      const ammo = this.weapons[options.weapon].ammo;
      if (ammo && rec.state.ammo[options.weapon] === undefined) {
        rec.state.ammo[options.weapon] = ammo.start;
      }
      rec.state.weapon = options.weapon;
    }
    rec.state.pendingWeapon = null;
    this.records.set(id, rec);
    this.physics.addActor(id, position);
    this.physics.step();
    return rec;
  }

  /** Move a pawn's capsule (snapshot and physics). */
  movePawn(id: PawnId, position: Vec3): void {
    const rec = this.records.get(id);
    if (!rec) throw new Error(`Unknown pawn ${id}`);
    rec.state.position = { ...position };
    this.physics.setActorPosition(id, position);
    this.physics.step();
  }
}

/** An input command with the given buttons held and view angles. */
export function input(overrides: Partial<InputCommand> = {}): InputCommand {
  return { ...NULL_INPUT, ...overrides };
}
