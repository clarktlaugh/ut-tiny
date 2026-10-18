/**
 * Sound catalog (docs/DESIGN.md §8.4, §5, §6).
 *
 * Every sound the game plays has an id, a mix definition and a placeholder
 * synth recipe. Recorded assets replace a recipe by adding the id to
 * `SOUND_FILES`; the file is served from `public/sounds/`. The manifest is
 * explicit so the loader never probes for files that do not exist.
 */
import type { AnnouncerLine } from '../sim/types';
import type { SynthLayer } from './synth';

export const SOUND_IDS = [
  // Weapons (§5)
  'discThrow',
  'discRecall',
  'assaultFire',
  'assaultGrenade',
  'mineDeploy',
  'rocketFire',
  'sniperFire',
  'shockFire',
  'shockAlt',
  'redeemerFire',
  'weaponSwitch',
  // Impacts and explosions
  'impactBullet',
  'impactShock',
  'explosion',
  'shockCombo',
  'redeemerBlast',
  'projectileShotDown',
  'discDisrupted',
  // Bodies
  'hurt',
  'death',
  'respawn',
  'hitConfirm',
  // Pickups (§6)
  'pickupWeapon',
  'pickupAmmo',
  'pickupVial',
  'pickupHealth',
  'pickupShield',
  'pickupSuperShield',
  'pickupUDamage',
  'pickupRespawn',
  // Movement (§4)
  'footstep',
  'jump',
  'doubleJump',
  'dodge',
  'land',
  'landHard',
  'jumpPad',
  'teleportOut',
  'teleportIn',
] as const;

export type EffectSoundId = (typeof SOUND_IDS)[number];
/** Announcer assets are keyed by line name (§6, `AnnouncerLine`). */
export type AnnouncerSoundId = `announcer.${AnnouncerLine}`;
export type SoundId = EffectSoundId | AnnouncerSoundId;

export interface SoundDef {
  /** Linear gain before bus and cue volume. */
  volume: number;
  /** Simultaneous voices of this sound; the oldest is stolen past this. */
  maxVoices: number;
  /**
   * Distance (m) at which a positional sound plays at full volume. The giant
   * rooms (§3) need much larger values than Three.js's default of 1.
   */
  refDistance: number;
  /** Random playback-rate spread, ± fraction (0.05 = ±5 %). */
  rateJitter: number;
  /** Placeholder recipe, used until a file is listed in `SOUND_FILES`. */
  synth: readonly SynthLayer[];
}

/** Distance model for positional sources: tuned for 100 m rooms (§8.4). */
export const DISTANCE_MODEL = {
  model: 'inverse' as const,
  /** Lower than the Web Audio default of 1 so sounds carry across a room. */
  rolloffFactor: 0.35,
  /** Only used by the linear model; kept for completeness. */
  maxDistance: 250,
};

/** Recorded files that replace a placeholder recipe, relative to `public/sounds/`. */
export const SOUND_FILES: Partial<Record<SoundId, string>> = {};

/** URL under which a listed sound file is served. */
export function soundUrl(file: string, base = '/'): string {
  return `${base.endsWith('/') ? base : `${base}/`}sounds/${file}`;
}

const def = (
  synth: readonly SynthLayer[],
  volume: number,
  opts: Partial<Omit<SoundDef, 'synth' | 'volume'>> = {},
): SoundDef => ({
  volume,
  maxVoices: opts.maxVoices ?? 4,
  refDistance: opts.refDistance ?? 8,
  rateJitter: opts.rateJitter ?? 0.05,
  synth,
});

