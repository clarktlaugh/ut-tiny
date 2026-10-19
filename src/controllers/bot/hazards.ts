/**
 * Ground hazards a walking bot steers around: jump pad triggers it does not
 * mean to use. Pads are plain floor on the navmesh, and a pad entered at the
 * wrong edge launches a pawn into whatever it was meant to clear (the laundry
 * room's machine pads, entered from the side, throw a pawn into the machine's
 * front face and down 40 m). A hazard is an expanded horizontal box with the
 * height band it applies to.
 */
import { PAWN_CAPSULE } from '../../sim/physics';
import type { JumpPadDef, MapDef, Vec3 } from '../../sim/types';

export interface Hazard {
  /** `MapDef.jumpPads` index, so a link that uses the pad can exempt it. */
  pad: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Feet heights the hazard applies to. */
  minY: number;
  maxY: number;
  /**
   * Where to step onto the pad from when using it on purpose, best first.
   * For a launch with a horizontal part: just outside the trigger on the side
   * opposite the launch direction, so the launch happens as early along its
   * arc as possible. For a vertical launch: outside either end of the
   * trigger's long axis, so the pawn crosses the centre line (a pad against
   * a wall relies on that for the wall dodge at the apex). Callers skip
   * entries that are off the mesh.
   */
  entries: Vec3[];
}

/** Clearance added around a pad trigger beyond the capsule radius, m. */
export const HAZARD_MARGIN = 0.35;
/** Extra route cost (metres of walking) for an edge that crosses a hazard. */
export const HAZARD_PENALTY = 40;

/** How far outside the expanded trigger box the entry point sits, m. */
export const ENTRY_OFFSET = 0.6;

export function padHazard(pad: Readonly<JumpPadDef>, index: number): Hazard {
  const grow = PAWN_CAPSULE.radius + HAZARD_MARGIN;
  const h: Hazard = {
    pad: index,
    minX: pad.position.x - pad.size.x / 2 - grow,
    maxX: pad.position.x + pad.size.x / 2 + grow,
    minZ: pad.position.z - pad.size.z / 2 - grow,
    maxZ: pad.position.z + pad.size.z / 2 + grow,
    minY: pad.position.y - pad.size.y / 2 - 1.5,
    maxY: pad.position.y + pad.size.y / 2 + 1.5,
    entries: [],
  };
  const feetY = pad.position.y - pad.size.y / 2;
  const len = Math.hypot(pad.launch.x, pad.launch.z);
  if (len > 1e-3) {
    const dx = pad.launch.x / len;
    const dz = pad.launch.z / len;
    // Distance from the center to the expanded box edge along the launch direction.
    const half = Math.min(
      Math.abs(dx) > 1e-6 ? (pad.size.x / 2 + grow) / Math.abs(dx) : Infinity,
      Math.abs(dz) > 1e-6 ? (pad.size.z / 2 + grow) / Math.abs(dz) : Infinity,
    );
    const back = half + ENTRY_OFFSET;
    h.entries.push({ x: pad.position.x - dx * back, y: feetY, z: pad.position.z - dz * back });
  } else {
    const alongZ = pad.size.z >= pad.size.x;
    const back = (alongZ ? pad.size.z : pad.size.x) / 2 + grow + ENTRY_OFFSET;
    for (const sign of [1, -1]) {
      h.entries.push({
        x: pad.position.x + (alongZ ? 0 : sign * back),
        y: feetY,
        z: pad.position.z + (alongZ ? sign * back : 0),
      });
    }
  }
  return h;
}

/** The hazard whose box contains the feet position `p`, or null. */
export function hazardAt(p: Readonly<Vec3>, hazards: readonly Hazard[]): Hazard | null {
  return firstHit(p, p, hazards);
}

/** Hazards for every jump pad of a map. */
export function padHazards(map: Readonly<Pick<MapDef, 'jumpPads'>>): Hazard[] {
  return map.jumpPads.map((pad, i) => padHazard(pad, i));
}

/** True when the horizontal segment a→b crosses the hazard at a height it applies to. */
export function segmentHits(a: Readonly<Vec3>, b: Readonly<Vec3>, h: Readonly<Hazard>): boolean {
  const y = Math.min(a.y, b.y);
  const y2 = Math.max(a.y, b.y);
  if (y2 < h.minY || y > h.maxY) return false;
  // Liang–Barsky clip of the 2D segment against the box.
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const checks: [number, number][] = [
    [-dx, a.x - h.minX],
    [dx, h.maxX - a.x],
    [-dz, a.z - h.minZ],
    [dz, h.maxZ - a.z],
  ];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
  }
  return t0 <= t1;
}

/** The first hazard the segment crosses, ignoring `exempt`, or null. */
export function firstHit(
  a: Readonly<Vec3>,
  b: Readonly<Vec3>,
  hazards: readonly Hazard[],
  exempt = -1,
): Hazard | null {
  for (const h of hazards) {
    if (h.pad === exempt) continue;
    if (segmentHits(a, b, h)) return h;
  }
  return null;
}

/**
 * A point to walk to instead of straight at `goal` when that crosses `h`:
 * the first corner of a way round the expanded box, by one corner or two
 * adjacent ones, whose legs avoid every hazard and whose corners `onMesh`
 * accepts. Null when no such way exists (the goal is inside the box, or the
 * box is hemmed in).
 */
export function detourAround(
  from: Readonly<Vec3>,
  goal: Readonly<Vec3>,
  h: Readonly<Hazard>,
  hazards: readonly Hazard[],
  onMesh: (p: Readonly<Vec3>) => boolean,
): Vec3 | null {
  const step = 0.3;
  // Corners in order around the box, so neighbours in the list share a side.
  const corners: Vec3[] = [
    { x: h.minX - step, y: from.y, z: h.minZ - step },
    { x: h.maxX + step, y: from.y, z: h.minZ - step },
    { x: h.maxX + step, y: from.y, z: h.maxZ + step },
    { x: h.minX - step, y: from.y, z: h.maxZ + step },
  ];
  const ok = corners.map((c) => onMesh(c));
  const clear = (a: Readonly<Vec3>, b: Readonly<Vec3>): boolean => firstHit(a, b, hazards) === null;
  const len = (a: Readonly<Vec3>, b: Readonly<Vec3>): number => Math.hypot(b.x - a.x, b.z - a.z);
  let best: Vec3 | null = null;
  let bestLen = Infinity;
  for (let i = 0; i < 4; i++) {
    const c1 = corners[i]!;
    if (!ok[i] || !clear(from, c1)) continue;
    if (clear(c1, goal)) {
      const l = len(from, c1) + len(c1, goal);
      if (l < bestLen) {
        bestLen = l;
        best = c1;
      }
      continue;
    }
    for (const j of [(i + 1) % 4, (i + 3) % 4]) {
      const c2 = corners[j]!;
      if (!ok[j] || !clear(c1, c2) || !clear(c2, goal)) continue;
      const l = len(from, c1) + len(c1, c2) + len(c2, goal);
      if (l < bestLen) {
        bestLen = l;
        best = c1;
      }
    }
  }
  return best;
}
