import { describe, expect, it } from 'vitest';
import { clampSkill, skillProfile } from './skill';

describe('skill profiles', () => {
  it('clamps and rounds into 0–7, defaulting to Average', () => {
    expect(clampSkill(undefined)).toBe(2);
    expect(clampSkill(-3)).toBe(0);
    expect(clampSkill(12)).toBe(7);
    expect(clampSkill(3.4)).toBe(3);
    expect(clampSkill(Number.NaN)).toBe(2);
  });

  it('scales perception with level and never allows translocate links', () => {
    const novice = skillProfile(0);
    const godlike = skillProfile(7);
    expect(godlike.visionRange).toBeGreaterThan(novice.visionRange);
    expect(godlike.reactionSeconds).toBeLessThan(novice.reactionSeconds);
    expect(novice.allowedLinks.has('doubleJump')).toBe(false);
    expect(godlike.allowedLinks.has('doubleJump')).toBe(true);
    expect(godlike.allowedLinks.has('translocate')).toBe(false);
    expect(novice.pickupTiming).toBe(false);
    expect(godlike.pickupTiming).toBe(true);
  });
});
