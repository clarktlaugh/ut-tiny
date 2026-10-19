/** Small synthetic maps for nav tests. */
import type { Brush, MapDef, NavLinkDef, Vec3, VolumeDef } from '../sim/types';

export const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

/** Box brush from min/max corners. */
export function span(min: Vec3, max: Vec3): Brush {
  return {
    shape: 'box',
    position: v((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2),
    size: v(max.x - min.x, max.y - min.y, max.z - min.z),
    material: 'test',
  };
}

/** A 20 × 20 m room (x, z ∈ ±10) with floor at y 0 and a ceiling at `height`, plus `extra` brushes. */
export function testRoom(
  extra: Brush[] = [],
  opts: { height?: number; navLinks?: NavLinkDef[]; volumes?: VolumeDef[] } = {},
): MapDef {
  const h = opts.height ?? 10;
  return {
    name: 'test-room',
    scale: 1,
    brushes: [
      span(v(-11, -1, -11), v(11, 0, 11)),
      span(v(-11, h, -11), v(11, h + 1, 11)),
      ...extra,
    ],
    props: [],
    spawns: [],
    pickups: [],
    jumpPads: [],
    volumes: opts.volumes ?? [],
    lights: [],
    navLinks: opts.navLinks ?? [],
    cameras: [],
    ambience: { loops: [], reverb: 'none' },
  };
}
