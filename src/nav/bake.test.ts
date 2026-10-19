import { describe, expect, it } from 'vitest';
import type { Brush } from '../sim/types';
import { bakeNavMesh, nodePosition } from './bake';
import { NavArea } from './config';
import { NavMesh } from './navMesh';
import { span, testRoom, v } from './testMaps';

/** Ramp brush whose footprint is centered at (x, 0, z), climbing toward +Z. */
function rampUp(x: number, z: number, width: number, rise: number, run: number): Brush {
  return { shape: 'ramp', position: v(x, rise / 2, z), size: v(width, rise, run), material: 't' };
}

describe('bakeNavMesh', () => {
  it('covers an open floor inset by the agent radius and skips the outer roof', () => {
    const data = bakeNavMesh(testRoom());
    expect(data.nodeY.length).toBeGreaterThan(0);
    for (let n = 0; n < data.nodeY.length; n++) {
      const p = nodePosition(data, n);
      expect(p.y).toBe(0);
      // Room interior is the 22 m floor slab, edges are drops into nothing.
      // Erosion is exact to half a cell (edges are sampled at cell centers).
      const inset = data.config.agentRadius - data.config.cellSize / 2;
      expect(Math.abs(p.x)).toBeLessThanOrEqual(11 - inset);
      expect(Math.abs(p.z)).toBeLessThanOrEqual(11 - inset);
    }
    expect(new Set(data.region).size).toBe(1);
  });

  it('is deterministic', () => {
    const map = testRoom([span(v(-2, 0, -2), v(2, 0.4, 2))]);
    const a = bakeNavMesh(map);
    const b = bakeNavMesh(map);
    expect(Array.from(a.nodeY)).toEqual(Array.from(b.nodeY));
    expect(Array.from(a.neighbors)).toEqual(Array.from(b.neighbors));
  });

  it('walks up steps within agentClimb and not higher ones', () => {
    const low = new NavMesh(bakeNavMesh(testRoom([span(v(2, 0, -10), v(10, 0.4, 10))])));
    expect(low.findPath(v(-5, 0, 0), v(6, 0.4, 0))).not.toBeNull();
    const high = new NavMesh(bakeNavMesh(testRoom([span(v(2, 0, -10), v(10, 0.6, 10))])));
    expect(high.nearest(v(6, 0.6, 0))).toBeGreaterThanOrEqual(0);
    expect(high.findPath(v(-5, 0, 0), v(6, 0.6, 0))).toBeNull();
  });

  it('needs standing clearance', () => {
    expect(bakeNavMesh(testRoom([], { height: 1.5 })).nodeY.length).toBe(0);
    expect(bakeNavMesh(testRoom([], { height: 2 })).nodeY.length).toBeGreaterThan(0);
  });

  it('walks ramps up to maxSlope', () => {
    // 30°: rise 3 over 5.2 m run.
    const gentle = new NavMesh(
      bakeNavMesh(testRoom([rampUp(0, 0, 4, 3, 5.2), span(v(-2, 0, 2.6), v(2, 3, 10))])),
    );
    expect(gentle.findPath(v(0, 0, -6), v(0, 3, 6))).not.toBeNull();
    // 60°: rise 3 over 1.73 m run.
    const steep = new NavMesh(
      bakeNavMesh(testRoom([rampUp(0, 0, 4, 3, 1.73), span(v(-2, 0, 0.865), v(2, 3, 10))])),
    );
    expect(steep.findPath(v(0, 0, -6), v(0, 3, 6))).toBeNull();
  });

  it('removes kill volumes and marks water and damage areas', () => {
    const map = testRoom([], {
      volumes: [
        { kind: 'kill', box: { min: v(-1, -1, -1), max: v(1, 2, 1) } },
        { kind: 'water', box: { min: v(4, -1, 4), max: v(8, 1, 8) } },
        { kind: 'damage', box: { min: v(-8, 0, -8), max: v(-4, 1, -4) }, damagePerSecond: 10 },
      ],
    });
    const mesh = new NavMesh(bakeNavMesh(map));
    expect(mesh.nearest(v(0, 0, 0), 1, 1)).toBe(-1);
    expect(mesh.data.area[mesh.nearest(v(6, 0, 6))]).toBe(NavArea.water);
    expect(mesh.data.area[mesh.nearest(v(-6, 0, -6))]).toBe(NavArea.damage);
    // Paths still go around the hole.
    expect(mesh.findPath(v(-5, 0, 0), v(5, 0, 0))).not.toBeNull();
  });

  it('snaps nav links and reports the ones that miss', () => {
    const map = testRoom([span(v(2, 0, -10), v(10, 4, 10))], {
      navLinks: [
        { kind: 'pad', from: v(-5, 0, 0), to: v(6, 4, 0) },
        { kind: 'jump', from: v(-5, 0, 0), to: v(50, 0, 50) },
      ],
    });
    const data = bakeNavMesh(map);
    expect(data.links.map((l) => l.index)).toEqual([0]);
    expect(data.unsnappedLinks).toEqual([1]);
    const mesh = new NavMesh(data);
    const path = mesh.findPath(v(-8, 0, 0), v(8, 4, 0));
    expect(path?.waypoints.some((w) => w.link?.kind === 'pad')).toBe(true);
    // One-way: no way back down.
    expect(mesh.findPath(v(8, 4, 0), v(-8, 0, 0))).toBeNull();
  });
});
