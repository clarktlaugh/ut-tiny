/**
 * Path following over the navmesh (docs/DESIGN.md §9): plan with
 * `NavMesh.findPath`, walk the string-pulled waypoints, and traverse off-mesh
 * links with the input steps they carry (`walkOnto` for pads and drops,
 * `jump`, `doubleJumpAtApex`). The output is a horizontal move direction
 * plus jump / dodge requests; the controller turns those into an
 * `InputCommand` relative to the yaw it chooses, so looking stays decoupled
 * from moving.
 *
 * Robustness: progress toward the current waypoint is watched and a stalled
 * pawn gets a nudge (replan, hop, sidestep); after `MAX_NUDGES` the goal is
 * reported unreachable. A link that fails to land the pawn on its far side
 * twice is blocked for a minute, and a path through a blocked link counts as
 * unreachable. All randomness comes from the caller's seeded `Rng`.
 */
import type { NavLinkStep, NavMesh, NavPath, NavWaypoint } from '../../nav';
import { DEFAULT_MOVEMENT, feetOffset, type MovementConfig } from '../../sim/movement';
import { PAWN_CAPSULE } from '../../sim/physics';
import type { Rng } from '../../sim/rng';
import { TICK_RATE, type NavLinkKind, type PawnState, type Tick, type Vec3 } from '../../sim/types';
import { copy, horizontalDirection, horizontalDistance } from './math';
import { detourAround, firstHit, hazardAt, type Hazard } from './hazards';
import { routeGraphFor, type RoutePlanner } from './routeGraph';

/** A plain waypoint is reached within this horizontal distance, m. */
export const WAYPOINT_REACH = 0.6;
/** ...and this vertical distance, m. */
export const WAYPOINT_REACH_VERTICAL = 1.5;
/** Replan when the goal moves this far from the planned one, m. */
export const GOAL_REPLAN_DISTANCE = 1.5;
/** A goal this far from the planned one is a new goal and replans at once, m. */
export const NEW_GOAL_DISTANCE = 6;
/** Arrival counts only within this distance of the goal (nearest-node snap is 2 m), m. */
export const ARRIVE_TOLERANCE = 3;
/** Minimum seconds between replans for a moving goal. */
export const REPLAN_INTERVAL = 0.5;
/** Seconds without progress toward the waypoint before a nudge. */
export const STUCK_SECONDS = 1.5;
/** Progress smaller than this does not count, m. */
export const STUCK_PROGRESS = 0.25;
/** Nudges before the goal is given up. */
export const MAX_NUDGES = 3;
/** Seconds a nudge sidestep lasts. */
export const NUDGE_SECONDS = 0.4;
/** Seconds a link may take before it counts as failed. */
export const LINK_TIMEOUT_SECONDS = 5;
/** Link failures before the link is blocked. */
export const LINK_FAILURES_TO_BLOCK = 2;
/** Seconds a blocked link stays blocked. */
export const LINK_BLOCK_SECONDS = 60;
/** Pad flights whose landing is farther than this from the apex get a dodge toward it, m. */
export const PAD_DODGE_DISTANCE = 2.5;
/** Vertical speed that marks an unplanned flight (a pad or a blast), m/s; jumps stay under it. */
export const FLIGHT_SPEED = 9;
/** Seconds of travel the edge guard looks ahead for a drop off the mesh. */
export const EDGE_LOOKAHEAD = 0.12;
/** Extra distance beyond the braking distance the edge guard keeps from a drop, m. */
export const EDGE_MARGIN = 0.5;
/** Weight of the sideways velocity the steering fights, so turns do not drift off ledges. */
export const DRIFT_GAIN = 2;

export type FollowStatus = 'idle' | 'moving' | 'arrived' | 'unreachable';

export interface FollowStep {
  /** Horizontal unit direction to move in, or null to stand still. */
  move: Vec3 | null;
  /** Press Jump this tick. */
  jump: boolean;
  /** Dodge toward this horizontal direction this tick, if set. */
  dodge: Vec3 | null;
  /** A point to look toward when nothing more important needs the view. */
  lookAt: Vec3 | null;
  status: FollowStatus;
}

