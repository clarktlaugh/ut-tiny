/**
 * Path queries over a baked `NavMeshData` (docs/DESIGN.md §9): nearest point,
 * A* across walking cells and off-mesh links, and string-pulled waypoints a
 * bot controller can steer along.
 */
import type { NavLinkKind, Vec3 } from '../sim/types';
import { MinHeap, nearestNode, nodePosition, type NavMeshData } from './bake';
import { AREA_COST, LINK_TRAVERSAL, type NavLinkStep } from './config';

export interface NavWaypoint {
  position: Vec3;
  /** Set when this waypoint is reached by an off-mesh link from the previous one. */
  link?: { index: number; kind: NavLinkKind; steps: readonly NavLinkStep[] };
}

export interface NavPath {
  waypoints: NavWaypoint[];
  /** Total A* cost (meters weighted by area, plus link penalties). */
  cost: number;
}

export interface FindPathOptions {
  /** Link kinds the agent may use; all kinds when omitted (e.g. drop `translocate` for low skill). */
  allowedLinks?: ReadonlySet<NavLinkKind>;
  /** Skip string-pulling and return one waypoint per cell (debugging). */
  raw?: boolean;
}

export class NavMesh {
  readonly data: NavMeshData;
  /** Outgoing links per node, as indices into `data.links`. */
  private readonly outLinks = new Map<number, number[]>();
  private readonly g: Float64Array;
  private readonly parent: Int32Array;
  /** Link used to reach the node (index into `data.links`), −1 for walking. */
  private readonly via: Int32Array;
  private readonly stamp: Uint32Array;
  private readonly closed: Uint32Array;
  private generation = 0;
  private readonly heap = new MinHeap();

  constructor(data: NavMeshData) {
    this.data = data;
    data.links.forEach((l, i) => {
      const list = this.outLinks.get(l.from) ?? [];
      list.push(i);
      this.outLinks.set(l.from, list);
    });
    const n = data.nodeY.length;
    this.g = new Float64Array(n);
    this.parent = new Int32Array(n);
    this.via = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.closed = new Uint32Array(n);
  }

  get nodeCount(): number {
    return this.data.nodeY.length;
  }

  /** Nearest node to a feet position, or −1 (see `nearestNode`). */
  nearest(p: Vec3, maxHorizontal?: number, maxVertical?: number): number {
    return nearestNode(this.data, p.x, p.y, p.z, maxHorizontal, maxVertical);
  }

  /** Nearest point on the mesh to `p`, or null when nothing is within the snap tolerances. */
  closestPoint(p: Vec3): Vec3 | null {
    const n = this.nearest(p);
    return n < 0 ? null : nodePosition(this.data, n);
  }

  position(node: number): Vec3 {
    return nodePosition(this.data, node);
  }

  /** Path from `start` to `goal` (feet positions), or null when none exists. */
  findPath(start: Vec3, goal: Vec3, options: FindPathOptions = {}): NavPath | null {
    const s = this.nearest(start);
    const t = this.nearest(goal);
    if (s < 0 || t < 0) return null;
    const nodes = this.search(s, t, options.allowedLinks);
    if (!nodes) return null;
    const cost = this.g[t]!;
    return { waypoints: this.toWaypoints(nodes, options.raw === true), cost };
  }

  /** A*; returns the node sequence from `s` to `t`. */
  private search(s: number, t: number, allowed?: ReadonlySet<NavLinkKind>): number[] | null {
    const { data, g, parent, via, stamp, closed, heap } = this;
    const gen = ++this.generation;
    const cs = data.config.cellSize;
    const goal = nodePosition(data, t);
    const h = (n: number): number => {
      const p = nodePosition(data, n);
      return Math.hypot(p.x - goal.x, p.y - goal.y, p.z - goal.z);
    };
    const relax = (from: number, to: number, cost: number, link: number): void => {
      const ng = g[from]! + cost;
      if (stamp[to] === gen && ng >= g[to]!) return;
      stamp[to] = gen;
      g[to] = ng;
      parent[to] = from;
      via[to] = link;
      heap.push(ng + h(to), to);
    };
    heap.clear();
    stamp[s] = gen;
    g[s] = 0;
    parent[s] = -1;
    via[s] = -1;
    heap.push(h(s), s);
    while (heap.size) {
      const n = heap.pop();
      if (closed[n] === gen) continue;
      closed[n] = gen;
      if (n === t) break;
      const yn = data.nodeY[n]!;
      const an = AREA_COST[data.area[n]!] ?? 1;
      for (let d = 0; d < 4; d++) {
        const m = data.neighbors[n * 4 + d]!;
        if (m < 0 || closed[m] === gen) continue;
        const w = (an + (AREA_COST[data.area[m]!] ?? 1)) / 2;
        relax(n, m, Math.hypot(cs, data.nodeY[m]! - yn) * w, -1);
      }
      for (const dx of [0, 1]) {
        for (const dz of [2, 3]) {
          const m = this.diagonal(n, dx, dz);
          if (m < 0 || closed[m] === gen) continue;
          const w = (an + (AREA_COST[data.area[m]!] ?? 1)) / 2;
          relax(n, m, Math.hypot(cs * Math.SQRT2, data.nodeY[m]! - yn) * w, -1);
        }
      }
      for (const li of this.outLinks.get(n) ?? []) {
        const l = data.links[li]!;
        if (allowed && !allowed.has(l.kind)) continue;
        if (closed[l.to] !== gen) relax(n, l.to, l.cost, li);
      }
    }
    if (closed[t] !== gen) return null;
    const out: number[] = [];
    for (let n = t; n >= 0; n = parent[n]!) out.push(n);
    return out.reverse();
  }

