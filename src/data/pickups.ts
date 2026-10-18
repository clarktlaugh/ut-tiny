/**
 * Pickup data table (docs/DESIGN.md §6). One row per `PickupType`; the
 * behavior lives in `src/sim/pickups.ts`.
 *
 * Conventions for the `weapon` and `ammo` rows, whose real amounts are per
 * weapon and come from the weapon table (`src/data/weapons.ts`):
 * - `weapon`: `amount` is unused (a weapon pickup grants `AmmoDef.start`).
 *   `respawnSeconds` is the timer used when the pickup does not stay: weapon
 *   stay is off in the rules, or the weapon has `weaponStay: false`, in which
 *   case `WeaponDef.respawnSeconds` wins (Redeemer: 60 s).
 * - `ammo`: `amount` is unused (an ammo pickup grants `AmmoDef.perPickup`).
 *
 * `PICKUP_FX` is the presentation side: the keys the renderer and audio use
 * when they see `pickupTaken` / `pickupRespawned` events. The sim never reads it.
 */
import type { PickupDef, PickupType } from '../sim/types';

/** Health vials and packs, shields, UDamage, ammo and weapons (§6 table). */
export const PICKUPS: Readonly<Record<PickupType, PickupDef>> = Object.freeze({
  weapon: { type: 'weapon', amount: 0, respawnSeconds: 30 },
  ammo: { type: 'ammo', amount: 0, respawnSeconds: 30 },
  healthVial: { type: 'healthVial', amount: 5, cap: 199, respawnSeconds: 27 },
  healthPack: { type: 'healthPack', amount: 25, cap: 100, respawnSeconds: 20 },
  shieldPack: { type: 'shieldPack', amount: 50, cap: 150, respawnSeconds: 30 },
  superShield: { type: 'superShield', amount: 100, cap: 150, respawnSeconds: 60 },
  /** `amount` is seconds of double damage. */
  udamage: { type: 'udamage', amount: 30, respawnSeconds: 90 },
});

/**
 * Pickup trigger: a vertical cylinder around `PickupPlacement.position`. A pawn
 * touches it when its capsule (radius 0.4 m) overlaps the cylinder. Placements
 * sit about 1 m above the surface they rest on, so `halfHeight` reaches the floor.
 */
export const PICKUP_TRIGGER = Object.freeze({ radius: 0.6, halfHeight: 1 });

/** Presentation keys for one pickup kind (renderer and audio, not the sim). */
export interface PickupFxDef {
  /** Mesh or placeholder key for the pickup's model. */
  model: string;
  /** Glow / tint color, 0xRRGGBB. */
  color: number;
  /** Sound played to the taker on `pickupTaken`. */
  takeSound: string;
  /** Positional sound played where the pickup reappears on `pickupRespawned`. */
  respawnSound: string;
  /** Idle spin, radians per second (0 = static). */
  spin: number;
  /** Idle bob amplitude, meters. */
  bob: number;
}

export const PICKUP_FX: Readonly<Record<PickupType, PickupFxDef>> = Object.freeze({
  weapon: {
    model: 'pickup/weapon',
    color: 0xffffff,
    takeSound: 'pickup/weapon',
    respawnSound: 'pickup/respawn',
    spin: 1.5,
    bob: 0.1,
  },
  ammo: {
    model: 'pickup/ammo',
    color: 0xd9b23a,
    takeSound: 'pickup/ammo',
    respawnSound: 'pickup/respawn',
    spin: 0,
    bob: 0,
  },
  healthVial: {
    model: 'pickup/vial',
    color: 0x3a8cff,
    takeSound: 'pickup/vial',
    respawnSound: 'pickup/respawn',
    spin: 1,
    bob: 0.05,
  },
  healthPack: {
    model: 'pickup/healthPack',
    color: 0x3aff6b,
    takeSound: 'pickup/health',
    respawnSound: 'pickup/respawn',
    spin: 1,
    bob: 0.1,
  },
  shieldPack: {
    model: 'pickup/shield',
    color: 0xffd23a,
    takeSound: 'pickup/shield',
    respawnSound: 'pickup/respawnArmor',
    spin: 1.2,
    bob: 0.1,
  },
  superShield: {
    model: 'pickup/superShield',
    color: 0xff8a1f,
    takeSound: 'pickup/superShield',
    respawnSound: 'pickup/respawnArmor',
    spin: 1.2,
    bob: 0.15,
  },
  udamage: {
    model: 'pickup/udamage',
    color: 0xa23aff,
    takeSound: 'pickup/udamage',
    respawnSound: 'pickup/respawnUdamage',
    spin: 2,
    bob: 0.15,
  },
});