export const SOUNDS: Readonly<Record<EffectSoundId, SoundDef>> = {
  discThrow: def([{ wave: 'sine', freq: 900, freqEnd: 300, duration: 0.18, gain: 0.6 }], 0.6),
  discRecall: def([{ wave: 'sine', freq: 300, freqEnd: 1100, duration: 0.2, gain: 0.6 }], 0.6),
  assaultFire: def(
    [
      { wave: 'noise', freq: 3500, duration: 0.08 },
      { wave: 'square', freq: 160, freqEnd: 60, duration: 0.06, gain: 0.5 },
    ],
    0.7,
    { maxVoices: 6, refDistance: 10, rateJitter: 0.08 },
  ),
  assaultGrenade: def(
    [
      { wave: 'noise', freq: 900, duration: 0.15, gain: 0.8 },
      { wave: 'sine', freq: 220, freqEnd: 90, duration: 0.15 },
    ],
    0.8,
    { refDistance: 10 },
  ),
  mineDeploy: def(
    [
      { wave: 'square', freq: 500, duration: 0.05, gain: 0.4 },
      { wave: 'square', freq: 700, start: 0.06, duration: 0.05, gain: 0.4 },
    ],
    0.6,
  ),
  rocketFire: def(
    [
      { wave: 'noise', freq: 1200, duration: 0.35, attack: 0.01 },
      { wave: 'saw', freq: 120, freqEnd: 70, duration: 0.3, gain: 0.4 },
    ],
    0.9,
    { refDistance: 14 },
  ),
  sniperFire: def(
    [
      { wave: 'noise', freq: 5000, duration: 0.12 },
      { wave: 'sine', freq: 120, freqEnd: 40, duration: 0.4, gain: 0.8 },
    ],
    1,
    { refDistance: 18 },
  ),
  shockFire: def(
    [
      { wave: 'saw', freq: 1400, freqEnd: 200, duration: 0.3, gain: 0.5 },
      { wave: 'sine', freq: 700, freqEnd: 100, duration: 0.3, gain: 0.5 },
    ],
    0.8,
    { refDistance: 14 },
  ),
  shockAlt: def(
    [
      { wave: 'sine', freq: 200, freqEnd: 600, duration: 0.25, gain: 0.7 },
      { wave: 'triangle', freq: 400, freqEnd: 1200, duration: 0.25, gain: 0.3 },
    ],
    0.7,
    { refDistance: 12 },
  ),
  redeemerFire: def(
    [
      { wave: 'noise', freq: 600, duration: 1, attack: 0.05 },
      { wave: 'saw', freq: 80, freqEnd: 50, duration: 1, gain: 0.5 },
    ],
    1,
    { refDistance: 20, maxVoices: 2 },
  ),
  weaponSwitch: def(
    [
      { wave: 'square', freq: 1800, duration: 0.03, gain: 0.3 },
      { wave: 'noise', freq: 2500, start: 0.05, duration: 0.05, gain: 0.4 },
    ],
    0.5,
    { maxVoices: 2 },
  ),
  impactBullet: def([{ wave: 'noise', freq: 4000, duration: 0.05 }], 0.5, {
    maxVoices: 8,
    refDistance: 6,
    rateJitter: 0.15,
  }),
  impactShock: def(
    [
      { wave: 'sine', freq: 1200, freqEnd: 300, duration: 0.15, gain: 0.6 },
      { wave: 'noise', freq: 3000, duration: 0.08, gain: 0.5 },
    ],
    0.6,
    { refDistance: 8 },
  ),
  explosion: def(
    [
      { wave: 'noise', freq: 400, duration: 0.9, attack: 0.005 },
      { wave: 'sine', freq: 90, freqEnd: 30, duration: 0.7, gain: 0.9 },
    ],
    1,
    { maxVoices: 6, refDistance: 20, rateJitter: 0.1 },
  ),
  shockCombo: def(
    [
      { wave: 'noise', freq: 1500, duration: 0.7 },
      { wave: 'sine', freq: 600, freqEnd: 60, duration: 0.7, gain: 0.8 },
      { wave: 'saw', freq: 1200, freqEnd: 100, duration: 0.4, gain: 0.3 },
    ],
    1,
    { maxVoices: 3, refDistance: 22 },
  ),
  redeemerBlast: def(
    [
      { wave: 'noise', freq: 200, duration: 3, attack: 0.01 },
      { wave: 'sine', freq: 50, freqEnd: 20, duration: 2.5, gain: 1 },
    ],
    1,
    { maxVoices: 2, refDistance: 60, rateJitter: 0 },
  ),
  projectileShotDown: def(
    [
      { wave: 'noise', freq: 2000, duration: 0.2 },
      { wave: 'square', freq: 300, freqEnd: 100, duration: 0.15, gain: 0.4 },
    ],
    0.8,
    { refDistance: 12 },
  ),
  discDisrupted: def([{ wave: 'square', freq: 220, freqEnd: 180, duration: 0.4, gain: 0.5 }], 0.6),
  hurt: def(
    [
      { wave: 'saw', freq: 260, freqEnd: 180, duration: 0.18, gain: 0.6 },
      { wave: 'noise', freq: 1500, duration: 0.06, gain: 0.4 },
    ],
    0.7,
    { maxVoices: 3, rateJitter: 0.1 },
  ),
  death: def(
    [
      { wave: 'saw', freq: 300, freqEnd: 80, duration: 0.6, gain: 0.6 },
      { wave: 'noise', freq: 800, duration: 0.3, gain: 0.5 },
    ],
    0.9,
    { maxVoices: 3, refDistance: 10 },
  ),
  respawn: def(
    [
      { wave: 'sine', freq: 400, freqEnd: 900, duration: 0.4, gain: 0.5 },
      { wave: 'triangle', freq: 800, freqEnd: 1800, duration: 0.4, gain: 0.25 },
    ],
    0.6,
  ),
  hitConfirm: def([{ wave: 'triangle', freq: 1600, duration: 0.06 }], 0.6, {
    maxVoices: 2,
    rateJitter: 0,
  }),
  pickupWeapon: def(
    [
      { wave: 'square', freq: 400, duration: 0.06, gain: 0.4 },
      { wave: 'noise', freq: 3000, start: 0.04, duration: 0.12, gain: 0.5 },
    ],
    0.7,
  ),
  pickupAmmo: def(
    [
      { wave: 'square', freq: 900, duration: 0.04, gain: 0.3 },
      { wave: 'square', freq: 700, start: 0.05, duration: 0.05, gain: 0.3 },
    ],
    0.6,
  ),
  pickupVial: def([{ wave: 'sine', freq: 1200, freqEnd: 1600, duration: 0.12 }], 0.5),
  pickupHealth: def(
    [
      { wave: 'sine', freq: 600, duration: 0.1 },
      { wave: 'sine', freq: 900, start: 0.08, duration: 0.15 },
    ],
    0.6,
  ),
  pickupShield: def(
    [
      { wave: 'triangle', freq: 300, freqEnd: 700, duration: 0.3 },
      { wave: 'sine', freq: 1200, duration: 0.25, gain: 0.3 },
    ],
    0.7,
  ),
  pickupSuperShield: def(
    [
      { wave: 'triangle', freq: 200, freqEnd: 800, duration: 0.5 },
      { wave: 'sine', freq: 1600, start: 0.1, duration: 0.4, gain: 0.3 },
    ],
    0.8,
  ),
  pickupUDamage: def(
    [
      { wave: 'saw', freq: 110, freqEnd: 220, duration: 0.7, gain: 0.5 },
      { wave: 'square', freq: 55, duration: 0.7, gain: 0.3 },
    ],
    0.9,
    { refDistance: 14 },
  ),
  pickupRespawn: def([{ wave: 'sine', freq: 500, freqEnd: 1000, duration: 0.2, gain: 0.4 }], 0.4, {
    refDistance: 6,
  }),
  footstep: def([{ wave: 'noise', freq: 600, duration: 0.07, gain: 0.8 }], 0.4, {
    maxVoices: 8,
    refDistance: 4,
    rateJitter: 0.15,
  }),
  jump: def([{ wave: 'noise', freq: 900, duration: 0.08, gain: 0.6 }], 0.4, { refDistance: 5 }),
  doubleJump: def(
    [
      { wave: 'noise', freq: 1500, duration: 0.12, gain: 0.6 },
      { wave: 'sine', freq: 300, freqEnd: 600, duration: 0.12, gain: 0.3 },
    ],
    0.5,
    { refDistance: 6 },
  ),
  dodge: def([{ wave: 'noise', freq: 2500, freqEnd: 800, duration: 0.15 }], 0.5, {
    refDistance: 6,
  }),
  land: def([{ wave: 'noise', freq: 400, duration: 0.1 }], 0.5, { refDistance: 5 }),
  landHard: def(
    [
      { wave: 'noise', freq: 300, duration: 0.2 },
      { wave: 'sine', freq: 80, freqEnd: 40, duration: 0.2, gain: 0.8 },
    ],
    0.8,
    { refDistance: 8 },
  ),
  jumpPad: def(
    [
      { wave: 'sine', freq: 150, freqEnd: 900, duration: 0.35 },
      { wave: 'noise', freq: 2000, duration: 0.2, gain: 0.3 },
    ],
    0.8,
    { refDistance: 12 },
  ),
  teleportOut: def([{ wave: 'triangle', freq: 1500, freqEnd: 300, duration: 0.25 }], 0.6),
  teleportIn: def([{ wave: 'triangle', freq: 300, freqEnd: 1500, duration: 0.25 }], 0.6),
};