export interface PathFollowerOptions {
  allowedLinks: ReadonlySet<NavLinkKind>;
  movement?: Readonly<MovementConfig>;
  /** Route planner; defaults to the shared `RouteGraph` for the mesh (built with `hazards`). */
  planner?: RoutePlanner;
  /** Jump pad triggers to walk around unless a link uses them (`padHazards`). */
  hazards?: readonly Hazard[];
}

interface LinkTraversal {
  /** Index of the landing waypoint in the path. */
  waypoint: number;
  /** `MapDef.navLinks` index. */
  index: number;
  kind: NavLinkKind;
  steps: readonly NavLinkStep[];
  startTick: Tick;
  /** Left the ground since the traversal began. */
  airborne: boolean;
  jumped: boolean;
  doubleJumped: boolean;
  dodged: boolean;
  /** Jump was pressed on the previous tick (the mover needs a release between presses). */
  jumpHeld: boolean;
}

const IDLE: Readonly<FollowStep> = Object.freeze({
  move: null,
  jump: false,
  dodge: null,
  lookAt: null,
  status: 'idle',
});

/** Feet position of a (standing) pawn from its capsule center. */
export function feetOf(pawn: Readonly<Pick<PawnState, 'position'>>): Vec3 {
  const p = pawn.position;
  return { x: p.x, y: p.y - feetOffset(PAWN_CAPSULE), z: p.z };
}

export class PathFollower {
  private readonly nav: NavMesh;
  private readonly planner: RoutePlanner;
  private readonly hazards: readonly Hazard[];
  private readonly allowedLinks: ReadonlySet<NavLinkKind>;
  private readonly movement: Readonly<MovementConfig>;
  private goal: Vec3 | null = null;
  private plannedGoal: Vec3 | null = null;
  private path: NavPath | null = null;
  private index = 0;
  private link: LinkTraversal | null = null;
  private lastPlanTick = -Infinity;
  private planDue = true;
  private bestDistance = Infinity;
  private progressTick = 0;
  private nudges = 0;
  private falseArrivals = 0;
  private nudgeUntil = 0;
  private nudgeDir: Vec3 | null = null;
  /** Airborne outside a link traversal (launched or knocked): wait, then replan on landing. */
  private inFlight = false;
  /** Pad entry point reached for the link start at this waypoint index, if any. */
  private padEntryDone = -1;
  private status: FollowStatus = 'idle';
  private readonly linkFailures = new Map<number, number>();
  private readonly blockedLinks = new Map<number, Tick>();
  /** Regions reachable from a start region, cached until the blocked links change. */
  private readonly reachCache = new Map<number, Set<number>>();
  private reachVersion = 0;
  private reachCacheVersion = -1;

  constructor(nav: NavMesh, options: PathFollowerOptions) {
    this.nav = nav;
    this.hazards = options.hazards ?? [];
    this.planner = options.planner ?? routeGraphFor(nav, { hazards: this.hazards });
    this.allowedLinks = options.allowedLinks;
    this.movement = options.movement ?? DEFAULT_MOVEMENT;
  }

  /** Where the follower is heading (feet position), or null. */
  get target(): Readonly<Vec3> | null {
    return this.goal;
  }

  /** Current path's waypoints, for debugging and tests. */
  get waypoints(): readonly NavWaypoint[] {
    return this.path?.waypoints ?? [];
  }

  get currentStatus(): FollowStatus {
    return this.status;
  }

  /** The off-mesh link being traversed, for debugging and tests. */
  get currentLink(): { index: number; kind: NavLinkKind; airborne: boolean } | null {
    const L = this.link;
    return L ? { index: L.index, kind: L.kind, airborne: L.airborne } : null;
  }

  /** Links this follower refuses to use right now (`MapDef.navLinks` indices). */
  blocked(tick: Tick): number[] {
    return [...this.blockedLinks].filter(([, until]) => until > tick).map(([i]) => i);
  }

  /**
   * Whether a path from `from` to `to` can exist: both snap to the mesh and
   * `to`'s walking region is reachable from `from`'s through allowed, unblocked
   * links. Exact for the region graph and far cheaper than a failed A*, which
   * has to exhaust everything reachable.
   */
  canReach(from: Readonly<Vec3>, to: Readonly<Vec3>, tick: Tick): boolean {
    const a = this.nav.nearest(from);
    const b = this.nav.nearest(to);
    if (a < 0 || b < 0) return false;
    const { region } = this.nav.data;
    const ra = region[a]!;
    const rb = region[b]!;
    if (ra === rb) return true;
    return this.reachableRegions(ra, tick).has(rb);
  }

