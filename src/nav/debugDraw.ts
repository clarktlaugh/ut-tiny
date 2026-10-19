/**
 * Debug draw for the navmesh (docs/DESIGN.md §9): node points coloured by
 * walking region (water blue, damage red), off-mesh links as arcs coloured by
 * kind, and paths as polylines. Add the returned objects to any Three.js scene.
 */
import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  LineSegments,
  Points,
  PointsMaterial,
} from 'three';
import type { NavLinkKind } from '../sim/types';
import { nodePosition } from './bake';
import { NavArea } from './config';
import type { NavMesh, NavPath } from './navMesh';

export const LINK_COLORS: Readonly<Record<NavLinkKind, number>> = Object.freeze({
  pad: 0x33ff66,
  jump: 0xffdd33,
  doubleJump: 0xff9933,
  drop: 0x33ccff,
  translocate: 0xcc66ff,
});

/** Lift above the surface so points do not z-fight with the floor. */
const LIFT = 0.05;
const ARC_SEGMENTS = 12;

export interface NavDebugOptions {
  /** Draw every `stride`-th node (default 1). */
  stride?: number;
  pointSize?: number;
}

export function createNavDebugObject(mesh: NavMesh, options: NavDebugOptions = {}): Group {
  const { data } = mesh;
  const stride = Math.max(1, Math.floor(options.stride ?? 1));
  const group = new Group();
  group.name = 'nav-debug';

  const positions: number[] = [];
  const colors: number[] = [];
  const c = new Color();
  for (let n = 0; n < data.nodeY.length; n += stride) {
    const p = nodePosition(data, n);
    positions.push(p.x, p.y + LIFT, p.z);
    const area = data.area[n];
    if (area === NavArea.water) c.setHex(0x3366ff);
    else if (area === NavArea.damage) c.setHex(0xff3333);
    else c.setHSL((((data.region[n]! * 0.618034) % 1) + 1) % 1, 0.6, 0.55);
    colors.push(c.r, c.g, c.b);
  }
  const pointGeo = new BufferGeometry();
  pointGeo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  pointGeo.setAttribute('color', new Float32BufferAttribute(colors, 3));
  const points = new Points(
    pointGeo,
    new PointsMaterial({ size: options.pointSize ?? 0.2, vertexColors: true }),
  );
  points.name = 'nav-nodes';
  group.add(points);

  // Links: one arc per link as line segments, colour per kind.
  const linkPos: number[] = [];
  const linkCol: number[] = [];
  for (const l of data.links) {
    const a = nodePosition(data, l.from);
    const b = nodePosition(data, l.to);
    const rise = Math.max(2, (b.y - a.y) * 0.25, Math.hypot(b.x - a.x, b.z - a.z) * 0.25);
    c.setHex(LINK_COLORS[l.kind]);
    let prev = a;
    for (let i = 1; i <= ARC_SEGMENTS; i++) {
      const t = i / ARC_SEGMENTS;
      const p = {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t + 4 * rise * t * (1 - t),
        z: a.z + (b.z - a.z) * t,
      };
      linkPos.push(prev.x, prev.y + LIFT, prev.z, p.x, p.y + LIFT, p.z);
      linkCol.push(c.r, c.g, c.b, c.r, c.g, c.b);
      prev = p;
    }
  }
  const linkGeo = new BufferGeometry();
  linkGeo.setAttribute('position', new Float32BufferAttribute(linkPos, 3));
  linkGeo.setAttribute('color', new Float32BufferAttribute(linkCol, 3));
  const links = new LineSegments(linkGeo, new LineBasicMaterial({ vertexColors: true }));
  links.name = 'nav-links';
  group.add(links);
  return group;
}

/** Polyline through a path's waypoints. */
export function createNavPathObject(path: NavPath, color = 0xffffff): Line {
  const pos: number[] = [];
  for (const w of path.waypoints) pos.push(w.position.x, w.position.y + 0.3, w.position.z);
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  const line = new Line(geo, new LineBasicMaterial({ color }));
  line.name = 'nav-path';
  return line;
}
