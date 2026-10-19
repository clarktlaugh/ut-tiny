/**
 * Bot skill levels (docs/DESIGN.md §9): Novice → Godlike, 0–7. The level maps
 * to perception, memory, reaction and which navmesh links the bot may use.
 * Aim error and combat movement come with P22; this packet only reads the
 * fields it needs for navigation and perception.
 */
import type { NavLinkKind } from '../../sim/types';

export const SKILL_NAMES = [
  'Novice',
  'Average',
  'Experienced',
  'Skilled',
  'Adept',
  'Masterful',
  'Inhuman',
  'Godlike',
] as const;

export type SkillLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface SkillProfile {
  level: SkillLevel;
  name: (typeof SKILL_NAMES)[number];
  /** How far the bot can spot an enemy, m. */
  visionRange: number;
  /** Full vision cone, radians (§9: 120°). */
  visionCone: number;
  /** Radius within which weapon fire and footsteps are heard, m. */
  hearingRange: number;
  /** Seconds a last-known position is kept after losing sight (§9: 4). */
  memorySeconds: number;
  /** Seconds between first seeing an enemy and acting on it. */
  reactionSeconds: number;
  /** Whether the bot plans trips around pickup respawn timers. */
  pickupTiming: boolean;
  /** Off-mesh link kinds the bot may path through. */
  allowedLinks: ReadonlySet<NavLinkKind>;
}

/** Clamp any skill number into a level; `undefined` is Average. */
export function clampSkill(skill: number | undefined): SkillLevel {
  if (skill === undefined || !Number.isFinite(skill)) return 2;
  return Math.min(7, Math.max(0, Math.round(skill))) as SkillLevel;
}

/**
 * Profile for a skill level. Translocate links need the translocator tactics
 * from M4 and are left out for every level here.
 */
export function skillProfile(skill: number | undefined): SkillProfile {
  const level = clampSkill(skill);
  const links = new Set<NavLinkKind>(['pad', 'jump', 'drop']);
  if (level >= 1) links.add('doubleJump');
  return {
    level,
    name: SKILL_NAMES[level],
    visionRange: 40 + 10 * level,
    visionCone: (120 * Math.PI) / 180,
    hearingRange: 25 + 5 * level,
    memorySeconds: 4,
    reactionSeconds: 0.5 - 0.06 * level,
    pickupTiming: level >= 3,
    allowedLinks: links,
  };
}
