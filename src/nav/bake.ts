/**
 * Navmesh bake from a `MapDef` (docs/DESIGN.md §9).
 *
 * A Recast-style voxel pass in plain TypeScript:
 * 1. Rasterize every brush into vertical solid spans per grid column (sampled
 *    at cell centers, using the brush conventions in `src/sim/physics/shapes.ts`).
 * 2. A walkable node is the top of a solid span with `agentHeight` of open
 *    space above it and a slope no steeper than `maxSlope`.
 * 3. Nodes link to the four orthogonal neighbours within `agentClimb`.
 * 4. Kill volumes remove nodes; water and damage volumes mark their area.
 * 5. Nodes closer than `agentRadius` to an edge, wall or ledge are eroded away.
 * 6. `MapDef.navLinks` become one-way off-mesh links snapped to the mesh.
 *
 * The result is plain typed arrays (`NavMeshData`), so it can be stored in
 * IndexedDB as is. Props are not rasterized yet (the laundry room has none).
 */
import type { Brush, MapDef, NavLinkKind, VolumeDef } from '../sim/types';
import {
  DEFAULT_NAV_CONFIG,
  LINK_PENALTY,
  NAV_BAKE_VERSION,
  NavArea,
  type NavBakeConfig,
} from './config';

/** Neighbour directions, in the order used by `NavMeshData.neighbors`. */
export const NAV_DIRS: readonly (readonly [number, number])[] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

export interface NavOffMeshLink {
  /** Index into `MapDef.navLinks`. */
  index: number;
  kind: NavLinkKind;
  from: number;
  to: number;
  cost: number;
}

export interface NavMeshData {
  version: number;
  config: NavBakeConfig;
  /** World x, z of the grid's minimum corner. */
  originX: number;
  originZ: number;
  /** Columns along x and z. */
  width: number;
  depth: number;
  /** CSR offsets: nodes of column `c` are `colStart[c] .. colStart[c + 1] - 1`. */
  colStart: Int32Array;
  /** Column index (`iz * width + ix`) of each node. */
  nodeCol: Int32Array;
  /** Surface height (feet) of each node. */
  nodeY: Float32Array;
  /** Four neighbours per node in `NAV_DIRS` order, −1 for none. */
  neighbors: Int32Array;
  /** `NavAreaId` per node. */
  area: Uint8Array;
  /** Connected walking region per node (ignores off-mesh links). */
  region: Int32Array;
  links: NavOffMeshLink[];
  /** `MapDef.navLinks` indices whose ends did not snap to the mesh. */
  unsnappedLinks: number[];
}

const EPS = 0.01;

interface Grid {
  ox: number;
  oz: number;
  w: number;
  d: number;
  cs: number;
  maxY: number;
}

/** Growable column spans in typed arrays (a plain `number[]` per field is several times slower). */
class Raster {
  size = 0;
  col: Int32Array;
  min: Float64Array;
  max: Float64Array;
  walk: Uint8Array;
  constructor(capacity: number) {
    const n = Math.max(16, capacity);
    this.col = new Int32Array(n);
    this.min = new Float64Array(n);
    this.max = new Float64Array(n);
    this.walk = new Uint8Array(n);
  }
  push(c: number, lo: number, hi: number, walk: number): void {
    if (this.size === this.col.length) this.grow();
    const i = this.size++;
    this.col[i] = c;
    this.min[i] = lo;
    this.max[i] = hi;
    this.walk[i] = walk;
  }
  private grow(): void {
    const n = this.col.length * 2;
    const col = new Int32Array(n);
    const min = new Float64Array(n);
    const max = new Float64Array(n);
    const walk = new Uint8Array(n);
    col.set(this.col);
    min.set(this.min);
    max.set(this.max);
    walk.set(this.walk);
    Object.assign(this, { col, min, max, walk });
  }
}

