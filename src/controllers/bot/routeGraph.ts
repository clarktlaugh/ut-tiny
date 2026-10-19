/**
 * Coarse route planning over a `NavMesh` (docs/DESIGN.md §9).
 *
 * A* over the full 0.25 m grid costs 20–140 ms per query on the laundry room
 * (226k nodes), far over a frame. Bots instead search a lattice: one point
 * every `spacing` cells, each a real navmesh node. Lattice points are joined
 * by a short bounded walk over the mesh cells (`LOCAL_REACH` of walking
 * cost), so thin gates and corners connect like they do on the mesh; edges
 * that are not a straight walk remember the cells they went through. The
 * off-mesh links attach to the lattice at both ends.
 *
 * Queries between two walking regions go through portals: every link
 * endpoint keeps a precomputed walking-distance table over its region, so a
 * cross-region route is a search over a few dozen portals plus table reads.
 * Queries inside one region run A* on the lattice. The laundry room becomes
 * ~14k points and a query takes a few milliseconds at most. The result is a
 * `NavPath` like `NavMesh.findPath` returns (string-pulled walking runs
 * separated by link waypoints), so `PathFollower` cannot tell the difference.
 */
import type { FindPathOptions, NavMesh, NavPath, NavWaypoint } from '../../nav';
import { AREA_COST, LINK_TRAVERSAL } from '../../nav';
import type { NavLinkKind, Vec3 } from '../../sim/types';
import { HAZARD_PENALTY, firstHit, hazardAt, type Hazard } from './hazards';

export interface RoutePlanner {
  findPath(start: Readonly<Vec3>, goal: Readonly<Vec3>, options?: FindPathOptions): NavPath | null;
  /**
   * Ask to plan on `tick`; false means another bot already planned this tick
   * and the caller should try again next tick, so planning cost is spread.
   */
  acquire?(tick: number): boolean;
}

export interface RouteGraphOptions {
  /** Cells between lattice points (default 4: one metre at the default 0.25 m cell). */
  spacing?: number;
  /** Walking cost (m, area-weighted) explored around a node to find its neighbours. */
  localReach?: number;
  /** Ground hazards (jump pad triggers) routes avoid unless a link uses them. */
  hazards?: readonly Hazard[];
  /**
   * Heuristic weight for the lattice A* (default `HEURISTIC_WEIGHT`). Above 1
   * the search is greedier: much faster on long routes, at most that factor
   * longer than optimal, which bots do not mind.
   */
  heuristicWeight?: number;
}

/** Default heuristic weight; see `RouteGraphOptions.heuristicWeight`. */
export const HEURISTIC_WEIGHT = 1.5;

/** Default `localReach`: enough to reach the diagonal lattice neighbour with some slack. */
export const LOCAL_REACH = 2.6;

interface Edge {
  to: number;
  cost: number;
  /** Mesh nodes between the two points when the walk is not straight (excludes both ends). */
  detour: number[] | null;
}

interface LatticeLink {
  to: number;
  cost: number;
  /** `MapDef.navLinks` index. */
  index: number;
  kind: NavLinkKind;
  /** Mesh node the link leaves from and lands on. */
  from: number;
  land: number;
  /** Walk from the lattice point to `from`, and from `land` to the end lattice point. */
  approach: number[] | null;
  exit: number[] | null;
}

/** A link endpoint on the lattice with walking distances and parents over its region. */
interface Portal {
  point: number;
  dist: Float64Array;
  parent: Int32Array;
}

/** A route over lattice points; `linkAt` maps a chain index to the link that reached it. */
interface Route {
  chain: number[];
  linkAt: Map<number, number>;
  cost: number;
}

/**
 * Bounded Dijkstra result over mesh nodes: the nodes reached, in order of
 * settling, with cost and parent readable through the owning graph's scratch
 * arrays while `generation` matches.
 */
interface Reach {
  nodes: number[];
  generation: number;
}

