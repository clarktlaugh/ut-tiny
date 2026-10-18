import { describe, expect, it } from 'vitest';
import { Rng } from './rng';
import { SpawnSelector, planRespawn } from './spawn';
import { TICK_RATE, type Pose } from './types';

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

describe('planRespawn', () => {
  it('returns the chosen pose and the capsule center above it', () => {
    const selector = new SpawnSelector([pose(4, 6, 2)], { noise: 0 });
    const plan = planRespawn(9, 77, selector, { enemies: [] }, new Rng(1));
    expect(plan.pawn).toBe(9);
    expect(plan.spawnIndex).toBe(0);
    expect(plan.pose).toEqual(pose(4, 6, 2));
    expect(plan.center.x).toBe(4);
    expect(plan.center.z).toBe(6);
    expect(plan.center.y).toBeCloseTo(2 + 0.9 + 0.02, 6);
    expect(selector.lastUsed[0]).toBe(77);
  });
});