/** Rasterize one brush into column spans. */
function rasterizeBrush(b: Brush, g: Grid, maxSlopeRad: number, out: Raster): void {
  const hx = b.size.x / 2;
  const hy = b.size.y / 2;
  const hz = (b.shape === 'cylinder' ? b.size.x : b.size.z) / 2;
  if (!(hx > 0 && hy > 0 && hz > 0)) return;
  const yaw = b.shape === 'cylinder' ? 0 : (b.yaw ?? 0);
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const ex = Math.abs(hx * c) + Math.abs(hz * s);
  const ez = Math.abs(hx * s) + Math.abs(hz * c);
  const { x: px, y: py, z: pz } = b.position;
  const bottom = py - hy;
  const flatTop = py + hy;
  const rampWalk = Math.atan2(2 * hy, 2 * hz) <= maxSlopeRad + 1e-6 ? 1 : 0;
  const ix0 = Math.max(0, Math.ceil((px - ex - g.ox) / g.cs - 0.5));
  const ix1 = Math.min(g.w - 1, Math.floor((px + ex - g.ox) / g.cs - 0.5));
  const iz0 = Math.max(0, Math.ceil((pz - ez - g.oz) / g.cs - 0.5));
  const iz1 = Math.min(g.d - 1, Math.floor((pz + ez - g.oz) / g.cs - 0.5));
  if (b.shape === 'box' && s === 0) {
    // Axis-aligned box: every cell in the range is inside.
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) out.push(iz * g.w + ix, bottom, flatTop, 1);
    }
    return;
  }
  for (let iz = iz0; iz <= iz1; iz++) {
    const dz = g.oz + (iz + 0.5) * g.cs - pz;
    for (let ix = ix0; ix <= ix1; ix++) {
      const dx = g.ox + (ix + 0.5) * g.cs - px;
      let top = flatTop;
      let walk = 1;
      if (b.shape === 'cylinder') {
        if (dx * dx + dz * dz > hx * hx) continue;
      } else {
        // World → brush local (inverse yaw; positive yaw turns +X toward −Z).
        const lx = dx * c - dz * s;
        const lz = dx * s + dz * c;
        if (Math.abs(lx) > hx || Math.abs(lz) > hz) continue;
        if (b.shape === 'ramp') {
          top = bottom + ((lz + hz) / (2 * hz)) * 2 * hy;
          walk = rampWalk;
        }
      }
      out.push(iz * g.w + ix, bottom, top, walk);
    }
  }
}

function brushBounds(b: Brush): [number, number, number, number, number, number] {
  const hx = b.size.x / 2;
  const hz = (b.shape === 'cylinder' ? b.size.x : b.size.z) / 2;
  const yaw = b.shape === 'cylinder' ? 0 : (b.yaw ?? 0);
  const ex = Math.abs(hx * Math.cos(yaw)) + Math.abs(hz * Math.sin(yaw));
  const ez = Math.abs(hx * Math.sin(yaw)) + Math.abs(hz * Math.cos(yaw));
  const { x, y, z } = b.position;
  return [x - ex, y - b.size.y / 2, z - ez, x + ex, y + b.size.y / 2, z + ez];
}

/** Volume test for a standing agent at `(x, y, z)`. */
function volumeHits(v: VolumeDef, x: number, y: number, z: number, height: number): boolean {
  const { min, max } = v.box;
  return x >= min.x && x <= max.x && z >= min.z && z <= max.z && y <= max.y && y + height >= min.y;
}

/** Tiny binary min-heap of (key, value) pairs. */
export class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size(): number {
    return this.keys.length;
  }
  clear(): void {
    this.keys.length = 0;
    this.vals.length = 0;
  }
  push(key: number, val: number): void {
    const k = this.keys;
    const v = this.vals;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((k[p] as number) <= key) break;
      k[i] = k[p] as number;
      v[i] = v[p] as number;
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  /** Removes the smallest entry; returns its value. `lastKey` holds its key. */
  pop(): number {
    const k = this.keys;
    const v = this.vals;
    const top = v[0] as number;
    this.lastKey = k[0] as number;
    const key = k.pop() as number;
    const val = v.pop() as number;
    const n = k.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const m = r < n && (k[r] as number) < (k[l] as number) ? r : l;
        if ((k[m] as number) >= key) break;
        k[i] = k[m] as number;
        v[i] = v[m] as number;
        i = m;
      }
      k[i] = key;
      v[i] = val;
    }
    return top;
  }
  lastKey = 0;
}