  private reachableRegions(start: number, tick: Tick): Set<number> {
    for (const [link, until] of this.blockedLinks) {
      if (until <= tick) {
        this.blockedLinks.delete(link);
        this.reachVersion++;
      }
    }
    if (this.reachCacheVersion !== this.reachVersion) {
      this.reachCache.clear();
      this.reachCacheVersion = this.reachVersion;
    }
    let set = this.reachCache.get(start);
    if (set) return set;
    const { region, links } = this.nav.data;
    const edges = new Map<number, number[]>();
    for (const l of links) {
      if (!this.allowedLinks.has(l.kind) || this.isBlocked(l.index, tick)) continue;
      const from = region[l.from]!;
      const to = region[l.to]!;
      if (from === to) continue;
      const list = edges.get(from) ?? [];
      list.push(to);
      edges.set(from, list);
    }
    set = new Set<number>([start]);
    const queue = [start];
    while (queue.length) {
      const r = queue.pop()!;
      for (const next of edges.get(r) ?? []) {
        if (!set.has(next)) {
          set.add(next);
          queue.push(next);
        }
      }
    }
    this.reachCache.set(start, set);
    return set;
  }

  /**
   * Head for `goal` (a feet position; pickups and pawn centers within 2 m
   * snap fine). A goal far from the planned one replans at once; small drift
   * (a moving enemy) is throttled by `REPLAN_INTERVAL`.
   */
  setGoal(goal: Readonly<Vec3>): void {
    this.goal = copy(goal);
    const planned = this.plannedGoal;
    const drift = planned
      ? horizontalDistance(planned, goal) + Math.abs(planned.y - goal.y)
      : Infinity;
    if (drift > NEW_GOAL_DISTANCE) {
      this.planDue = true;
      this.nudges = 0;
      this.falseArrivals = 0;
    }
    if (this.status !== 'moving' && drift > 1e-6) this.status = 'moving';
  }

  /** Drop the goal and the path. */
  clear(): void {
    this.goal = null;
    this.plannedGoal = null;
    this.path = null;
    this.link = null;
    this.index = 0;
    this.status = 'idle';
    this.planDue = true;
    this.nudges = 0;
    this.falseArrivals = 0;
    this.nudgeDir = null;
    this.inFlight = false;
  }

  /** Forget the path (keep the goal), e.g. after a respawn or teleport. */
  reset(): void {
    this.path = null;
    this.link = null;
    this.index = 0;
    this.planDue = true;
    this.nudges = 0;
    this.falseArrivals = 0;
    this.nudgeDir = null;
    this.inFlight = false;
    if (this.goal) this.status = 'moving';
  }

