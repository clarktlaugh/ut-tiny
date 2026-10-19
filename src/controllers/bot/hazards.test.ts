import { describe, expect, it } from 'vitest';
import type { JumpPadDef, Vec3 } from '../../sim/types';
import { detourAround, firstHit, padHazard, segmentHits } from './hazards';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

/** A 3 × 3 m pad at the origin launching toward −z (like the laundry machine pads). */
const pad: JumpPadDef = { position: v(0, 0.5, 0), size: v(3, 1, 3), launch: v(0, 39, -8.8) };

describe('pad hazards', () => {
  const h = padHazard(pad, 0);

  it('expands the trigger by the capsule radius and a margin', () => {
    expect(h.minX).toBeCloseTo(-2.25);
    expect(h.maxZ).toBeCloseTo(2.25);
    expect(h.minY).toBeLessThan(0);
    expect(h.maxY).toBeGreaterThan(1);
  });

  it('puts the entry point just outside the box, opposite the launch direction', () => {
    expect(h.entries).toHaveLength(1);
    const e = h.entries[0]!;
    expect(e.x).toBeCloseTo(0);
    expect(e.z).toBeGreaterThan(h.maxZ);
    expect(e.z).toBeLessThan(h.maxZ + 1);
  });

  it('enters a vertical launch from either end of the long axis', () => {
    const tall = padHazard({ ...pad, size: v(1.6, 1, 3), launch: v(0, 30, 0) }, 1);
    expect(tall.entries).toHaveLength(2);
    for (const e of tall.entries) {
      expect(e.x).toBeCloseTo(0);
      expect(Math.abs(e.z)).toBeGreaterThan(tall.maxZ);
    }
  });

  it('detects segments through the box at pad height only', () => {
    expect(segmentHits(v(-5, 0, 0), v(5, 0, 0), h)).toBe(true);
    expect(segmentHits(v(-5, 0, 3), v(5, 0, 3), h)).toBe(false);
    expect(segmentHits(v(-5, 20, 0), v(5, 20, 0), h)).toBe(false);
    expect(segmentHits(v(0, 0, 0), v(0, 0, 0), h)).toBe(true);
  });

  it('walks around the box by a corner that keeps both legs clear', () => {
    const hazards = [h];
    const from = v(-6, 0, 0.5);
    const goal = v(6, 0, 0.5);
    const corner = detourAround(from, goal, firstHit(from, goal, hazards)!, hazards, () => true);
    expect(corner).not.toBeNull();
    expect(firstHit(from, corner!, hazards)).toBeNull();
    // The goal is behind the box, so the way round takes two corners along one side.
    expect(Math.abs(corner!.z) - h.maxZ).toBeGreaterThan(0);
    const second = detourAround(corner!, goal, h, hazards, () => true);
    expect(second).not.toBeNull();
    expect(firstHit(corner!, second!, hazards)).toBeNull();
    expect(firstHit(second!, goal, hazards)).toBeNull();
  });

  it('gives up when the goal is inside the box or no corner is on the mesh', () => {
    const hazards = [h];
    const from = v(-6, 0, 0);
    expect(detourAround(from, v(0, 0, 0), h, hazards, () => true)).toBeNull();
    expect(detourAround(from, v(6, 0, 0), h, hazards, () => false)).toBeNull();
  });
});
