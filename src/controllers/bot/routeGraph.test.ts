/**
 * The route graph must agree with the navmesh on what is reachable, stay
 * close to its path costs, avoid pad triggers it does not use, and answer
 * fast enough to plan inside a tick.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { LAUNDRY_LANDMARKS, LAUNDRY_ROOM } from '../../maps/laundry-room';
import { NavMesh, bakeNavMesh, type NavPath } from '../../nav';
import type { Vec3 } from '../../sim/types';
import { firstHit, padHazards } from './hazards';
import { RouteGraph, routeGraphFor } from './routeGraph';

const L = LAUNDRY_LANDMARKS as Record<string, Vec3>;
const names = Object.keys(L);
const pairs: [string, string][] = [];
for (const a of names) for (const b of names) if (a < b) pairs.push([a, b]);

let nav: NavMesh;
let graph: RouteGraph;
const hazards = padHazards(LAUNDRY_ROOM);

beforeAll(() => {
  nav = new NavMesh(bakeNavMesh(LAUNDRY_ROOM));
  graph = new RouteGraph(nav, { hazards });
});

describe('route graph on the laundry room', () => {
  it('attaches every link and builds in a couple of seconds at most', () => {
    const t0 = performance.now();
    const g = new RouteGraph(nav);
    expect(performance.now() - t0).toBeLessThan(2500);
    expect(g.unattachedLinks).toEqual([]);
    expect(g.pointCount).toBeGreaterThan(10_000);
  });

  // The mesh's own A* takes up to ~150 ms per pair, hence the long timeouts.
  it('reaches exactly what the mesh reaches between every pair of landmarks', () => {
    for (const [a, b] of pairs) {
      const mine = graph.findPath(L[a]!, L[b]!);
      const theirs = nav.findPath(L[a]!, L[b]!);
      expect(mine === null, `${a} → ${b}`).toBe(theirs === null);
    }
  }, 60_000);

  it('returns paths shaped like the mesh does: start, walking runs, link landings, goal', () => {
    const p = graph.findPath(L.drain!, L.dryerTop!)!;
    expect(p.waypoints[0]!.position.y).toBeCloseTo(0, 0);
    const links = p.waypoints.filter((w) => w.link);
    expect(links).toHaveLength(1);
    expect(links[0]!.link!.kind).toBe('pad');
    expect(links[0]!.link!.steps).toEqual(['walkOnto']);
    const end = p.waypoints[p.waypoints.length - 1]!.position;
    expect(end.y).toBeCloseTo(34, 0);
  });

  it('costs at most a quarter more than the mesh route, pad detours aside', () => {
    for (const [a, b] of pairs) {
      const mine = graph.findPath(L[a]!, L[b]!);
      const theirs = nav.findPath(L[a]!, L[b]!);
      if (!mine || !theirs) continue;
      // A mesh route straight through a pad trigger is one the graph refuses;
      // entering pads from their entry points also adds a little.
      if (crossesPad(theirs)) continue;
      expect(mine.cost, `${a} → ${b}`).toBeLessThanOrEqual(theirs.cost * 1.25 + 2);
    }
  }, 60_000);

  it('never walks a run through a pad it is not using', () => {
    for (const [a, b] of pairs) {
      const p = graph.findPath(L[a]!, L[b]!);
      if (!p) continue;
      for (let i = 1; i < p.waypoints.length; i++) {
        const prev = p.waypoints[i - 1]!;
        const cur = p.waypoints[i]!;
        if (cur.link) continue;
        // The leg into a pad link start may end inside the pad.
        const next = p.waypoints[i + 1];
        if (next?.link?.kind === 'pad') continue;
        expect(firstHit(prev.position, cur.position, hazards), `${a} → ${b} leg ${i}`).toBeNull();
      }
    }
  });

  it('honours the allowed link kinds', () => {
    const onFoot = graph.findPath(L.drain!, L.dryerTop!, { allowedLinks: new Set() });
    expect(onFoot).not.toBeNull();
    expect(onFoot!.waypoints.some((w) => w.link)).toBe(false);
    // The washer top needs a pad, or the dryer top plus a jump across the gap.
    expect(graph.findPath(L.drain!, L.washerRim!, { allowedLinks: new Set() })).toBeNull();
    const viaJump = graph.findPath(L.drain!, L.washerRim!, { allowedLinks: new Set(['jump']) });
    expect(viaJump!.waypoints.filter((w) => w.link).map((w) => w.link!.kind)).toEqual(['jump']);
  });

  it('answers in a few milliseconds and spreads plans one per tick', () => {
    let worst = 0;
    for (const [a, b] of pairs) {
      const t0 = performance.now();
      graph.findPath(L[a]!, L[b]!);
      worst = Math.max(worst, performance.now() - t0);
    }
    expect(worst).toBeLessThan(60);
    expect(graph.acquire(1)).toBe(true);
    expect(graph.acquire(1)).toBe(false);
    expect(graph.acquire(2)).toBe(true);
  });

  it('shares one graph per mesh', () => {
    const shared = routeGraphFor(nav);
    expect(routeGraphFor(nav, { spacing: 8 })).toBe(shared);
  });
});

function crossesPad(p: NavPath): boolean {
  for (let i = 1; i < p.waypoints.length; i++) {
    const cur = p.waypoints[i]!;
    if (cur.link || p.waypoints[i + 1]?.link?.kind === 'pad') continue;
    if (firstHit(p.waypoints[i - 1]!.position, cur.position, hazards)) return true;
  }
  return false;
}