  /** One tick of steering for a live pawn. */
  update(tick: Tick, pawn: Readonly<PawnState>, rng: Rng): FollowStep {
    if (!this.goal) return { ...IDLE };
    if (this.status === 'arrived' || this.status === 'unreachable') {
      return { ...IDLE, status: this.status };
    }
    const feet = feetOf(pawn);

    if (this.link) {
      const path = this.path;
      if (path) return this.traverse(tick, pawn, feet, path, rng);
      this.link = null;
    }

    // A pad launches the pawn before it reaches the link start (the trigger
    // is wider than the reach radius): airborne near the start of a link,
    // treat the flight as that link's traversal, dodge and landing control
    // included, rather than as an accident.
    if (!pawn.grounded && this.path && this.status === 'moving') {
      const start = this.path.waypoints[this.index];
      const next = this.path.waypoints[this.index + 1];
      if (start && !start.link && next?.link && horizontalDistance(feet, start.position) < 4) {
        this.index++;
        this.link = {
          waypoint: this.index,
          index: next.link.index,
          kind: next.link.kind,
          steps: next.link.steps,
          startTick: tick,
          airborne: true,
          jumped: false,
          doubleJumped: false,
          dodged: false,
          jumpHeld: false,
        };
        return this.traverse(tick, pawn, feet, this.path, rng);
      }
    }

    // Launched or knocked into the air: do not steer (air control would pull
    // the pawn off a pad's safe landing); replan from wherever it lands.
    if (this.inFlight) {
      if (!pawn.grounded) return { ...IDLE, status: 'moving', move: this.flightEscape(pawn, feet) };
      this.inFlight = false;
      this.planDue = true;
    } else if (!pawn.grounded && Math.abs(pawn.velocity.y) > FLIGHT_SPEED) {
      this.inFlight = true;
      return { ...IDLE, status: 'moving', move: this.flightEscape(pawn, feet) };
    }

    if (this.needsPlan(tick)) {
      // No node under an airborne pawn is not a failure: wait for the ground.
      if (!pawn.grounded) return { ...IDLE, status: 'moving' };
      // The planner spreads its cost over ticks; keep the old path meanwhile.
      if (this.planner.acquire && !this.planner.acquire(tick)) {
        if (!this.path) return { ...IDLE, status: 'moving' };
      } else if (!this.plan(tick, feet)) {
        return { ...IDLE, status: 'unreachable' };
      }
    }
    const path = this.path;
    if (!path) return { ...IDLE, status: 'unreachable' };

    // Skip every plain waypoint already reached.
    let wp = path.waypoints[this.index];
    while (wp && !wp.link && this.reached(feet, wp.position)) {
      this.index++;
      this.resetProgress(tick);
      this.nudges = 0;
      wp = path.waypoints[this.index];
    }
    if (!wp) return this.arrive(tick, feet, pawn, rng);
    // A pad or ledge can launch the pawn before it reaches the link start
    // (pad triggers are wider than the reach radius), so an airborne pawn
    // whose next waypoint is a link starts that link now.
    const next = path.waypoints[this.index + 1];
    if (!wp.link && !pawn.grounded && next?.link) {
      this.index++;
      wp = next;
    }
    if (wp.link) {
      this.link = {
        waypoint: this.index,
        index: wp.link.index,
        kind: wp.link.kind,
        steps: wp.link.steps,
        startTick: tick,
        airborne: !pawn.grounded,
        jumped: false,
        doubleJumped: false,
        dodged: false,
        jumpHeld: false,
      };
      return this.traverse(tick, pawn, feet, path, rng);
    }

    // Walk around a pad in the way, unless this waypoint is a link start (the
    // pad is the link) or the pawn is already inside the hazard box. A pad
    // that is the link is entered through its entry point, so the launch
    // starts as far back along the arc as the trigger allows.
    let aim: Vec3 = wp.position;
    const nextLink = path.waypoints[this.index + 1]?.link;
    const entry = this.padEntry(wp.position, nextLink?.kind);
    if (entry && !this.entered(entry, feet)) aim = entry;
    if (!nextLink || aim === entry) {
      const hit = firstHit(feet, aim, this.hazards);
      if (hit && !firstHit(feet, feet, this.hazards)) {
        const around = detourAround(
          feet,
          aim,
          hit,
          this.hazards,
          (p) => this.nav.nearest(p, 0.4, 1.2) >= 0,
        );
        if (around) {
          aim = around;
        } else {
          // No way round a pad we are not using: the goal is not worth the launch.
          this.status = 'unreachable';
          return { ...IDLE, status: 'unreachable' };
        }
      }
    }
    const dir = horizontalDirection(feet, aim);
    let move = dir ? this.steer(pawn, dir) : null;
    if (move && nextLink && (nextLink.kind === 'jump' || nextLink.kind === 'doubleJump')) {
      // Approach a jump link at the speed its hop needs, not flat out.
      const next = path.waypoints[this.index + 1]!;
      const scale =
        this.linkSpeed(wp.position, next.position, nextLink.kind) / this.movement.groundSpeed;
      move = { x: move.x * scale, y: 0, z: move.z * scale };
    }
    const step: FollowStep = {
      move,
      jump: false,
      dodge: null,
      lookAt: lookPoint(wp.position),
      status: 'moving',
    };
    if (pawn.grounded) this.watchProgress(tick, pawn, feet, wp.position, step, rng);
    else this.progressTick = tick;
    return step;
  }

  /** True when a feet position lies inside a hazard box. */
  inHazard(p: Readonly<Vec3>): boolean {
    return firstHit(p, p, this.hazards) !== null;
  }

