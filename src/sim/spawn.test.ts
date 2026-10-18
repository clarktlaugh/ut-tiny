import { describe, expect, it } from 'vitest';
import { Rng } from './rng';
import {
  FORCED_RESPAWN_SECONDS,
  SpawnSelector,
  forcedRespawnAt,
  isSpawnProtected,
  planRespawn,
  respawnAllowedAt,
  shouldRespawn,
  spawnProtectionAfterInput,
} from './spawn';
import { Buttons, TICK_RATE, type Pose, type RulesConfig } from './types';

const rules: RulesConfig = {
  fragLimit: 20,
  timeLimit: 600,
  weaponStay: true,
  spawnProtection: 2,
  respawnDelay: 1,
  udamageEnabled: false,
};

const pose = (x: number, z: number, y = 0): Pose => ({ position: { x, y, z }, yaw: 0, pitch: 0 });

/** Four corners of a 40 × 40 room plus the middle. */
const SPAWNS = [pose(-20, -20), pose(20, -20), pose(-20, 20), pose(20, 20), pose(0, 0)];

describe('spawn selection', () => {
  it('picks the spawn farthest from enemies', () => {
    const selector = new SpawnSelector(SPAWNS, { noise: 0 });
    // Enemy near the (-20, -20) corner: the opposite corner is farthest.
    const pick = selector.pick(0, { enemies: [{ x: -18, y: 0.9, z: -18 }] }, new Rng(1));
    expect(pick.index).toBe(3);
    expect(pick.pose).toEqual(SPAWNS[3]);
  });

  it('maximises the distance to the nearest of several enemies', () => {
    const selector = new SpawnSelector(SPAWNS, { noise: 0 });
    const enemies = [
      { x: 20, y: 0.9, z: 20 },
      { x: 20, y: 0.9, z: -20 },
      { x: -20, y: 0.9, z: 18 },
    ];
    expect(selector.pick(0, { enemies }, new Rng(1)).index).toBe(0);
  });

  it('still picks the farthest spawn with default noise, for any seed', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const selector = new SpawnSelector(SPAWNS);
      const pick = selector.pick(0, { enemies: [{ x: -20, y: 0.9, z: -19 }] }, new Rng(seed));
      expect(pick.index).toBe(3);
    }
  });

  it('noise varies the choice among equally good spawns', () => {
    const picks = new Set<number>();
    for (let seed = 1; seed <= 50; seed++) {
      picks.add(new SpawnSelector(SPAWNS).pick(0, { enemies: [] }, new Rng(seed)).index);
    }
    expect(picks.size).toBeGreaterThan(2);
  });

  it('is deterministic for a seed', () => {
    const a = new SpawnSelector(SPAWNS).pick(0, { enemies: [] }, new Rng(42));
    const b = new SpawnSelector(SPAWNS).pick(0, { enemies: [] }, new Rng(42));
    expect(a).toEqual(b);
  });

  it('penalises recently used spawns, fading over recencySeconds', () => {
    const selector = new SpawnSelector([pose(0, 0), pose(10, 0)], { noise: 0 });
    selector.markUsed(0, 0);
    const query = { enemies: [] };
    expect(selector.pick(TICK_RATE, query, new Rng(1)).index).toBe(1);
    // Long after, both are fresh again; spawn 1 was just used so spawn 0 wins.
    expect(selector.pick(TICK_RATE * 30, query, new Rng(1)).index).toBe(0);
  });

  it('skips blocked spawns', () => {
    const selector = new SpawnSelector(SPAWNS, { noise: 0 });
    const enemies = [{ x: -18, y: 0.9, z: -18 }];
    const occupied = [...enemies, { x: 20.3, y: 0.9, z: 20 }];
    const pick = selector.pick(0, { enemies, occupied }, new Rng(1));
    expect(pick.index).not.toBe(3);
    expect([1, 2]).toContain(pick.index);
  });

  it('avoids spawns an enemy can see', () => {
    const selector = new SpawnSelector([pose(0, 0), pose(5, 0)], { noise: 0 });
    const enemies = [{ x: 30, y: 0.9, z: 0 }];
    // Spawn 0 is farther but in view; spawn 1 is behind cover.
    const canSee = (_from: unknown, to: { x: number }) => to.x === 0;
    expect(selector.pick(0, { enemies, canSee }, new Rng(1)).index).toBe(1);
    expect(
      new SpawnSelector([pose(0, 0), pose(5, 0)], { noise: 0 }).pick(0, { enemies }, new Rng(1))
        .index,
    ).toBe(0);
  });

  it('rejects maps without spawns', () => {
    expect(() => new SpawnSelector([])).toThrow();
  });
});

describe('respawn timing and protection', () => {
  it('allows respawn after respawnDelay with fire and forces it at 2 s', () => {
    const respawnAt = respawnAllowedAt(100, rules);
    expect(respawnAt).toBe(100 + TICK_RATE);
    const dead = { alive: false, respawnAt };
    const idle = { buttons: 0 };
    const fire = { buttons: Buttons.Fire };
    expect(shouldRespawn(dead, respawnAt - 1, fire, rules)).toBe(false);
    expect(shouldRespawn(dead, respawnAt, fire, rules)).toBe(true);
    expect(shouldRespawn(dead, respawnAt, idle, rules)).toBe(false);
    const forced = forcedRespawnAt(respawnAt, rules);
    expect(forced).toBe(100 + FORCED_RESPAWN_SECONDS * TICK_RATE);
    expect(shouldRespawn(dead, forced - 1, idle, rules)).toBe(false);
    expect(shouldRespawn(dead, forced, idle, rules)).toBe(true);
    expect(shouldRespawn({ alive: true, respawnAt }, forced, fire, rules)).toBe(false);
  });

  it('protects for spawnProtection seconds unless the pawn fires', () => {
    const selector = new SpawnSelector(SPAWNS, { noise: 0 });
    const plan = planRespawn(
      9,
      500,
      selector,
      { enemies: [{ x: 0, y: 0.9, z: 1 }] },
      new Rng(3),
      rules,
    );
    expect(plan.spawnProtectedUntil).toBe(500 + 2 * TICK_RATE);
    const pawn = { alive: true, spawnProtectedUntil: plan.spawnProtectedUntil };
    expect(isSpawnProtected(pawn, 500 + 2 * TICK_RATE - 1)).toBe(true);
    expect(isSpawnProtected(pawn, 500 + 2 * TICK_RATE)).toBe(false);
    expect(spawnProtectionAfterInput(pawn, 510, { buttons: 0 })).toBe(pawn.spawnProtectedUntil);
    const after = spawnProtectionAfterInput(pawn, 510, { buttons: Buttons.Fire });
    expect(isSpawnProtected({ alive: true, spawnProtectedUntil: after }, 510)).toBe(false);
  });

  it('builds the respawn event and capsule center from the chosen spawn', () => {
    const selector = new SpawnSelector([pose(4, 6, 2)], { noise: 0 });
    const plan = planRespawn(9, 77, selector, { enemies: [] }, new Rng(1), rules);
    expect(plan.spawnIndex).toBe(0);
    expect(plan.event).toEqual({ type: 'respawn', tick: 77, pawn: 9, pose: pose(4, 6, 2) });
    expect(plan.center.x).toBe(4);
    expect(plan.center.z).toBe(6);
    expect(plan.center.y).toBeCloseTo(2 + 0.9 + 0.02, 6);
    expect(selector.lastUsed[0]).toBe(77);
  });
});
