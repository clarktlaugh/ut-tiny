import { describe, expect, it } from 'vitest';
import { Rng, seedFromString } from '../../src/sim/rng';

describe('Rng', () => {
  it('is deterministic for the same seed', () => {
    const a = new Rng(12345);
    const b = new Rng(12345);
    for (let i = 0; i < 1000; i++) expect(a.nextU32()).toBe(b.nextU32());
  });

  it('produces different streams for different seeds', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    const same = Array.from({ length: 100 }, () => a.nextU32() === b.nextU32()).filter(Boolean);
    expect(same.length).toBeLessThan(5);
  });

  it('round-trips state through getState/setState', () => {
    const a = new Rng(99);
    for (let i = 0; i < 17; i++) a.nextFloat();
    const saved = a.getState();
    const expected = Array.from({ length: 50 }, () => a.nextU32());
    const b = new Rng(0);
    b.setState(saved);
    const actual = Array.from({ length: 50 }, () => b.nextU32());
    expect(actual).toEqual(expected);
  });

  it('nextFloat stays in [0, 1) and is roughly uniform', () => {
    const rng = new Rng(7);
    const buckets = new Array<number>(10).fill(0);
    const n = 100_000;
    for (let i = 0; i < n; i++) {
      const f = rng.nextFloat();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
      buckets[Math.floor(f * 10)]!++;
    }
    for (const count of buckets) {
      expect(count).toBeGreaterThan(n / 10 - 600);
      expect(count).toBeLessThan(n / 10 + 600);
    }
  });

  it('nextInt covers every value in range and nothing else', () => {
    const rng = new Rng(3);
    const seen = new Set<number>();
    for (let i = 0; i < 10_000; i++) {
      const v = rng.nextInt(6);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(6);
      seen.add(v);
    }
    expect(seen.size).toBe(6);
    expect(() => rng.nextInt(0)).toThrow(RangeError);
    expect(() => rng.nextInt(2.5)).toThrow(RangeError);
  });

  it('nextRange respects bounds', () => {
    const rng = new Rng(11);
    for (let i = 0; i < 10_000; i++) {
      const v = rng.nextRange(-3, 5);
      expect(v).toBeGreaterThanOrEqual(-3);
      expect(v).toBeLessThan(5);
    }
  });

  it('nextBool honors probability', () => {
    const rng = new Rng(5);
    let trues = 0;
    const n = 50_000;
    for (let i = 0; i < n; i++) if (rng.nextBool(0.2)) trues++;
    expect(trues / n).toBeGreaterThan(0.185);
    expect(trues / n).toBeLessThan(0.215);
  });

  it('nextGaussian has mean ~0 and standard deviation ~1', () => {
    const rng = new Rng(42);
    const n = 100_000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const g = rng.nextGaussian();
      sum += g;
      sumSq += g * g;
    }
    const mean = sum / n;
    const std = Math.sqrt(sumSq / n - mean * mean);
    expect(Math.abs(mean)).toBeLessThan(0.02);
    expect(Math.abs(std - 1)).toBeLessThan(0.02);
  });

  it('pick and shuffle use the stream deterministically', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    const a = new Rng(8);
    const b = new Rng(8);
    expect(a.pick(items)).toBe(b.pick(items));
    expect(a.shuffle([...items])).toEqual(b.shuffle([...items]));
    expect(() => a.pick([])).toThrow(RangeError);
    const shuffled = new Rng(1).shuffle([...items]);
    expect([...shuffled].sort()).toEqual(items);
  });

  it('fork yields an independent, reproducible generator', () => {
    const parent1 = new Rng(100);
    const parent2 = new Rng(100);
    const child1 = parent1.fork();
    const child2 = parent2.fork();
    expect(child1.nextU32()).toBe(child2.nextU32());
    // Forking advanced the parent identically on both sides.
    expect(parent1.nextU32()).toBe(parent2.nextU32());
  });
});

describe('seedFromString', () => {
  it('is stable and distinguishes inputs', () => {
    expect(seedFromString('laundry-room')).toBe(seedFromString('laundry-room'));
    expect(seedFromString('laundry-room')).not.toBe(seedFromString('kitchen'));
    const s = seedFromString('anything');
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(0xffffffff);
    expect(Number.isInteger(s)).toBe(true);
  });
});
