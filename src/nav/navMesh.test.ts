import { beforeAll, describe, expect, it } from 'vitest';
import { LAUNDRY_LANDMARKS, LAUNDRY_ROOM } from '../maps/laundry-room';
import type { NavLinkKind, Vec3 } from '../sim/types';
import { bakeNavMesh, nodePosition, type NavMeshData } from './bake';
import { NavArea } from './config';
import { NavMesh, type NavPath } from './navMesh';
import { v } from './testMaps';

const L = LAUNDRY_LANDMARKS as Record<string, Vec3>;
const linkKinds = (p: NavPath | null): NavLinkKind[] =>
  (p?.waypoints ?? []).flatMap((w) => (w.link ? [w.link.kind] : []));
const onFoot = { allowedLinks: new Set<NavLinkKind>() };

let data: NavMeshData;
let mesh: NavMesh;

beforeAll(() => {
  data = bakeNavMesh(LAUNDRY_ROOM);
  mesh = new NavMesh(data);
});

describe('laundry room navmesh', () => {
  it('bakes in under 300 ms (best of 3)', () => {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      bakeNavMesh(LAUNDRY_ROOM);
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThan(300);
  });

  it('snaps every nav link', () => {
    expect(data.unsnappedLinks).toEqual([]);
    expect(data.links).toHaveLength(LAUNDRY_ROOM.navLinks.length);
  });

  it('has a node at every landmark', () => {
    for (const [name, p] of Object.entries(L)) {
      expect(mesh.nearest(p, 1.5, 1), name).toBeGreaterThanOrEqual(0);
    }
  });

  it('finds floor → dryer top via the dryer pad link', () => {
    const path = mesh.findPath(v(50, 0, -8), L.dryerTop!);
    expect(path).not.toBeNull();
    const links = path!.waypoints.filter((w) => w.link);
    expect(links).toHaveLength(1);
    expect(links[0]!.link).toEqual({ index: 1, kind: 'pad', steps: ['walkOnto'] });
    const end = path!.waypoints[path!.waypoints.length - 1]!.position;
    expect(end.y).toBeCloseTo(34);
  });

  it('reaches the dryer top from the far corner', () => {
    expect(mesh.findPath(v(-50, 0, -40), L.dryerTop!)).not.toBeNull();
    // The hose ramp passes the dryer's back edge at its own height, so a pawn
    // can also step off the ramp onto the dryer top without any link.
    expect(linkKinds(mesh.findPath(v(-50, 0, -40), L.dryerTop!, onFoot))).toEqual([]);
  });

  it('walks the ironing board, the dryer door ramp and the hose tunnel', () => {
    for (const goal of ['tableTop', 'dryerRoom', 'ventLanding']) {
      expect(mesh.findPath(v(-50, 0, -40), L[goal]!, onFoot), goal).not.toBeNull();
    }
  });

  it('needs the translocator from the clothesline to the shelf', () => {
    const tl = mesh.findPath(L.clotheslineMid!, L.shelf!);
    expect(linkKinds(tl)).toContain('translocate');
    expect(tl!.waypoints.find((w) => w.link?.kind === 'translocate')!.link!.steps).toEqual([
      'fireTranslocator',
      'teleport',
    ]);
    const noTl = new Set<NavLinkKind>(['pad', 'jump', 'doubleJump', 'drop']);
    expect(mesh.findPath(L.clotheslineMid!, L.shelf!, { allowedLinks: noTl })).toBeNull();
  });

  it('needs links for the shelf and the towel on the clothesline', () => {
    const towel = v(20, 61.2, 0);
    for (const goal of [L.shelf!, towel]) {
      expect(mesh.findPath(v(-50, 0, -40), goal, onFoot)).toBeNull();
      expect(mesh.findPath(v(-50, 0, -40), goal)).not.toBeNull();
    }
    // The towel sits 0.6 m above the beam (more than a step) and the map has
    // no towel → beam drop link yet, so the beam itself is cut off.
    expect(mesh.findPath(towel, L.clotheslineMid!)).toBeNull();
  });

  it('keeps nodes an agent radius (to half a cell) from the walls and out of the sump', () => {
    const r = data.config.agentRadius - data.config.cellSize / 2;
    let maxX = 0;
    let maxZ = 0;
    for (let n = 0; n < data.nodeY.length; n++) {
      const p = nodePosition(data, n);
      maxX = Math.max(maxX, Math.abs(p.x));
      maxZ = Math.max(maxZ, Math.abs(p.z));
    }
    expect(maxX).toBeLessThanOrEqual(60 - r);
    expect(maxZ).toBeLessThanOrEqual(50 - r);
    expect(mesh.nearest(v(-48, 20, 40), 1, 1)).toBe(-1);
  });

  it('marks the washer drum as water and the iron as damage', () => {
    expect(data.area[mesh.nearest(v(20, 20, -32))]).toBe(NavArea.water);
    expect(data.area[mesh.nearest(v(-18, 31.5, 29), 1, 0.5)]).toBe(NavArea.damage);
  });

  it('string-pulls open floor into a straight segment', () => {
    const path = mesh.findPath(v(5, 0, 10), v(35, 0, 10));
    expect(path!.waypoints).toHaveLength(2);
    const raw = mesh.findPath(v(5, 0, 10), v(35, 0, 10), { raw: true });
    expect(raw!.waypoints.length).toBeGreaterThan(100);
  });

  it('routes smoothed paths only through walkable straight segments', () => {
    const path = mesh.findPath(v(-50, 0, -40), L.tableTop!)!;
    const ws = path.waypoints;
    for (let i = 1; i < ws.length; i++) {
      if (ws[i]!.link) continue;
      expect(mesh.walkable(mesh.nearest(ws[i - 1]!.position), mesh.nearest(ws[i]!.position))).toBe(
        true,
      );
    }
  });

  it('cannot climb the clothes pile: 1 m steps and no up links in the map yet', () => {
    expect(mesh.findPath(v(-50, 0, -40), L.pileTop!)).toBeNull();
    // The drop link off the top is there.
    expect(linkKinds(mesh.findPath(L.pileTop!, v(-28, 0, 2)))).toEqual(['drop']);
  });

  it('returns null off the mesh', () => {
    expect(mesh.findPath(v(0, 200, 0), L.drain!)).toBeNull();
    expect(mesh.closestPoint(v(0, 200, 0))).toBeNull();
  });
});
