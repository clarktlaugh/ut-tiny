/**
 * SimEvent → sound cue mapping (docs/DESIGN.md §8.1, §8.4).
 *
 * Pure and DOM-free so it can be unit tested and run on any client. Rules:
 *
 * - Sounds made by the local pawn (its weapon, footsteps, pain, pickups) go to
 *   the non-positional `local` bus; the same sounds from anyone else go to
 *   the positional `world` bus at the event's position.
 * - A `world` cue always carries a position; when none can be resolved the
 *   cue is dropped rather than played at the origin.
 * - Hit confirmation (§5: audio only) is one `ui` cue per batch when the local
 *   pawn damages someone else.
 * - Announcer lines play on the `announcer` bus when addressed to everyone or
 *   to the local pawn.
 * - Playback-rate jitter is derived from the event, not `Math.random()`, so a
 *   given event always sounds the same (and tests are stable).
 */
import {
  NO_ENTITY,
  type DamageType,
  type EntityId,
  type PawnId,
  type PickupType,
  type SimEvent,
  type Vec3,
  type WeaponId,
} from '../sim/types';
import type { Bus } from './buses';
import { announcerSoundId, soundDef, type EffectSoundId, type SoundId } from './sounds';

export interface SoundCue {
  sound: SoundId;
  bus: Bus;
  /** World position for `world` cues; absent for every other bus. */
  position?: Vec3;
  /** Cue gain, multiplied with the sound's own volume. */
  volume: number;
  /** Playback rate (1 = recorded pitch). */
  rate: number;
}

export interface CueContext {
  /** The local participant's pawn, or NO_ENTITY when spectating / headless. */
  localPawn: PawnId;
  /** Current (or last known) position of an entity, if any. */
  positionOf(id: EntityId): Vec3 | undefined;
}

/** Weapon fire sounds per mode (§5). */
export const FIRE_SOUNDS: Readonly<
  Record<WeaponId, { primary: EffectSoundId; alt: EffectSoundId }>
> = {
  teleporter: { primary: 'discThrow', alt: 'discRecall' },
  assault: { primary: 'assaultFire', alt: 'assaultGrenade' },
  mines: { primary: 'mineDeploy', alt: 'mineDeploy' },
  rocket: { primary: 'rocketFire', alt: 'rocketFire' },
  sniper: { primary: 'sniperFire', alt: 'sniperFire' },
  shock: { primary: 'shockFire', alt: 'shockAlt' },
  shockScoped: { primary: 'shockFire', alt: 'shockFire' },
  redeemer: { primary: 'redeemerFire', alt: 'redeemerFire' },
};

/** Impact sound where a hitscan trace ends. */
export const HITSCAN_IMPACT: Readonly<Partial<Record<WeaponId, EffectSoundId>>> = {
  assault: 'impactBullet',
  sniper: 'impactBullet',
  shock: 'impactShock',
  shockScoped: 'impactShock',
};

/** Explosion sound by damage type; types not listed use `explosion`. */
export const EXPLOSION_SOUNDS: Readonly<Partial<Record<DamageType, EffectSoundId>>> = {
  shock: 'shockCombo',
  redeemer: 'redeemerBlast',
};

export const PICKUP_SOUNDS: Readonly<Record<PickupType, EffectSoundId>> = {
  weapon: 'pickupWeapon',
  ammo: 'pickupAmmo',
  healthVial: 'pickupVial',
  healthPack: 'pickupHealth',
  shieldPack: 'pickupShield',
  superShield: 'pickupSuperShield',
  udamage: 'pickupUDamage',
};

/** Landing below this impact speed (m/s) is silent. */
export const LAND_SILENT_SPEED = 4;
/** Landing at or above this speed uses `landHard` (matches fall damage onset, §4). */
export const LAND_HARD_SPEED = 20;
/** Local footsteps are quieter than other pawns' at reference distance. */
export const LOCAL_FOOTSTEP_VOLUME = 0.5;
/** Explosion radius (m) that plays at full cue volume; smaller blasts are quieter. */
export const EXPLOSION_FULL_RADIUS = 6;

/** Map one batch of events (usually one tick's) to sound cues, in event order. */
export function cuesForEvents(events: readonly SimEvent[], ctx: CueContext): SoundCue[] {
  const out: SoundCue[] = [];
  let confirmed = false;
  for (const e of events) {
    if (
      e.type === 'damage' &&
      !confirmed &&
      ctx.localPawn !== NO_ENTITY &&
      e.instigator === ctx.localPawn &&
      e.target !== ctx.localPawn
    ) {
      confirmed = true;
      out.push(cue('hitConfirm', 'ui', undefined, 1, e));
    }
    cuesForEvent(e, ctx, out);
  }
  return out;
}