  /** True when a short step from the pawn in `dir` stays on the mesh and out of hazards. */
  canStep(pawn: Readonly<PawnState>, dir: Readonly<Vec3>, reach = 1.6): boolean {
    const feet = feetOf(pawn);
    const probe = { x: feet.x + dir.x * reach, y: feet.y, z: feet.z + dir.z * reach };
    if (this.nav.nearest(probe, 0.4, 1) < 0) return false;
    return !firstHit(feet, probe, this.hazards) || firstHit(feet, feet, this.hazards) !== null;
  }

  /**
   * Move input for a ground pawn that wants to go `dir`: lean against the
   * sideways part of the current velocity so a turn does not drift, and brake
   * outright when the next tenth of a second would carry the feet off the mesh
   * or into a hazard.
   */
  steer(pawn: Readonly<PawnState>, dir: Readonly<Vec3>): Vec3 {
    if (!pawn.grounded) return copy(dir);
    const feet = feetOf(pawn);
    const v = pawn.velocity;
    const speed = Math.hypot(v.x, v.z);
    if (speed > 1 && (this.offMesh(feet, v) || this.intoHazard(feet, v))) {
      return { x: -v.x / speed, y: 0, z: -v.z / speed };
    }
    const along = v.x * dir.x + v.z * dir.z;
    const px = v.x - dir.x * along;
    const pz = v.z - dir.z * along;
    const max = this.movement.groundSpeed;
    const wx = dir.x * max - DRIFT_GAIN * px;
    const wz = dir.z * max - DRIFT_GAIN * pz;
    const len = Math.hypot(wx, wz);
    return len > 1e-6 ? { x: wx / len, y: 0, z: wz / len } : copy(dir);
  }

  /** Entry point of the pad a `pad` link starts on at `start`, when it has one. */
  private padEntry(start: Readonly<Vec3>, kind: NavLinkKind | undefined): Vec3 | null {
    if (kind !== 'pad') return null;
    const entries = hazardAt(start, this.hazards)?.entries ?? [];
    return entries.find((e) => this.nav.nearest(e, 0.6, 1.5) >= 0) ?? null;
  }

  /** True once the pawn has reached the pad entry point for the current link start. */
  private entered(entry: Readonly<Vec3>, feet: Readonly<Vec3>): boolean {
    if (this.padEntryDone === this.index) return true;
    if (horizontalDistance(feet, entry) > WAYPOINT_REACH) return false;
    this.padEntryDone = this.index;
    return true;
  }

  /** True when the next tenth of a second of travel enters a hazard the pawn is not in, outside a link. */
  private intoHazard(feet: Readonly<Vec3>, v: Readonly<Vec3>): boolean {
    if (this.hazards.length === 0 || this.link) return false;
    const next = this.path?.waypoints[this.index + 1];
    if (next?.link && (next.link.kind !== 'pad' || this.padEntryDone === this.index)) return false;
    const ahead = { x: feet.x + v.x * EDGE_LOOKAHEAD, y: feet.y, z: feet.z + v.z * EDGE_LOOKAHEAD };
    return (
      firstHit(feet, ahead, this.hazards) !== null && firstHit(feet, feet, this.hazards) === null
    );
  }

  /**
   * True when `feet` is on the mesh but the stopping point is not (a ledge or
   * a hole): the braking distance at the current speed plus a margin, never
   * less than the lookahead window.
   */
  private offMesh(feet: Readonly<Vec3>, v: Readonly<Vec3>): boolean {
    const speed = Math.hypot(v.x, v.z);
    if (speed < 1e-6) return false;
    const accel = this.movement.groundSpeed / Math.max(this.movement.groundAccelTime, 1e-3);
    const stop = Math.max(speed * EDGE_LOOKAHEAD, (speed * speed) / (2 * accel) + EDGE_MARGIN);
    const ahead = { x: feet.x + (v.x / speed) * stop, y: feet.y, z: feet.z + (v.z / speed) * stop };
    if (this.nav.nearest(ahead, 0.3, 1.2) >= 0) return false;
    return this.nav.nearest(feet, 0.3, 1.2) >= 0;
  }

