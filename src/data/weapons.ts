/**
 * Weapon data table (docs/DESIGN.md §5). One row per `WeaponId`; behaviors live
 * in `src/sim/weapons/core/` and the per-weapon modules P14+ add.
 *
 * Units: seconds, meters, m/s, radians. Momentum is an impulse on a pawn of
 * mass 1 (`PAWN_MASS` in `src/sim/damage.ts`), so it reads as a velocity change
 * in m/s at the center of a splash or on a direct hit.
 *
 * Ammo is one pool per weapon (`PawnState.ammo`). The assault rifle's grenades
 * draw from the bullet pool at 25 bullets each, which reproduces §5's
 * 100 / 200 bullets ↔ 4 / 8 grenades exactly.
 */
import type { FireModeDef, WeaponDef, WeaponId } from '../sim/types';

/** Switch time shared by every weapon (§5 common rules). */
export const WEAPON_SWITCH_TIME = 0.3;

/** Bullets one assault-rifle grenade costs (100 bullets = 4 grenades, §5). */
export const GRENADE_BULLET_COST = 25;

/** Instagib beam, shared by both Super Shock Rifles and both of their fire modes. */
const SHOCK_BEAM: FireModeDef = {
  behavior: 'hitscan',
  rate: 0.75,
  ammoPerShot: 0,
  damage: 1000,
  headshotMultiplier: 1,
  momentum: 6,
};

/** Rocket: 27 m/s, 90 direct, 4.4 m splash, hold to load three (§5). */
const ROCKET: FireModeDef = {
  behavior: 'projectile',
  rate: 0.92,
  ammoPerShot: 1,
  damage: 90,
  projectileSpeed: 27,
  splashRadius: 4.4,
  splashDamage: 90,
  momentum: 10,
  /** Fan step between loaded rockets (≈3.4°). */
  spread: 0.06,
  loadMax: 3,
  loadTime: 0.95,
};

/** Redeemer warhead: 20 m/s, 250 at the center of a 50 m blast, 50 hp (§5). */
const WARHEAD: FireModeDef = {
  behavior: 'projectile',
  rate: 1,
  ammoPerShot: 1,
  damage: 250,
  projectileSpeed: 20,
  splashRadius: 50,
  splashDamage: 250,
  momentum: 20,
  projectileHealth: 50,
};

export const WEAPONS: Readonly<Record<WeaponId, WeaponDef>> = Object.freeze({
  teleporter: {
    id: 'teleporter',
    slot: 1,
    primary: {
      behavior: 'lob',
      rate: 0.25,
      ammoPerShot: 0,
      damage: 0,
      projectileSpeed: 28,
    },
    /** Teleport to the disc; 1 s recharge (§5). The teleporter module implements it. */
    alt: { behavior: 'action', rate: 1, ammoPerShot: 0, damage: 0 },
    ammo: null,
    switchTime: WEAPON_SWITCH_TIME,
    weaponStay: true,
    priority: 1,
  },
  assault: {
    id: 'assault',
    slot: 2,
    primary: {
      behavior: 'hitscan',
      rate: 0.1,
      ammoPerShot: 1,
      damage: 7,
      momentum: 0.5,
      /** Full spread half-angle (≈3°) once the heat is up; see `fireControl.ts`. */
      spread: 0.05,
    },
    alt: {
      behavior: 'lob',
      rate: 0.6,
      ammoPerShot: GRENADE_BULLET_COST,
      damage: 60,
      projectileSpeed: 22,
      splashRadius: 3.5,
      splashDamage: 60,
      momentum: 8,
      fuse: 2.5,
    },
    ammo: { start: 100, max: 200, perPickup: 50 },
    switchTime: WEAPON_SWITCH_TIME,
    weaponStay: true,
    priority: 2,
  },
  mines: {
    id: 'mines',
    slot: 3,
    primary: {
      behavior: 'lob',
      rate: 0.5,
      ammoPerShot: 1,
      damage: 80,
      projectileSpeed: 15,
      splashRadius: 5,
      splashDamage: 80,
      momentum: 9,
      maxDeployed: 4,
    },
    /** Detonate all deployed mines. The mines module implements it. */
    alt: { behavior: 'action', rate: 0.5, ammoPerShot: 0, damage: 0 },
    ammo: { start: 8, max: 16, perPickup: 4 },
    switchTime: WEAPON_SWITCH_TIME,
    weaponStay: true,
    priority: 3,
  },
  rocket: {
    id: 'rocket',
    slot: 4,
    primary: ROCKET,
    /** Same loading, tight spiral; grenade-mode toggle. The rocket module shapes the salvo. */
    alt: { ...ROCKET },
    ammo: { start: 12, max: 30, perPickup: 9 },
    switchTime: WEAPON_SWITCH_TIME,
    weaponStay: true,
    priority: 6,
  },
  sniper: {
    id: 'sniper',
    slot: 5,
    primary: {
      behavior: 'hitscan',
      rate: 1.33,
      ammoPerShot: 1,
      damage: 70,
      headshotMultiplier: 2,
      momentum: 2,
    },
    alt: { behavior: 'action', rate: 0, ammoPerShot: 0, damage: 0, zoom: { min: 2, max: 8 } },
    ammo: { start: 20, max: 40, perPickup: 10 },
    switchTime: WEAPON_SWITCH_TIME,
    weaponStay: true,
    priority: 5,
  },
  shock: {
    id: 'shock',
    slot: 6,
    primary: SHOCK_BEAM,
    /** Pure instagib: alt fire is the same beam (§5). */
    alt: { ...SHOCK_BEAM },
    ammo: null,
    switchTime: WEAPON_SWITCH_TIME,
    weaponStay: true,
    priority: 7,
  },
  shockScoped: {
    id: 'shockScoped',
    slot: 7,
    primary: { ...SHOCK_BEAM },
    alt: { behavior: 'action', rate: 0, ammoPerShot: 0, damage: 0, zoom: { min: 2, max: 6 } },
    ammo: null,
    switchTime: WEAPON_SWITCH_TIME,
    weaponStay: true,
    priority: 8,
  },
  redeemer: {
    id: 'redeemer',
    slot: 8,
    primary: WARHEAD,
    /** Guided from the nose camera (§5.1). The redeemer module spawns it guided. */
    alt: { ...WARHEAD },
    ammo: { start: 1, max: 1, perPickup: 1 },
    switchTime: WEAPON_SWITCH_TIME,
    weaponStay: false,
    respawnSeconds: 60,
    priority: 9,
  },
});