/** Binary min-heap of (key, value) pairs. */
class Heap {
  private keys: number[] = [];
  private values: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  clear(): void {
    this.keys.length = 0;
    this.values.length = 0;
  }

  push(key: number, value: number): void {
    const k = this.keys;
    const v = this.values;
    let i = k.length;
    k.push(0);
    v.push(0);
    while (i > 0) {
      const p = (i - 1) >> 1;
      const kp = k[p]!;
      if (kp <= key) break;
      k[i] = kp;
      v[i] = v[p]!;
      i = p;
    }
    k[i] = key;
    v[i] = value;
  }

  pop(): number {
    const k = this.keys;
    const v = this.values;
    const top = v[0]!;
    const lastK = k.pop()!;
    const lastV = v.pop()!;
    const n = k.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = -1;
        let km = lastK;
        if (l < n && k[l]! < km) {
          m = l;
          km = k[l]!;
        }
        if (r < n && k[r]! < km) {
          m = r;
          km = k[r]!;
        }
        if (m < 0) break;
        k[i] = km;
        v[i] = v[m]!;
        i = m;
      }
      k[i] = lastK;
      v[i] = lastV;
    }
    return top;
  }
}

export class RouteGraph implements RoutePlanner {
  readonly nav: NavMesh;
  readonly spacing: number;
  readonly localReach: number;
  readonly hazards: readonly Hazard[];
  readonly heuristicWeight: number;
  /** Navmesh node of each lattice point. */
  private readonly nodeOf: number[] = [];
  /** Lattice point of each navmesh node, or −1. */
  private readonly latticeOf: Int32Array;
  private readonly edges: Edge[][] = [];
  private readonly links: LatticeLink[][] = [];
  /** Mesh region of each lattice point. */
  private regionOf: Int32Array = new Int32Array(0);
  /** Link endpoints with their walking-distance tables. */
  private readonly portals: Portal[] = [];
  private readonly portalOf = new Map<number, number>();
  private px: Float64Array = new Float64Array(0);
  private py: Float64Array = new Float64Array(0);
  private pz: Float64Array = new Float64Array(0);
  private g: Float64Array = new Float64Array(0);
  private parent: Int32Array = new Int32Array(0);
  private via: Int32Array = new Int32Array(0);
  private stamp: Uint32Array = new Uint32Array(0);
  private closed: Uint32Array = new Uint32Array(0);
  private generation = 0;
  private readonly heap = new Heap();
  /** Scratch for bounded walks over mesh nodes, stamped per walk. */
  private readonly meshCost: Float64Array;
  private readonly meshParent: Int32Array;
  private readonly meshStamp: Uint32Array;
  private readonly meshDone: Uint32Array;
  private meshGeneration = 0;
  private readonly meshHeap = new Heap();
  /** Links that found no lattice point within reach of one end. */
  readonly unattachedLinks: number[] = [];
  /** Plans allowed per tick across every bot sharing this graph. */
  plansPerTick = 1;
  private budgetTick = -1;
  private budgetUsed = 0;

  constructor(nav: NavMesh, options: RouteGraphOptions = {}) {
    this.nav = nav;
    this.spacing = Math.max(1, Math.round(options.spacing ?? 4));
    this.localReach = options.localReach ?? LOCAL_REACH;
    this.hazards = options.hazards ?? [];
    this.heuristicWeight = options.heuristicWeight ?? HEURISTIC_WEIGHT;
    const meshNodes = nav.nodeCount;
    this.latticeOf = new Int32Array(meshNodes).fill(-1);
    this.meshCost = new Float64Array(meshNodes);
    this.meshParent = new Int32Array(meshNodes);
    this.meshStamp = new Uint32Array(meshNodes);
    this.meshDone = new Uint32Array(meshNodes);
    this.build();
  }

  get pointCount(): number {
    return this.nodeOf.length;
  }