  /** Diagonal neighbour reachable through both orthogonal routes, or −1. */
  private diagonal(n: number, dx: number, dz: number): number {
    const nb = this.data.neighbors;
    const a = nb[n * 4 + dx]!;
    const b = nb[n * 4 + dz]!;
    if (a < 0 || b < 0) return -1;
    const m = nb[a * 4 + dz]!;
    return m >= 0 && m === nb[b * 4 + dx]! ? m : -1;
  }

  /**
   * True when an agent can walk straight from node `a` to node `b` cell by
   * cell (grid DDA through orthogonal neighbours), staying on `a`'s area or plain floor.
   */
  walkable(a: number, b: number): boolean {
    const { data } = this;
    const w = data.width;
    const ca = data.nodeCol[a]!;
    const cb = data.nodeCol[b]!;
    let ix = ca % w;
    let iz = (ca - ix) / w;
    const bx = cb % w;
    const bz = (cb - bx) / w;
    const dx = bx - ix;
    const dz = bz - iz;
    const stepX = Math.sign(dx);
    const stepZ = Math.sign(dz);
    const tdx = dx === 0 ? Infinity : 1 / Math.abs(dx);
    const tdz = dz === 0 ? Infinity : 1 / Math.abs(dz);
    let tx = tdx / 2;
    let tz = tdz / 2;
    const areaA = data.area[a]!;
    let n = a;
    const step = (dir: number): boolean => {
      n = data.neighbors[n * 4 + dir]!;
      if (n < 0) return false;
      const ar = data.area[n]!;
      return ar === 0 || ar === areaA;
    };
    const dirX = stepX < 0 ? 0 : 1;
    const dirZ = stepZ < 0 ? 2 : 3;
    while (ix !== bx || iz !== bz) {
      if (tx < tz - 1e-9) {
        if (!step(dirX)) return false;
        ix += stepX;
        tx += tdx;
      } else if (tz < tx - 1e-9) {
        if (!step(dirZ)) return false;
        iz += stepZ;
        tz += tdz;
      } else {
        // Exact corner: both cells beside it must be open.
        const before = n;
        if (!step(dirX) || !step(dirZ)) return false;
        const viaX = n;
        n = before;
        if (!step(dirZ) || !step(dirX) || n !== viaX) return false;
        ix += stepX;
        iz += stepZ;
        tx += tdx;
        tz += tdz;
      }
    }
    return n === b;
  }

  private toWaypoints(nodes: number[], raw: boolean): NavWaypoint[] {
    const out: NavWaypoint[] = [];
    // Split into walking runs separated by link hops; each run starts on the
    // node the previous link landed on, which is already in `out`.
    let runStart = 0;
    const flush = (end: number): void => {
      const run = nodes.slice(runStart, end + 1);
      const keep = raw ? run : this.pull(run);
      for (let k = runStart === 0 ? 0 : 1; k < keep.length; k++) {
        out.push({ position: nodePosition(this.data, keep[k]!) });
      }
    };
    for (let i = 1; i < nodes.length; i++) {
      const link = this.via[nodes[i]!]!;
      if (link < 0) continue;
      flush(i - 1);
      const l = this.data.links[link]!;
      out.push({
        position: nodePosition(this.data, nodes[i]!),
        link: { index: l.index, kind: l.kind, steps: LINK_TRAVERSAL[l.kind] },
      });
      runStart = i;
    }
    flush(nodes.length - 1);
    return out;
  }

  /** Greedy string-pulling: keep a node only when the next one is not in straight reach. */
  private pull(run: number[]): number[] {
    if (run.length <= 2) return run;
    const out = [run[0]!];
    let anchor = 0;
    while (anchor < run.length - 1) {
      let next = anchor + 1;
      for (let j = anchor + 2; j < run.length; j++) {
        if (this.walkable(run[anchor]!, run[j]!)) next = j;
        else break;
      }
      out.push(run[next]!);
      anchor = next;
    }
    return out;
  }
}