/** Map a single event to zero or more cues, appended to `out`. Hit confirmation is batch-level. */
export function cuesForEvent(e: SimEvent, ctx: CueContext, out: SoundCue[] = []): SoundCue[] {
  const local = ctx.localPawn;
  const isLocal = (pawn: PawnId): boolean => local !== NO_ENTITY && pawn === local;

  /** A sound made by `pawn`: local bus for the local pawn, world bus at `at` otherwise. */
  const byPawn = (sound: EffectSoundId, pawn: PawnId, at?: Vec3, volume = 1): void => {
    if (isLocal(pawn)) out.push(cue(sound, 'local', undefined, volume, e));
    else world(sound, at ?? ctx.positionOf(pawn), volume);
  };
  const world = (sound: EffectSoundId, at: Vec3 | undefined, volume = 1): void => {
    if (at) out.push(cue(sound, 'world', at, volume, e));
  };

  switch (e.type) {
    case 'shotFired':
      byPawn(FIRE_SOUNDS[e.weapon][e.mode], e.pawn, e.origin);
      break;
    case 'hitscan': {
      const impact = HITSCAN_IMPACT[e.weapon];
      if (impact) world(impact, e.to);
      break;
    }
    case 'explosion': {
      const sound = EXPLOSION_SOUNDS[e.damageType] ?? 'explosion';
      const volume = Math.min(1, Math.max(0.4, e.radius / EXPLOSION_FULL_RADIUS));
      world(sound, e.position, volume);
      break;
    }
    case 'damage':
      if (e.amount > 0) byPawn('hurt', e.target);
      break;
    case 'death':
      byPawn('death', e.victim);
      break;
    case 'respawn':
      byPawn('respawn', e.pawn, e.pose.position);
      break;
    case 'pickupTaken':
      byPawn(PICKUP_SOUNDS[e.pickupType], e.pawn, ctx.positionOf(e.pickup));
      break;
    case 'pickupRespawned':
      world('pickupRespawn', ctx.positionOf(e.pickup));
      break;
    case 'weaponSwitched':
      if (isLocal(e.pawn)) out.push(cue('weaponSwitch', 'local', undefined, 1, e));
      break;
    case 'jumpPad':
      byPawn('jumpPad', e.pawn, ctx.positionOf(e.pad) ?? ctx.positionOf(e.pawn));
      break;
    case 'footstep':
      byPawn('footstep', e.pawn, e.position, isLocal(e.pawn) ? LOCAL_FOOTSTEP_VOLUME : 1);
      break;
    case 'jump':
      byPawn(e.double ? 'doubleJump' : 'jump', e.pawn);
      break;
    case 'dodge':
      byPawn('dodge', e.pawn);
      break;
    case 'land':
      if (e.impactSpeed >= LAND_HARD_SPEED) byPawn('landHard', e.pawn);
      else if (e.impactSpeed >= LAND_SILENT_SPEED) {
        byPawn('land', e.pawn, undefined, e.impactSpeed / LAND_HARD_SPEED);
      }
      break;
    case 'teleport':
      // The local player hears its arrival up close; everyone else hears both ends.
      if (isLocal(e.pawn)) {
        out.push(cue('teleportIn', 'local', undefined, 1, e));
      } else {
        world('teleportOut', e.from);
        world('teleportIn', e.to);
      }
      break;
    case 'projectileDestroyed':
      world('projectileShotDown', ctx.positionOf(e.id));
      break;
    case 'discDisrupted':
      world('discDisrupted', ctx.positionOf(e.disc));
      break;
    case 'announcer':
      if (e.toPawn === NO_ENTITY || isLocal(e.toPawn)) {
        out.push(cue(announcerSoundId(e.line), 'announcer', undefined, 1, e));
      }
      break;
    case 'entitySpawned':
    case 'entityDestroyed':
    case 'guidanceStarted':
    case 'guidanceEnded':
    case 'score':
    case 'matchPhase':
      break;
  }
  return out;
}

function cue(
  sound: SoundId,
  bus: Bus,
  position: Vec3 | undefined,
  volume: number,
  e: SimEvent,
): SoundCue {
  const jitter = soundDef(sound).rateJitter;
  const rate = jitter > 0 ? 1 + jitter * (hash01(e, sound) * 2 - 1) : 1;
  const c: SoundCue = { sound, bus, volume, rate };
  if (position) c.position = { x: position.x, y: position.y, z: position.z };
  return c;
}

/** Stable 0..1 value from an event and a sound id. */
export function hash01(e: SimEvent, sound: string): number {
  let h = Math.imul(e.tick + 1, 0x9e3779b1);
  const who = 'pawn' in e ? e.pawn : 'target' in e ? e.target : 'victim' in e ? e.victim : 0;
  h = Math.imul(h ^ (who + 0x7f4a7c15), 0x85ebca6b);
  for (let i = 0; i < sound.length; i++) h = Math.imul(h ^ sound.charCodeAt(i), 16777619);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
