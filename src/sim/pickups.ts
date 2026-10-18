/**
 * Pickups (docs/DESIGN.md §6, §8.1): health vials and packs, shields, UDamage,
 * ammo and weapons, their respawn timers and weapon stay.
 *
 * `PickupSystem` owns one `PickupState` entity per `MapDef.pickups` placement
 * and, once per tick, lets every live pawn that touches an available pickup
 * take it. Rules per kind (amounts and timers come from `src/data/pickups.ts`):
 *
 * | Pickup       | Taken when                     | Effect                         |
 * |--------------|--------------------------------|--------------------------------|
 * | healthVial   | health < 199                   | +5 health, cap 199             |
 * | healthPack   | health < 100                   | +25 health, cap 100            |
 * | shieldPack   | shield < 150                   | +50 shield, cap 150            |
 * | superShield  | shield < 150                   | +100 shield, cap 150           |
 * | udamage      | always                         | 2× damage for 30 s (extends)   |
 * | ammo         | that weapon's ammo < max       | `AmmoDef.perPickup`            |
 * | weapon       | weapon stay: once per life     | weapon + `AmmoDef.start`       |
 * |              | otherwise: not owned, or ammo < max                             |
 *
 * Health above 100 decays back at 1/s; that lives in `pawn.ts`
 * (`decayOverheal`), so vials only ever raise health.
 *
 * Weapon stay (`RulesConfig.weaponStay`, and `WeaponDef.weaponStay`): the
 * pickup never disappears; each pawn may take it once per life, recorded in
 * `PickupState.takenBy` and cleared when the pawn dies. Weapons without stay
 * (the Redeemer) and every weapon when the rule is off disappear and return
 * after `WeaponDef.respawnSeconds ?? PICKUPS.weapon.respawnSeconds`.
 *
 * FX hooks: a take emits `pickupTaken`, a return emits `pickupRespawned`; the
 * renderer and audio key their effects off those events and `PICKUP_FX`. The
 * update result also lists what each take granted (`PickupTake`) for HUD
 * pickup messages.
 *
 * Touching uses plain geometry, not the physics world: the pawn capsule
 * (center at `PawnState.position`) against a vertical cylinder around the
 * placement (`PICKUP_TRIGGER`). Pure sim code: no RNG, no wall-clock, and
 * results are ordered by pickup placement then pawn id, so the lowest pawn id
 * wins a tie.
 *
 * Per tick, after movement, the world calls:
 *
 * ```ts
 * const out = pickups.update(tick, pawnRecords);
 * events.push(...out.events);
 * ```
 *
 * and on every `death` event `pickups.onPawnDied(victim)` (dead pawns seen by
 * `update` are also cleared, so a missed call cannot leak weapon stay).
 */
import { PICKUPS, PICKUP_TRIGGER } from '../data/pickups';
import { addAmmo, giveWeapon, owns, type InventoryState, type WeaponTable } from './inventory';
import { PAWN_CAPSULE } from './physics/physicsWorld';
import {
  PAWN_STATS,
  TICK_RATE,
  type EntityId,
  type MapDef,
  type PawnId,
  type PawnState,
  type PickupDef,
  type PickupPlacement,
  type PickupState,
  type PickupType,
  type RulesConfig,
  type Seconds,
  type SimEvent,
  type Tick,
  type WeaponId,
} from './types';

export type PickupTable = Readonly<Record<PickupType, Readonly<PickupDef>>>;

/** What the system needs from a pawn: its public state and its inventory timer. */
export interface PickupPawn {
  state: PawnState;
  inventory: InventoryState;
}

/** What one take granted, for HUD messages and bots. */
export interface PickupTake {
  pawn: PawnId;
  pickup: EntityId;
  placementIndex: number;
  pickupType: PickupType;
  weapon?: WeaponId;
  /** Health, shield or ammo actually added, or UDamage seconds; 0 for a weapon already owned. */
  gained: number;
}

export interface PickupUpdate {
  /** `pickupRespawned` events first, then `pickupTaken` (each followed by any `weaponSwitched`). */
  events: SimEvent[];
  taken: PickupTake[];
}

export interface PickupSystemOptions {
  map: Pick<MapDef, 'pickups'>;
  rules: Readonly<Pick<RulesConfig, 'weaponStay' | 'udamageEnabled'>>;
  weapons: WeaponTable;
  /** Defaults to `PICKUPS` from `src/data/pickups.ts`. */
  pickups?: PickupTable;
  /** Entity id allocator owned by the world. */
  allocateId: () => EntityId;
}