  acquire(tick: number): boolean {
    if (tick !== this.budgetTick) {
      this.budgetTick = tick;
      this.budgetUsed = 0;
    }
    if (this.budgetUsed >= this.plansPerTick) return false;
    this.budgetUsed++;
    return true;
  }

  /** Lattice point for a navmesh node, or −1. */
  pointOf(node: number): number {
    return this.latticeOf[node] ?? -1;
  }

  // -- Build ------------------------------------------------------------------

  private build(): void {
    const { data } = this.nav;
    const sp = this.spacing;
    const w = data.width;
    for (let iz = 0; iz < data.depth; iz += sp) {
      for (let ix = 0; ix < w; ix += sp) {
        const c = iz * w + ix;
        for (let n = data.colStart[c]!; n < data.colStart[c + 1]!; n++) {
          this.latticeOf[n] = this.nodeOf.length;
          this.nodeOf.push(n);
          this.edges.push([]);
          this.links.push([]);
        }
      }
    }
    const count = this.nodeOf.length;
    this.px = new Float64Array(count);
    this.py = new Float64Array(count);
    this.pz = new Float64Array(count);
    this.g = new Float64Array(count);
    this.parent = new Int32Array(count);
    this.via = new Int32Array(count);
    this.stamp = new Uint32Array(count);
    this.closed = new Uint32Array(count);
    this.regionOf = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      const p = this.nav.position(this.nodeOf[i]!);
      this.px[i] = p.x;
      this.py[i] = p.y;
      this.pz[i] = p.z;
      this.regionOf[i] = data.region[this.nodeOf[i]!]!;
    }
    for (let i = 0; i < count; i++) {
      const n = this.nodeOf[i]!;
      const cn = data.nodeCol[n]!;
      const ixn = cn % w;
      const izn = (cn - ixn) / w;
      const reach = this.localReachFrom(n);
      for (const m of reach.nodes) {
        const j = this.latticeOf[m]!;
        if (j < 0 || j === i) continue;
        // Lattice points up to two steps away (the second ring reaches past an
        // eroded row at a ledge gate); the walk, not a straight line, decides
        // whether they connect.
        const cm = data.nodeCol[m]!;
        const ixm = cm % w;
        if (Math.abs(ixm - ixn) > 2 * sp || Math.abs((cm - ixm) / w - izn) > 2 * sp) continue;
        const detour = this.nav.walkable(n, m) ? null : this.trace(reach, n, m);
        let cost = this.meshCost[m]!;
        if (this.crossesHazard([n, ...(detour ?? []), m])) cost += HAZARD_PENALTY;
        this.edges[i]!.push({ to: j, cost, detour });
      }
    }
    for (const l of data.links) {
      const from = this.linkStart(l.from);
      const land = this.nearestPoint(l.to);
      if (!from || !land) {
        this.unattachedLinks.push(l.index);
        continue;
      }
      this.links[from.point]!.push({
        to: land.point,
        cost: l.cost + from.cost + land.cost,
        index: l.index,
        kind: l.kind,
        from: l.from,
        land: l.to,
        approach: from.path.length ? from.path : null,
        exit: land.path.length ? land.path : null,
      });
    }
    for (let a = 0; a < count; a++) {
      for (const l of this.links[a]!) {
        for (const point of [a, l.to]) {
          if (this.portalOf.has(point)) continue;
          this.portalOf.set(point, this.portals.length);
          this.portals.push(this.walkTable(point));
        }
      }
    }
  }

  /** Walking distances from a lattice point to every point of its region (plain Dijkstra). */
  private walkTable(point: number): Portal {
    const count = this.nodeOf.length;
    const dist = new Float64Array(count).fill(Infinity);
    const parent = new Int32Array(count).fill(-1);
    const heap = this.heap;
    heap.clear();
    dist[point] = 0;
    heap.push(0, point);
    const done = new Uint8Array(count);
    while (heap.size) {
      const i = heap.pop();
      if (done[i]) continue;
      done[i] = 1;
      const di = dist[i]!;
      for (const e of this.edges[i]!) {
        const nd = di + e.cost;
        if (nd < dist[e.to]!) {
          dist[e.to] = nd;
          parent[e.to] = i;
          heap.push(nd, e.to);
        }
      }
    }
    return { point, dist, parent };
  }

  /** True when walking the node chain crosses a hazard. */
  private crossesHazard(nodes: readonly number[]): boolean {
    if (this.hazards.length === 0 || nodes.length < 2) return false;
    let a = this.nav.position(nodes[0]!);
    for (let i = 1; i < nodes.length; i++) {
      const b = this.nav.position(nodes[i]!);
      if (firstHit(a, b, this.hazards)) return true;
      a = b;
    }
    return false;
  }

  /**
   * Bounded Dijkstra over mesh nodes from `start` (orthogonal and diagonal
   * neighbours, area-weighted like `NavMesh`), up to `localReach` of cost.
   */
  private localReachFrom(start: number, bound = this.localReach): Reach {
    const { data } = this.nav;
    const cs = data.config.cellSize;
    const { meshCost: cost, meshParent: parent, meshStamp: stamp, meshDone: done } = this;
    const gen = ++this.meshGeneration;
    const heap = this.meshHeap;
    heap.clear();
    const nodes: number[] = [];
    stamp[start] = gen;
    cost[start] = 0;
    parent[start] = -1;
    heap.push(0, start);
    while (heap.size) {
      const n = heap.pop();
      if (done[n] === gen) continue;
      done[n] = gen;
      nodes.push(n);
      const gn = cost[n]!;
      const yn = data.nodeY[n]!;
      const an = AREA_COST[data.area[n]!] ?? 1;
      for (let d = 0; d < 8; d++) {
        const m =
          d < 4
            ? data.neighbors[n * 4 + d]!
            : diagonal(data.neighbors, n, d & 1, 2 + ((d >> 1) & 1));
        if (m < 0 || done[m] === gen) continue;
        const step = d < 4 ? cs : cs * Math.SQRT2;
        const am = AREA_COST[data.area[m]!] ?? 1;
        const dy = data.nodeY[m]! - yn;
        const ng = gn + (Math.sqrt(step * step + dy * dy) * (an + am)) / 2;
        if (ng > bound) continue;
        if (stamp[m] === gen && cost[m]! <= ng) continue;
        stamp[m] = gen;
        cost[m] = ng;
        parent[m] = n;
        heap.push(ng, m);
      }
    }
    return { nodes, generation: gen };
  }

  /** Mesh nodes strictly between `from` and `to` along the walk's parent chain. */
  private trace(reach: Reach, from: number, to: number): number[] {
    if (reach.generation !== this.meshGeneration) throw new Error('stale reach');
    const out: number[] = [];
    for (let n = this.meshParent[to]!; n >= 0 && n !== from; n = this.meshParent[n]!) out.push(n);
    return out.reverse();
  }

  /**
   * Lattice point a link is entered from, with the cells walked from it to
   * the link's start node. A pad with an entry point (see `hazards.ts`) is
   * entered from there, so routes reach the pad without paying the hazard
   * penalty of the edges inside its box and arrive from the right side.
   */
  private linkStart(startNode: number): { point: number; cost: number; path: number[] } | null {
    const entries = hazardAt(this.nav.position(startNode), this.hazards)?.entries ?? [];
    let entryNode = -1;
    for (const e of entries) {
      entryNode = this.nav.nearest(e, 1, 1.5);
      if (entryNode >= 0) break;
    }
    if (entryNode >= 0) {
      const near = this.nearestPoint(entryNode);
      if (near) {
        // Walk from the lattice point to the entry node, then on into the pad.
        const reach = this.localReachFrom(entryNode, this.localReach * 3);
        if (
          this.meshStamp[startNode] === reach.generation &&
          this.meshDone[startNode] === reach.generation
        ) {
          const onward = [...this.trace(reach, entryNode, startNode)];
          const cost = near.cost + this.meshCost[startNode]!;
          const path = [...near.path.slice().reverse(), entryNode, ...onward];
          return { point: near.point, cost, path };
        }
      }
    }
    // No usable entry point: attach outside the box all the same, so the
    // edges inside it, which carry the hazard penalty, are not used.
    const box = hazardAt(this.nav.position(startNode), this.hazards);
    const near = this.nearestPoint(startNode, box) ?? this.nearestPoint(startNode);
    return near ? { point: near.point, cost: near.cost, path: [...near.path].reverse() } : null;
  }

  /** Nearest lattice point by local walking cost, with the cells walked from `node` to it. */
  private nearestPoint(
    node: number,
    outside: Hazard | null = null,
  ): { point: number; cost: number; path: number[] } | null {
    for (const bound of [this.localReach, this.localReach * 3]) {
      const reach = this.localReachFrom(node, bound);
      // Nodes settle in cost order, so the first lattice point is the nearest.
      for (const m of reach.nodes) {
        const p = this.latticeOf[m]!;
        if (p < 0) continue;
        if (outside && firstHit(this.nav.position(m), this.nav.position(m), [outside])) continue;
        return { point: p, cost: this.meshCost[m]!, path: this.trace(reach, node, m) };
      }
    }
    return null;
  }

  // -- Query ------------------------------------------------------------------

  findPath(
    start: Readonly<Vec3>,
    goal: Readonly<Vec3>,
    options: FindPathOptions = {},
  ): NavPath | null {
    const s = this.nav.nearest(start);
    const t = this.nav.nearest(goal);
    if (s < 0 || t < 0) return null;
    if (s === t) return { waypoints: [{ position: this.nav.position(t) }], cost: 0 };

    // Legs from the ends to the lattice. The walks share scratch arrays, so
    // each leg's cells are copied out before the next walk runs.
    const fromS = this.localReachFrom(s);
    if (this.meshStamp[t] === fromS.generation && this.meshDone[t] === fromS.generation) {
      const nodes = [s, ...this.trace(fromS, s, t), t];
      const cost = this.meshCost[t]!;
      return { waypoints: this.toWaypoints(nodes, [], options.raw === true), cost };
    }
    const sources = this.legs(fromS, s);
    const fromT = this.localReachFrom(t);
    const targets = this.legs(fromT, t);
    if (sources.length === 0 || targets.length === 0)
      return this.nav.findPath(start, goal, options);

    // Inside one region the walking route comes from A* with the landmark
    // heuristic (no link edges, so the heuristic stays admissible); a route
    // through links may still be shorter, so the portal search competes.
    const sameRegion = sources.some((a) =>
      targets.some((b) => this.regionOf[a.point] === this.regionOf[b.point]),
    );
    const viaLinks = this.searchPortals(sources, targets, options.allowedLinks);
    let result = viaLinks;
    if (sameRegion) {
      const walked = this.search(sources, targets, t);
      if (walked && (!viaLinks || walked.cost <= viaLinks.cost)) result = walked;
    }
    if (!result) return null;
    const { chain, linkAt, cost } = result;

    // Expand the lattice chain into mesh nodes: start leg, edges (with
    // detours), link hops (approach, flight, exit), end leg.
    const nodes: number[] = [s];
    const hops: { at: number; index: number; kind: NavLinkKind }[] = [];
    const first = chain[0]!;
    nodes.push(...sources.find((x) => x.point === first)!.path, this.nodeOf[first]!);
    for (let k = 1; k < chain.length; k++) {
      const i = chain[k - 1]!;
      const j = chain[k]!;
      const linkIndex = linkAt.get(k) ?? -1;
      if (linkIndex >= 0) {
        const l = this.links[i]!.find((x) => x.index === linkIndex && x.to === j)!;
        if (l.approach) nodes.push(...l.approach);
        if (nodes[nodes.length - 1] !== l.from) nodes.push(l.from);
        hops.push({ at: nodes.length, index: l.index, kind: l.kind });
        nodes.push(l.land);
        if (l.exit) nodes.push(...l.exit);
        if (nodes[nodes.length - 1] !== this.nodeOf[j]!) nodes.push(this.nodeOf[j]!);
      } else {
        const e = this.edges[i]!.find((x) => x.to === j)!;
        if (e.detour) nodes.push(...e.detour);
        nodes.push(this.nodeOf[j]!);
      }
    }
    const last = chain[chain.length - 1]!;
    nodes.push(...[...targets.find((x) => x.point === last)!.path].reverse());
    if (nodes[nodes.length - 1] !== t) nodes.push(t);
    return { waypoints: this.toWaypoints(nodes, hops, options.raw === true), cost };
  }

  /** Lattice points inside a local walk from `from`, with cost and the cells between. */
  private legs(reach: Reach, from: number): { point: number; cost: number; path: number[] }[] {
    const out: { point: number; cost: number; path: number[] }[] = [];
    for (const m of reach.nodes) {
      const p = this.latticeOf[m]!;
      if (p < 0) continue;
      out.push({ point: p, cost: this.meshCost[m]!, path: this.trace(reach, from, m) });
    }
    return out;
  }

  /**
   * A* over lattice walking edges from any source to any target, with the
   * larger of the weighted Euclidean distance and the landmark bound from the
   * portal tables (ALT): |d(L, goal) − d(L, n)| never exceeds d(n, goal) on
   * the walking graph. Targets lie within one local reach of `t`'s point, so
   * that much is taken off the bound.
   */
  private search(
    sources: readonly { point: number; cost: number }[],
    targets: readonly { point: number; cost: number }[],
    t: number,
  ): Route | null {
    const { g, parent, via, stamp, closed, heap, px, py, pz } = this;
    const gen = ++this.generation;
    const goal = this.nav.position(t);
    const targetCost = new Map(targets.map((x) => [x.point, x.cost]));
    const w = this.heuristicWeight;
    const goalPoint = targets[0]?.point ?? -1;
    const slack = 2 * this.localReach;
    const landmarks = this.portals.filter((L) => goalPoint >= 0 && L.dist[goalPoint]! < Infinity);
    const toGoal = landmarks.map((L) => L.dist[goalPoint]!);
    const h = (i: number): number => {
      let best = w * Math.hypot(px[i]! - goal.x, py[i]! - goal.y, pz[i]! - goal.z);
      for (let k = 0; k < landmarks.length; k++) {
        const d = landmarks[k]!.dist[i]!;
        if (d === Infinity) continue;
        const bound = Math.abs(toGoal[k]! - d) - slack;
        if (bound > best) best = bound;
      }
      return best;
    };
    heap.clear();
    for (const { point, cost } of sources) {
      if (stamp[point] === gen && g[point]! <= cost) continue;
      stamp[point] = gen;
      g[point] = cost;
      parent[point] = -1;
      via[point] = -1;
      heap.push(cost + h(point), point);
    }
    let found = -1;
    while (heap.size) {
      const i = heap.pop();
      if (closed[i] === gen) continue;
      closed[i] = gen;
      if (targetCost.has(i)) {
        found = i;
        break;
      }
      const gi = g[i]!;
      const relax = (j: number, cost: number, link: number): void => {
        const ng = gi + cost;
        if (stamp[j] === gen && ng >= g[j]!) return;
        stamp[j] = gen;
        g[j] = ng;
        parent[j] = i;
        via[j] = link;
        heap.push(ng + h(j), j);
      };
      for (const e of this.edges[i]!) if (closed[e.to] !== gen) relax(e.to, e.cost, -1);
    }
    if (found < 0) return null;
    const chain: number[] = [];
    for (let i = found; i >= 0; i = parent[i]!) chain.push(i);
    chain.reverse();
    const linkAt = new Map<number, number>();
    chain.forEach((i, k) => {
      if (via[i]! >= 0) linkAt.set(k, via[i]!);
    });
    return { chain, linkAt, cost: g[found]! + targetCost.get(found)! };
  }

  /**
   * Route between regions over the portal graph: start → portal legs and
   * portal → goal legs read the tables, portals in one region connect by
   * table distance, and links connect portals across regions.
   */
  private searchPortals(
    sources: readonly { point: number; cost: number }[],
    targets: readonly { point: number; cost: number }[],
    allowed?: ReadonlySet<NavLinkKind>,
  ): Route | null {
    const P = this.portals.length;
    if (P === 0) return null;
    const START = P;
    const GOAL = P + 1;
    const dist = new Float64Array(P + 2).fill(Infinity);
    const prev = new Int32Array(P + 2).fill(-1);
    const prevLink = new Int32Array(P + 2).fill(-1);
    /** Source lattice point used to enter each portal from the start. */
    const entry = new Int32Array(P).fill(-1);
    const exit = new Int32Array(P).fill(-1);
    const done = new Uint8Array(P + 2);
    dist[START] = 0;
    for (;;) {
      let u = -1;
      for (let i = 0; i < P + 2; i++) {
        if (!done[i] && dist[i]! < Infinity && (u < 0 || dist[i]! < dist[u]!)) u = i;
      }
      if (u < 0 || u === GOAL) break;
      done[u] = 1;
      const du = dist[u]!;
      if (u === START) {
        for (let q = 0; q < P; q++) {
          const portal = this.portals[q]!;
          for (const src of sources) {
            const d = portal.dist[src.point]!;
            if (d === Infinity) continue;
            const nd = du + src.cost + d;
            if (nd < dist[q]!) {
              dist[q] = nd;
              prev[q] = START;
              prevLink[q] = -1;
              entry[q] = src.point;
            }
          }
        }
        continue;
      }
      const portal = this.portals[u]!;
      for (let q = 0; q < P; q++) {
        if (q === u || done[q]) continue;
        const d = portal.dist[this.portals[q]!.point]!;
        if (d === Infinity) continue;
        if (du + d < dist[q]!) {
          dist[q] = du + d;
          prev[q] = u;
          prevLink[q] = -1;
        }
      }
      for (const l of this.links[portal.point]!) {
        if (allowed && !allowed.has(l.kind)) continue;
        const q = this.portalOf.get(l.to)!;
        if (done[q]) continue;
        if (du + l.cost < dist[q]!) {
          dist[q] = du + l.cost;
          prev[q] = u;
          prevLink[q] = l.index;
        }
      }
      for (const tgt of targets) {
        const d = portal.dist[tgt.point]!;
        if (d === Infinity) continue;
        const nd = du + d + tgt.cost;
        if (nd < dist[GOAL]!) {
          dist[GOAL] = nd;
          prev[GOAL] = u;
          exit[u] = tgt.point;
        }
      }
    }
    if (dist[GOAL]! === Infinity) return null;

    // Portal sequence from the start, then expand into lattice points.
    const seq: number[] = [];
    for (let u = prev[GOAL]!; u >= 0 && u !== START; u = prev[u]!) seq.push(u);
    seq.reverse();
    const chain: number[] = [];
    const linkAt = new Map<number, number>();
    const first = seq[0]!;
    chain.push(...this.walkFrom(this.portals[first]!, entry[first]!));
    for (let k = 1; k < seq.length; k++) {
      const u = seq[k - 1]!;
      const q = seq[k]!;
      const link = prevLink[q]!;
      if (link >= 0) {
        chain.push(this.portals[q]!.point);
        linkAt.set(chain.length - 1, link);
      } else {
        // Walk u → q inside the region: q's table gives the path from u's point to q.
        chain.push(...this.walkFrom(this.portals[q]!, this.portals[u]!.point).slice(1));
      }
    }
    const last = seq[seq.length - 1]!;
    const tail = this.walkFrom(this.portals[last]!, exit[last]!);
    tail.reverse();
    chain.push(...tail.slice(1));
    return { chain, linkAt, cost: dist[GOAL]! };
  }

  /** Lattice points from `from` up to the portal's point, following its parent tree. */
  private walkFrom(portal: Portal, from: number): number[] {
    const out: number[] = [];
    for (let i = from; i >= 0; i = portal.parent[i]!) {
      out.push(i);
      if (i === portal.point) break;
    }
    return out;
  }

  /** Same shape as `NavMesh.findPath`: walking runs string-pulled, link landings marked. */
  private toWaypoints(
    nodes: number[],
    hops: readonly { at: number; index: number; kind: NavLinkKind }[],
    raw: boolean,
  ): NavWaypoint[] {
    const out: NavWaypoint[] = [];
    const hopAt = new Map(hops.map((l) => [l.at, l]));
    let runStart = 0;
    const flush = (end: number): void => {
      const run = nodes.slice(runStart, end + 1);
      const keep = raw ? dedupe(run) : this.pull(run);
      for (let k = runStart === 0 ? 0 : 1; k < keep.length; k++) {
        out.push({ position: this.nav.position(keep[k]!) });
      }
    };
    for (let i = 1; i < nodes.length; i++) {
      const l = hopAt.get(i);
      if (!l) continue;
      flush(i - 1);
      out.push({
        position: this.nav.position(nodes[i]!),
        link: { index: l.index, kind: l.kind, steps: LINK_TRAVERSAL[l.kind] },
      });
      runStart = i;
    }
    flush(nodes.length - 1);
    return out;
  }

  /** Greedy string-pulling with the mesh's straight-walk test (as `NavMesh` does). */
  private pull(run: number[]): number[] {
    const compact = dedupe(run);
    if (compact.length <= 2) return compact;
    const out = [compact[0]!];
    let anchor = 0;
    while (anchor < compact.length - 1) {
      let next = anchor + 1;
      for (let j = anchor + 2; j < compact.length; j++) {
        if (
          this.nav.walkable(compact[anchor]!, compact[j]!) &&
          !this.shortcutHits(compact, anchor, j)
        ) {
          next = j;
        } else break;
      }
      out.push(compact[next]!);
      anchor = next;
    }
    return out;
  }

  /** A straight shortcut may not cross a hazard the cell-by-cell walk avoided. */
  private shortcutHits(run: readonly number[], a: number, b: number): boolean {
    if (this.hazards.length === 0) return false;
    const pa = this.nav.position(run[a]!);
    const pb = this.nav.position(run[b]!);
    if (!firstHit(pa, pb, this.hazards)) return false;
    return !this.crossesHazard(run.slice(a, b + 1));
  }
}

function dedupe(run: readonly number[]): number[] {
  const out: number[] = [];
  for (const n of run) if (out[out.length - 1] !== n) out.push(n);
  return out;
}

/** Diagonal neighbour reachable through both orthogonal routes, or −1 (as `NavMesh`). */
function diagonal(nb: Int32Array, n: number, dx: number, dz: number): number {
  const a = nb[n * 4 + dx]!;
  const b = nb[n * 4 + dz]!;
  if (a < 0 || b < 0) return -1;
  const m = nb[a * 4 + dz]!;
  return m >= 0 && m === nb[b * 4 + dx]! ? m : -1;
}

const graphs = new WeakMap<NavMesh, RouteGraph>();

/**
 * The shared `RouteGraph` for a mesh, built on first use with `options`;
 * later calls return the same graph whatever they pass.
 */
export function routeGraphFor(nav: NavMesh, options: RouteGraphOptions = {}): RouteGraph {
  let g = graphs.get(nav);
  if (!g) {
    g = new RouteGraph(nav, options);
    graphs.set(nav, g);
  }
  return g;
}