/** Bake a navmesh for `map`. Pure and deterministic. */
export function bakeNavMesh(map: MapDef, overrides: Partial<NavBakeConfig> = {}): NavMeshData {
  const config: NavBakeConfig = { ...DEFAULT_NAV_CONFIG, ...overrides };
  const cs = config.cellSize;

  // Grid bounds from the brushes.
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  let maxY = -Infinity;
  for (const b of map.brushes) {
    const [x0, , z0, x1, y1, z1] = brushBounds(b);
    minX = Math.min(minX, x0);
    minZ = Math.min(minZ, z0);
    maxX = Math.max(maxX, x1);
    maxZ = Math.max(maxZ, z1);
    maxY = Math.max(maxY, y1);
  }
  if (!Number.isFinite(minX)) {
    minX = minZ = maxX = maxZ = maxY = 0;
  }
  const g: Grid = {
    ox: minX,
    oz: minZ,
    w: Math.max(1, Math.ceil((maxX - minX) / cs)),
    d: Math.max(1, Math.ceil((maxZ - minZ) / cs)),
    cs,
    maxY,
  };
  const cols = g.w * g.d;

  // 1. Rasterize into spans, then bucket them by column.
  let estimate = 0;
  for (const b of map.brushes) {
    const [x0, , z0, x1, , z1] = brushBounds(b);
    estimate += (Math.ceil((x1 - x0) / cs) + 1) * (Math.ceil((z1 - z0) / cs) + 1);
  }
  const raster = new Raster(estimate);
  const maxSlopeRad = (config.maxSlope * Math.PI) / 180;
  for (const b of map.brushes) rasterizeBrush(b, g, maxSlopeRad, raster);
  const spanStart = new Int32Array(cols + 1);
  for (let i = 0; i < raster.size; i++) spanStart[raster.col[i]! + 1]!++;
  for (let c = 0; c < cols; c++) spanStart[c + 1]! += spanStart[c]!;
  const fill = spanStart.slice(0, cols);
  const order = new Int32Array(raster.size);
  for (let i = 0; i < raster.size; i++) order[fill[raster.col[i]!]!++] = i;

  // 2. Merge spans per column and emit walkable tops.
  // Each span yields at most one node, so `raster.size` bounds the node count.
  const rawCol = new Int32Array(raster.size);
  const rawY = new Float64Array(raster.size);
  const rawCeil = new Float64Array(raster.size);
  let rawN = 0;
  const rawStart = new Int32Array(cols + 1);
  const rMin = raster.min;
  const rMax = raster.max;
  const rWalk = raster.walk;
  let mergedMin = new Float64Array(64);
  let mergedMax = new Float64Array(64);
  let mergedWalk = new Uint8Array(64);
  for (let c = 0; c < cols; c++) {
    rawStart[c] = rawN;
    const s0 = spanStart[c]!;
    const s1 = spanStart[c + 1]!;
    if (s0 === s1) continue;
    // Insertion sort by span bottom (columns hold a handful of spans).
    for (let i = s0 + 1; i < s1; i++) {
      const v = order[i]!;
      const key = rMin[v]!;
      let j = i - 1;
      while (j >= s0 && rMin[order[j]!]! > key) {
        order[j + 1] = order[j]!;
        j--;
      }
      order[j + 1] = v;
    }
    if (s1 - s0 > mergedMax.length) {
      mergedMin = new Float64Array(s1 - s0);
      mergedMax = new Float64Array(s1 - s0);
      mergedWalk = new Uint8Array(s1 - s0);
    }
    let merged = 0;
    for (let k = s0; k < s1; k++) {
      const i = order[k]!;
      const lo = rMin[i]!;
      const hi = rMax[i]!;
      const wk = rWalk[i]!;
      const last = merged - 1;
      if (last >= 0 && lo <= mergedMax[last]! + EPS) {
        if (hi > mergedMax[last]! + EPS) {
          mergedMax[last] = hi;
          mergedWalk[last] = wk;
        } else if (hi >= mergedMax[last]! - EPS && wk) {
          mergedWalk[last] = 1;
        }
      } else {
        mergedMin[merged] = lo;
        mergedMax[merged] = hi;
        mergedWalk[merged] = wk;
        merged++;
      }
    }
    for (let k = 0; k < merged; k++) {
      const top = mergedMax[k]!;
      const ceil = k + 1 < merged ? mergedMin[k + 1]! : Infinity;
      // The outermost roof (the highest surface with nothing above) is not floor.
      if (ceil === Infinity && top >= g.maxY - EPS) continue;
      if (!mergedWalk[k] || ceil - top < config.agentHeight) continue;
      rawCol[rawN] = c;
      rawY[rawN] = top;
      rawCeil[rawN] = ceil;
      rawN++;
    }
  }
  rawStart[cols] = rawN;

  // 4 (early). Kill volumes drop nodes before linking so their edges erode.
  const alive = new Uint8Array(rawN).fill(1);
  const rawArea = new Uint8Array(rawN);
  const nodeX = (n: number) => g.ox + ((rawCol[n]! % g.w) + 0.5) * cs;
  const nodeZ = (n: number) => g.oz + (Math.floor(rawCol[n]! / g.w) + 0.5) * cs;
  for (const v of map.volumes) {
    const ix0 = Math.max(0, Math.floor((v.box.min.x - g.ox) / cs));
    const ix1 = Math.min(g.w - 1, Math.floor((v.box.max.x - g.ox) / cs));
    const iz0 = Math.max(0, Math.floor((v.box.min.z - g.oz) / cs));
    const iz1 = Math.min(g.d - 1, Math.floor((v.box.max.z - g.oz) / cs));
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const c = iz * g.w + ix;
        for (let n = rawStart[c]!; n < rawStart[c + 1]!; n++) {
          if (!volumeHits(v, nodeX(n), rawY[n]!, nodeZ(n), config.agentHeight)) continue;
          if (v.kind === 'kill') alive[n] = 0;
          else if (v.kind === 'damage') rawArea[n] = NavArea.damage;
          else if (rawArea[n] === NavArea.walk) rawArea[n] = NavArea.water;
        }
      }
    }
  }

  // 3. Orthogonal neighbours within climb and with headroom for the step.
  const rawNb = new Int32Array(rawN * 4).fill(-1);
  for (let n = 0; n < rawN; n++) {
    if (!alive[n]) continue;
    const c = rawCol[n]!;
    const ix = c % g.w;
    const iz = (c - ix) / g.w;
    const y = rawY[n]!;
    for (let d = 0; d < 4; d++) {
      const [ddx, ddz] = NAV_DIRS[d]!;
      const jx = ix + ddx;
      const jz = iz + ddz;
      if (jx < 0 || jz < 0 || jx >= g.w || jz >= g.d) continue;
      const cc = jz * g.w + jx;
      let best = -1;
      let bestDy = Infinity;
      for (let m = rawStart[cc]!; m < rawStart[cc + 1]!; m++) {
        if (!alive[m]) continue;
        const dy = Math.abs(rawY[m]! - y);
        if (dy > config.agentClimb || dy >= bestDy) continue;
        const head = Math.min(rawCeil[m]!, rawCeil[n]!) - Math.max(rawY[m]!, y);
        if (head < config.agentHeight) continue;
        best = m;
        bestDy = dy;
      }
      rawNb[n * 4 + d] = best;
    }
  }

  // 5. Erode: chamfer distance (in cells) to the nearest missing neighbour,
  // keep nodes at least `agentRadius` away. Nodes are stored in grid order
  // (z-major), so a forward and a backward pass over the indices suffice.
  const dist = new Float64Array(rawN);
  const nb = rawNb;
  /** Diagonal neighbour via both orthogonal routes, or −1 (dx ∈ {0, 1}, dz ∈ {2, 3}). */
  const diag = (n: number, dx: number, dz: number): number => {
    const a = nb[n * 4 + dx]!;
    const b = nb[n * 4 + dz]!;
    if (a < 0 || b < 0) return -1;
    const viaA = nb[a * 4 + dz]!;
    return viaA >= 0 && viaA === nb[b * 4 + dx]! ? viaA : -1;
  };
  const R2 = Math.SQRT2;
  for (let n = 0; n < rawN; n++) {
    const o = n * 4;
    if (!alive[n]) dist[n] = 0;
    else if (nb[o]! < 0 || nb[o + 1]! < 0 || nb[o + 2]! < 0 || nb[o + 3]! < 0) dist[n] = 1;
    else if (diag(n, 0, 2) < 0 || diag(n, 1, 2) < 0 || diag(n, 0, 3) < 0 || diag(n, 1, 3) < 0)
      dist[n] = R2;
    else dist[n] = Infinity;
  }
  const relaxFrom = (n: number, m: number, w: number): void => {
    if (m >= 0 && dist[m]! + w < dist[n]!) dist[n] = dist[m]! + w;
  };
  for (let n = 0; n < rawN; n++) {
    if (dist[n]! <= 1) continue;
    relaxFrom(n, nb[n * 4]!, 1);
    relaxFrom(n, nb[n * 4 + 2]!, 1);
    relaxFrom(n, diag(n, 0, 2), R2);
    relaxFrom(n, diag(n, 1, 2), R2);
  }
  for (let n = rawN - 1; n >= 0; n--) {
    if (dist[n]! <= 1) continue;
    relaxFrom(n, nb[n * 4 + 1]!, 1);
    relaxFrom(n, nb[n * 4 + 3]!, 1);
    relaxFrom(n, diag(n, 0, 3), R2);
    relaxFrom(n, diag(n, 1, 3), R2);
  }
  const limit = config.agentRadius / cs;
  for (let n = 0; n < rawN; n++) if (dist[n]! < limit - 1e-6) alive[n] = 0;

  // Compact surviving nodes.
  const remap = new Int32Array(rawN).fill(-1);
  let count = 0;
  for (let n = 0; n < rawN; n++) if (alive[n]) remap[n] = count++;
  const colStart = new Int32Array(cols + 1);
  const nodeCol = new Int32Array(count);
  const nodeY = new Float32Array(count);
  const area = new Uint8Array(count);
  const neighbors = new Int32Array(count * 4).fill(-1);
  for (let n = 0; n < rawN; n++) {
    const i = remap[n]!;
    if (i < 0) continue;
    nodeCol[i] = rawCol[n]!;
    nodeY[i] = rawY[n]!;
    area[i] = rawArea[n]!;
    for (let d = 0; d < 4; d++) {
      const m = rawNb[n * 4 + d]!;
      neighbors[i * 4 + d] = m >= 0 ? remap[m]! : -1;
    }
    colStart[rawCol[n]! + 1]!++;
  }
  for (let c = 0; c < cols; c++) colStart[c + 1]! += colStart[c]!;

  // Regions by flood fill over walking links.
  const region = new Int32Array(count).fill(-1);
  let regions = 0;
  const stack = new Int32Array(count);
  for (let s = 0; s < count; s++) {
    if (region[s]! >= 0) continue;
    region[s] = regions;
    let top = 0;
    stack[top++] = s;
    while (top > 0) {
      const n = stack[--top]!;
      for (let d = 0; d < 4; d++) {
        const m = neighbors[n * 4 + d]!;
        if (m >= 0 && region[m]! < 0) {
          region[m] = regions;
          stack[top++] = m;
        }
      }
    }
    regions++;
  }

  const data: NavMeshData = {
    version: NAV_BAKE_VERSION,
    config,
    originX: g.ox,
    originZ: g.oz,
    width: g.w,
    depth: g.d,
    colStart,
    nodeCol,
    nodeY,
    neighbors,
    area,
    region,
    links: [],
    unsnappedLinks: [],
  };

  // 6. Off-mesh links.
  map.navLinks.forEach((link, index) => {
    const from = nearestNode(data, link.from.x, link.from.y, link.from.z);
    const to = nearestNode(data, link.to.x, link.to.y, link.to.z);
    if (from < 0 || to < 0 || from === to) {
      data.unsnappedLinks.push(index);
      return;
    }
    const dx = link.to.x - link.from.x;
    const dy = link.to.y - link.from.y;
    const dz = link.to.z - link.from.z;
    const cost = Math.hypot(dx, dy, dz) + LINK_PENALTY[link.kind];
    data.links.push({ index, kind: link.kind, from, to, cost });
  });
  return data;
}