/** Ticks for a duration in seconds. */
export function secondsToTicks(seconds: Seconds): number {
  return Math.max(0, Math.round(seconds * TICK_RATE));
}

/**
 * Seconds until a taken pickup returns, or `null` when it never disappears
 * (weapon stay). Exported for bots timing pickups and for tests.
 */
export function respawnSecondsFor(
  placement: Readonly<Pick<PickupPlacement, 'type' | 'weapon'>>,
  ctx: Readonly<{
    rules: Pick<RulesConfig, 'weaponStay'>;
    weapons: WeaponTable;
    pickups: PickupTable;
  }>,
): Seconds | null {
  const def = ctx.pickups[placement.type];
  if (placement.type !== 'weapon') return def.respawnSeconds;
  const weapon = ctx.weapons[requireWeapon(placement)];
  if (weapon.weaponStay && ctx.rules.weaponStay) return null;
  return weapon.respawnSeconds ?? def.respawnSeconds;
}

/** True when the pawn's capsule overlaps the pickup's trigger cylinder. */
export function touches(pawn: Readonly<PawnState>, pickup: Readonly<PickupState>): boolean {
  const dx = pawn.position.x - pickup.position.x;
  const dz = pawn.position.z - pickup.position.z;
  const reach = PICKUP_TRIGGER.radius + PAWN_CAPSULE.radius;
  if (dx * dx + dz * dz > reach * reach) return false;
  const pawnHalf = PAWN_CAPSULE.halfHeight + PAWN_CAPSULE.radius;
  return Math.abs(pawn.position.y - pickup.position.y) <= pawnHalf + PICKUP_TRIGGER.halfHeight;
}

export class PickupSystem {
  private readonly items: PickupState[] = [];
  private readonly byId = new Map<EntityId, PickupState>();
  private readonly rules: Readonly<Pick<RulesConfig, 'weaponStay' | 'udamageEnabled'>>;
  private readonly weapons: WeaponTable;
  private readonly defs: PickupTable;

  constructor(options: PickupSystemOptions) {
    this.rules = options.rules;
    this.weapons = options.weapons;
    this.defs = options.pickups ?? PICKUPS;
    options.map.pickups.forEach((placement, placementIndex) => {
      if (placement.type === 'udamage' && !options.rules.udamageEnabled) return;
      if (placement.type === 'weapon' || placement.type === 'ammo') requireWeapon(placement);
      const state: PickupState = {
        id: options.allocateId(),
        kind: 'pickup',
        position: { ...placement.position },
        placementIndex,
        type: placement.type,
        available: true,
        respawnAt: 0,
        takenBy: [],
      };
      if (placement.weapon !== undefined) state.weapon = placement.weapon;
      this.items.push(state);
      this.byId.set(state.id, state);
    });
  }

  /** Every pickup entity, in placement order. Callers must treat them as read-only. */
  states(): readonly PickupState[] {
    return this.items;
  }

  get(id: EntityId): Readonly<PickupState> | undefined {
    return this.byId.get(id);
  }

  /** `entitySpawned` events for every pickup, for the world's first tick. */
  spawnEvents(tick: Tick): SimEvent[] {
    return this.items.map((p) => ({ type: 'entitySpawned', tick, id: p.id, kind: 'pickup' }));
  }

  /** Seconds until `pickup` returns after a take, or null for weapon stay. */
  respawnSeconds(pickup: Readonly<PickupState>): Seconds | null {
    return respawnSecondsFor(pickup, {
      rules: this.rules,
      weapons: this.weapons,
      pickups: this.defs,
    });
  }

  /**
   * Whether `pawn` would take `pickup` if it touched it now: alive, pickup
   * available, and the pickup would do something for it (table above).
   */
  canTake(pawn: Readonly<PawnState>, pickup: Readonly<PickupState>): boolean {
    if (!pawn.alive || !pickup.available) return false;
    const def = this.defs[pickup.type];
    switch (pickup.type) {
      case 'healthVial':
      case 'healthPack':
        return pawn.health < (def.cap ?? PAWN_STATS.healthMax);
      case 'shieldPack':
      case 'superShield':
        return pawn.shield < (def.cap ?? PAWN_STATS.shieldMax);
      case 'udamage':
        return true;
      case 'ammo': {
        const weapon = requireWeapon(pickup);
        const ammo = this.weapons[weapon].ammo;
        return ammo !== null && (pawn.ammo[weapon] ?? 0) < ammo.max;
      }
      case 'weapon': {
        if (this.respawnSeconds(pickup) === null) return !pickup.takenBy.includes(pawn.id);
        const weapon = requireWeapon(pickup);
        const ammo = this.weapons[weapon].ammo;
        if (!owns(pawn, weapon)) return true;
        return ammo !== null && (pawn.ammo[weapon] ?? 0) < ammo.max;
      }
    }
  }

