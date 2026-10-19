import { describe, expect, it } from 'vitest';
import type { BufferGeometry, Line, LineSegments, Points } from 'three';
import { bakeNavMesh } from './bake';
import { createNavDebugObject, createNavPathObject } from './debugDraw';
import { NavMesh } from './navMesh';
import { span, testRoom, v } from './testMaps';

const count = (o: { geometry: BufferGeometry }) => o.geometry.getAttribute('position').count;

describe('nav debug draw', () => {
  const map = testRoom([span(v(2, 0, -10), v(10, 4, 10))], {
    navLinks: [{ kind: 'pad', from: v(-5, 0, 0), to: v(6, 4, 0) }],
    volumes: [{ kind: 'water', box: { min: v(-8, -1, -8), max: v(-4, 1, -4) } }],
  });
  const mesh = new NavMesh(bakeNavMesh(map));

  it('draws one point per node and one arc per link', () => {
    const group = createNavDebugObject(mesh);
    const points = group.getObjectByName('nav-nodes') as Points;
    const links = group.getObjectByName('nav-links') as LineSegments;
    expect(count(points)).toBe(mesh.nodeCount);
    expect(count(links)).toBe(mesh.data.links.length * 12 * 2);
    expect(
      count(createNavDebugObject(mesh, { stride: 4 }).getObjectByName('nav-nodes') as Points),
    ).toBe(Math.ceil(mesh.nodeCount / 4));
  });

  it('draws a path polyline', () => {
    const path = mesh.findPath(v(-8, 0, 0), v(8, 4, 0))!;
    const line = createNavPathObject(path) as Line;
    expect(count(line)).toBe(path.waypoints.length);
  });
});