/** Feet position of node `n`. */
export function nodePosition(data: NavMeshData, n: number): { x: number; y: number; z: number } {
  const c = data.nodeCol[n]!;
  const ix = c % data.width;
  const iz = (c - ix) / data.width;
  const cs = data.config.cellSize;
  return {
    x: data.originX + (ix + 0.5) * cs,
    y: data.nodeY[n]!,
    z: data.originZ + (iz + 0.5) * cs,
  };
}

/**
 * Nearest node to a feet position within the config's snap tolerances, or −1.
 * Distance is 3D; nodes beyond `maxVertical` above or below are ignored.
 */
export function nearestNode(
  data: NavMeshData,
  x: number,
  y: number,
  z: number,
  maxHorizontal = data.config.linkSnapHorizontal,
  maxVertical = data.config.linkSnapVertical,
): number {
  const cs = data.config.cellSize;
  const r = Math.ceil(maxHorizontal / cs);
  const cx = Math.floor((x - data.originX) / cs);
  const cz = Math.floor((z - data.originZ) / cs);
  let best = -1;
  let bestD = Infinity;
  for (let iz = Math.max(0, cz - r); iz <= Math.min(data.depth - 1, cz + r); iz++) {
    const dz = data.originZ + (iz + 0.5) * cs - z;
    for (let ix = Math.max(0, cx - r); ix <= Math.min(data.width - 1, cx + r); ix++) {
      const dx = data.originX + (ix + 0.5) * cs - x;
      const h2 = dx * dx + dz * dz;
      if (h2 > maxHorizontal * maxHorizontal) continue;
      const c = iz * data.width + ix;
      for (let n = data.colStart[c]!; n < data.colStart[c + 1]!; n++) {
        const dy = data.nodeY[n]! - y;
        if (Math.abs(dy) > maxVertical) continue;
        const d = h2 + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = n;
        }
      }
    }
  }
  return best;
}