/** Announcer placeholder: a two-note chime whose pitch is derived from the line name. */
export const ANNOUNCER_DEF: Omit<SoundDef, 'synth'> = {
  volume: 1,
  maxVoices: 1,
  refDistance: 8,
  rateJitter: 0,
};

export function announcerSoundId(line: AnnouncerLine): AnnouncerSoundId {
  return `announcer.${line}`;
}

export function isAnnouncerSound(id: SoundId): id is AnnouncerSoundId {
  return id.startsWith('announcer.');
}

export function announcerSynth(line: string): SynthLayer[] {
  let h = 2166136261;
  for (let i = 0; i < line.length; i++) h = Math.imul(h ^ line.charCodeAt(i), 16777619);
  const base = 330 + ((h >>> 0) % 12) * 30;
  return [
    { wave: 'triangle', freq: base, duration: 0.18, gain: 0.7 },
    { wave: 'triangle', freq: base * 1.5, start: 0.16, duration: 0.3, gain: 0.7 },
  ];
}

/** Mix definition and recipe for any sound id. */
export function soundDef(id: SoundId): SoundDef {
  if (isAnnouncerSound(id)) {
    return { ...ANNOUNCER_DEF, synth: announcerSynth(id.slice('announcer.'.length)) };
  }
  return SOUNDS[id];
}