  /**
   * Air control for an unplanned flight. A pad that throws the pawn straight
   * up would catch it again on landing, so drift toward the current waypoint;
   * any other flight is left alone, since air control would pull the pawn off
   * a pad's intended landing.
   */
  private flightEscape(pawn: Readonly<PawnState>, feet: Readonly<Vec3>): Vec3 | null {
    const v = pawn.velocity;
    if (Math.hypot(v.x, v.z) > 1.5) return null;
    const wp = this.path?.waypoints[this.index]?.position;
    if (!wp) return null;
    return horizontalDirection(feet, wp);
  }

  /** Out of waypoints: arrived if the goal is really here, else the path was stale. */
  private arrive(
    tick: Tick,
    feet: Readonly<Vec3>,
    pawn: Readonly<PawnState>,
    rng: Rng,
  ): FollowStep {
    const goal = this.goal;
    const near =
      !goal ||
      (horizontalDistance(feet, goal) <= ARRIVE_TOLERANCE &&
        Math.abs(feet.y - goal.y) <= ARRIVE_TOLERANCE);
    if (near || this.falseArrivals >= 2) {
      this.status = near ? 'arrived' : 'unreachable';
      return { ...IDLE, status: this.status };
    }
    this.falseArrivals++;
    this.planDue = true;
    return this.update(tick, pawn, rng);
  }

  // -- Planning ---------------------------------------------------------------

  private needsPlan(tick: Tick): boolean {
    if (this.planDue || !this.path) return true;
    if (!this.goal || !this.plannedGoal) return true;
    const moved =
      horizontalDistance(this.goal, this.plannedGoal) + Math.abs(this.goal.y - this.plannedGoal.y);
    return moved > GOAL_REPLAN_DISTANCE && tick - this.lastPlanTick >= REPLAN_INTERVAL * TICK_RATE;
  }

  private plan(tick: Tick, feet: Readonly<Vec3>): boolean {
    if (!this.goal) return false;
    this.planDue = false;
    this.lastPlanTick = tick;
    this.plannedGoal = copy(this.goal);
    this.link = null;
    this.index = 0;
    this.padEntryDone = -1;
    this.resetProgress(tick);
    if (this.inHazard(this.goal) || !this.canReach(feet, this.goal, tick)) {
      this.path = null;
      this.status = 'unreachable';
      return false;
    }
    const path = this.planner.findPath(feet, this.goal, { allowedLinks: this.allowedLinks });
    if (!path || path.waypoints.some((w) => w.link && this.isBlocked(w.link.index, tick))) {
      this.path = null;
      this.status = 'unreachable';
      return false;
    }
    this.path = path;
    this.status = 'moving';
    return true;
  }

  private isBlocked(link: number, tick: Tick): boolean {
    const until = this.blockedLinks.get(link);
    return until !== undefined && until > tick;
  }

  // -- Walking ----------------------------------------------------------------

  private reached(feet: Readonly<Vec3>, wp: Readonly<Vec3>): boolean {
    return (
      horizontalDistance(feet, wp) <= WAYPOINT_REACH &&
      Math.abs(feet.y - wp.y) <= WAYPOINT_REACH_VERTICAL
    );
  }

  private resetProgress(tick: Tick): void {
    this.bestDistance = Infinity;
    this.progressTick = tick;
  }

  /** Track progress toward `wp`; nudge or give up when stalled. */
  private watchProgress(
    tick: Tick,
    pawn: Readonly<PawnState>,
    feet: Readonly<Vec3>,
    wp: Readonly<Vec3>,
    step: FollowStep,
    rng: Rng,
  ): void {
    const d = horizontalDistance(feet, wp) + Math.abs(feet.y - wp.y);
    if (d < this.bestDistance - STUCK_PROGRESS) {
      this.bestDistance = d;
      this.progressTick = tick;
    }
    if (tick < this.nudgeUntil && this.nudgeDir) {
      step.move = this.steer(pawn, this.nudgeDir);
      return;
    }
    if (tick - this.progressTick < STUCK_SECONDS * TICK_RATE) return;

    this.nudges++;
    if (this.nudges > MAX_NUDGES) {
      this.status = 'unreachable';
      step.move = null;
      step.status = 'unreachable';
      return;
    }
    // Hop, sidestep for a moment, and replan from wherever that leaves us.
    const side = rng.nextBool() ? 1 : -1;
    const dir = step.move ?? { x: 1, y: 0, z: 0 };
    this.nudgeDir = { x: -dir.z * side, y: 0, z: dir.x * side };
    this.nudgeUntil = tick + Math.round(NUDGE_SECONDS * TICK_RATE);
    this.planDue = true;
    this.resetProgress(tick);
    step.jump = true;
    step.move = this.steer(pawn, this.nudgeDir);
  }