  /**
   * One tick: return pickups whose timer is up, clear weapon stay for dead
   * pawns, then let each live pawn take what it touches.
   */
  update(tick: Tick, pawns: Iterable<PickupPawn>): PickupUpdate {
    const out: PickupUpdate = { events: [], taken: [] };
    for (const p of this.items) {
      if (!p.available && tick >= p.respawnAt) {
        p.available = true;
        p.respawnAt = 0;
        out.events.push({ type: 'pickupRespawned', tick, pickup: p.id, pickupType: p.type });
      }
    }

    const live: PickupPawn[] = [];
    for (const pawn of pawns) {
      if (pawn.state.alive) live.push(pawn);
      else this.onPawnDied(pawn.state.id);
    }
    live.sort((a, b) => a.state.id - b.state.id);

    for (const p of this.items) {
      for (const pawn of live) {
        if (!p.available) break;
        if (!touches(pawn.state, p) || !this.canTake(pawn.state, p)) continue;
        this.take(tick, pawn, p, out);
      }
    }
    return out;
  }

  /** A pawn died: it may take each weapon-stay pickup again next life. */
  onPawnDied(pawn: PawnId): void {
    for (const p of this.items) {
      if (p.takenBy.length > 0 && p.takenBy.includes(pawn)) {
        p.takenBy = p.takenBy.filter((id) => id !== pawn);
      }
    }
  }

  /** A pawn left the match. */
  removePawn(pawn: PawnId): void {
    this.onPawnDied(pawn);
  }

  private take(tick: Tick, pawn: PickupPawn, p: PickupState, out: PickupUpdate): void {
    const s = pawn.state;
    const def = this.defs[p.type];
    let gained = 0;
    const extra: SimEvent[] = [];
    switch (p.type) {
      case 'healthVial':
      case 'healthPack': {
        const cap = def.cap ?? PAWN_STATS.healthMax;
        const next = Math.min(cap, s.health + def.amount);
        gained = next - s.health;
        s.health = next;
        break;
      }
      case 'shieldPack':
      case 'superShield': {
        const cap = Math.min(def.cap ?? PAWN_STATS.shieldMax, PAWN_STATS.shieldMax);
        const next = Math.min(cap, s.shield + def.amount);
        gained = next - s.shield;
        s.shield = next;
        break;
      }
      case 'udamage': {
        const ticks = secondsToTicks(def.amount);
        s.udamageUntil = Math.max(s.udamageUntil, tick) + ticks;
        gained = def.amount;
        break;
      }
      case 'ammo': {
        const weapon = requireWeapon(p);
        const ammo = this.weapons[weapon].ammo;
        gained = ammo === null ? 0 : addAmmo(s, weapon, ammo.perPickup, this.weapons);
        break;
      }
      case 'weapon': {
        const weapon = requireWeapon(p);
        const before = s.ammo[weapon] ?? 0;
        extra.push(...giveWeapon(s, pawn.inventory, weapon, tick, this.weapons));
        gained = (s.ammo[weapon] ?? 0) - before;
        break;
      }
    }

    const stays = this.respawnSeconds(p);
    if (stays === null) {
      p.takenBy.push(s.id);
    } else {
      p.available = false;
      p.respawnAt = tick + Math.max(1, secondsToTicks(stays));
    }

    out.events.push({ type: 'pickupTaken', tick, pawn: s.id, pickup: p.id, pickupType: p.type });
    out.events.push(...extra);
    const record: PickupTake = {
      pawn: s.id,
      pickup: p.id,
      placementIndex: p.placementIndex,
      pickupType: p.type,
      gained,
    };
    if (p.weapon !== undefined) record.weapon = p.weapon;
    out.taken.push(record);
  }
}

function requireWeapon(p: Readonly<{ type: PickupType; weapon?: WeaponId }>): WeaponId {
  if (p.weapon === undefined) throw new Error(`${p.type} pickup needs a weapon`);
  return p.weapon;
}