  // -- Off-mesh links ---------------------------------------------------------

  private traverse(
    tick: Tick,
    pawn: Readonly<PawnState>,
    feet: Readonly<Vec3>,
    path: NavPath,
    rng: Rng,
  ): FollowStep {
    const L = this.link;
    const wp = L ? path.waypoints[L.waypoint] : undefined;
    if (!L || !wp) {
      this.link = null;
      return this.update(tick, pawn, rng);
    }
    const end = wp.position;
    const grounded = pawn.grounded;
    const step: FollowStep = {
      // A pad arc is left alone until its apex: steering while rising drags the
      // pawn under whatever the pad is meant to clear.
      move: grounded
        ? horizontalDirection(feet, end)
        : L.kind === 'pad' && pawn.velocity.y > 0
          ? null
          : this.landingControl(pawn, feet, end),
      jump: false,
      dodge: null,
      lookAt: lookPoint(end),
      status: 'moving',
    };

    if (!L.airborne) {
      if (!grounded) {
        L.airborne = true;
      } else if (L.steps.includes('jump') && !L.jumped) {
        // Take off at the speed the hop needs (or at the edge, whichever comes first).
        const start = path.waypoints[L.waypoint - 1]?.position ?? feet;
        const wanted = this.linkSpeed(start, end, L.kind);
        const v = pawn.velocity;
        const toward = step.move ? v.x * step.move.x + v.z * step.move.z : 0;
        if (toward >= 0.9 * wanted || this.offMesh(feet, v)) {
          step.jump = true;
          L.jumped = true;
        } else if (step.move) {
          const scale = wanted / this.movement.groundSpeed;
          step.move = { x: step.move.x * scale, y: 0, z: step.move.z * scale };
        }
      } else if (tick - L.startTick > LINK_TIMEOUT_SECONDS * TICK_RATE) {
        return this.linkFailed(tick, feet, L.index, pawn, rng);
      }
      // Reaching the far side on foot (a short drop that is really a step) also counts.
      if (grounded && this.reached(feet, end)) return this.linkDone(tick, L, pawn, rng);
    }

    if (L.airborne) {
      if (grounded) return this.landed(tick, feet, L, pawn, rng);
      const vy = pawn.velocity.y;
      if (L.jumped && !L.doubleJumped && !L.jumpHeld && vy <= this.movement.doubleJumpRiseLimit) {
        // The link asks for a double jump, or the arc would fall short of the far side.
        if (L.steps.includes('doubleJumpAtApex') || this.fallsShort(pawn, feet, end)) {
          step.jump = true;
          L.doubleJumped = true;
        }
      }
      if (L.kind === 'pad' && !L.dodged && vy <= 0.3) {
        // Past the apex and still far from the landing: a dodge (a wall dodge
        // when a wall is behind, which the shelf pad relies on) closes the gap.
        if (horizontalDistance(feet, end) > PAD_DODGE_DISTANCE) {
          L.dodged = true;
          step.dodge = horizontalDirection(feet, end);
        }
      }
      if (tick - L.startTick > 3 * LINK_TIMEOUT_SECONDS * TICK_RATE) {
        return this.linkFailed(tick, feet, L.index, pawn, rng);
      }
    }
    L.jumpHeld = step.jump;
    return step;
  }

  /**
   * Air control during a link flight: push the predicted landing point toward
   * `end`, which brakes an overshoot and stretches a short hop. Null when the
   * landing is already close enough.
   */
  private landingControl(
    pawn: Readonly<PawnState>,
    feet: Readonly<Vec3>,
    end: Readonly<Vec3>,
  ): Vec3 | null {
    const v = pawn.velocity;
    const g = this.movement.gravity;
    const disc = v.y * v.y + 2 * g * (feet.y - end.y);
    // Time to reach the landing height; if the arc never gets that high, aim from its apex.
    const t = disc >= 0 ? (v.y + Math.sqrt(disc)) / g : Math.max(0, v.y) / g;
    const landing = { x: feet.x + v.x * t, y: end.y, z: feet.z + v.z * t };
    if (horizontalDistance(landing, end) < 0.15) return null;
    return horizontalDirection(landing, end);
  }

  /** Near the apex: would the rest of the fall land short of `end` (which is still ahead)? */
  private fallsShort(
    pawn: Readonly<PawnState>,
    feet: Readonly<Vec3>,
    end: Readonly<Vec3>,
  ): boolean {
    const v = pawn.velocity;
    const speed = Math.hypot(v.x, v.z);
    if (speed < 1e-3) return false;
    // Distance to the end measured along the direction of travel; negative means it is behind.
    const ahead = ((end.x - feet.x) * v.x + (end.z - feet.z) * v.z) / speed;
    if (ahead <= 0) return false;
    const g = this.movement.gravity;
    const drop = Math.max(0, feet.y - end.y);
    const t = Math.max(0, v.y) / g + Math.sqrt((2 * drop) / g);
    return speed * t + 0.3 < ahead;
  }

  /**
   * Ground speed to take off with for a jump link from `start` to `end`:
   * the horizontal distance over the arc's airtime, with a margin, capped at
   * the top speed. A short hop onto a narrow rim must not be taken at full
   * speed, or the pawn sails over it.
   */
  linkSpeed(start: Readonly<Vec3>, end: Readonly<Vec3>, kind: NavLinkKind): number {
    const cfg = this.movement;
    const g = cfg.gravity;
    const dy = end.y - start.y;
    const rise = (v0: number, h: number): number => {
      const disc = v0 * v0 - 2 * g * h;
      return disc < 0 ? (2 * v0) / g : (v0 + Math.sqrt(disc)) / g;
    };
    let airtime: number;
    if (kind === 'doubleJump') {
      const apex = (cfg.jumpSpeed * cfg.jumpSpeed) / (2 * g);
      airtime = cfg.jumpSpeed / g + rise(cfg.doubleJumpSpeed, dy - apex);
    } else {
      airtime = rise(cfg.jumpSpeed, dy);
    }
    const wanted = (horizontalDistance(start, end) / Math.max(airtime, 1e-3)) * 1.15;
    return Math.min(cfg.groundSpeed, Math.max(2, wanted));
  }

  /** Back on the ground after a link flight: did we get to the other side? */
  private landed(
    tick: Tick,
    feet: Readonly<Vec3>,
    L: LinkTraversal,
    pawn: Readonly<PawnState>,
    rng: Rng,
  ): FollowStep {
    this.link = null;
    this.planDue = true;
    if (!this.plan(tick, feet)) return { ...IDLE, status: 'unreachable' };
    const again = this.path?.waypoints.some((w) => w.link?.index === L.index) ?? false;
    if (again) return this.linkFailed(tick, feet, L.index, pawn, rng);
    this.linkFailures.delete(L.index);
    return this.update(tick, pawn, rng);
  }

  private linkDone(tick: Tick, L: LinkTraversal, pawn: Readonly<PawnState>, rng: Rng): FollowStep {
    this.link = null;
    this.index = L.waypoint + 1;
    this.resetProgress(tick);
    this.linkFailures.delete(L.index);
    return this.update(tick, pawn, rng);
  }

  private linkFailed(
    tick: Tick,
    feet: Readonly<Vec3>,
    link: number,
    pawn: Readonly<PawnState>,
    rng: Rng,
  ): FollowStep {
    const n = (this.linkFailures.get(link) ?? 0) + 1;
    this.linkFailures.set(link, n);
    if (n >= LINK_FAILURES_TO_BLOCK) {
      this.blockedLinks.set(link, tick + LINK_BLOCK_SECONDS * TICK_RATE);
      this.linkFailures.delete(link);
      this.reachVersion++;
    }
    this.link = null;
    this.planDue = true;
    if (!this.plan(tick, feet)) return { ...IDLE, status: 'unreachable' };
    return this.update(tick, pawn, rng);
  }
}

/** Eye-level point above a feet position, so looking along the path is level. */
function lookPoint(feet: Readonly<Vec3>): Vec3 {
  return { x: feet.x, y: feet.y + 1.6, z: feet.z };
}
