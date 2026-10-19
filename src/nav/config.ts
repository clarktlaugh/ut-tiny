/**
 * Navmesh bake settings (docs/DESIGN.md §9). Defaults follow the pawn capsule
 * and the §4 movement numbers so the mesh only covers ground a pawn can stand on.
 */
import { DEFAULT_MOVEMENT } from '../sim/movement/config';
import { PAWN_CAPSULE } from '../sim/physics/physicsWorld';
import type { NavLinkKind } from '../sim/types';

export interface NavBakeConfig {
  /** Horizontal cell size, m. Smaller is more exact and slower. */
  cellSize: number;
  /**
   * Agent radius, m: walkable cells closer than this to an edge or wall are
   * removed. Edges are sampled at cell centers, so this holds to half a cell.
   */
  agentRadius: number;
  /** Standing clearance needed above a walkable surface, m. */
  agentHeight: number;
  /** Highest step between neighbouring cells that still counts as walking, m. */
  agentClimb: number;
  /** Steepest walkable slope, degrees. */
  maxSlope: number;
  /** How far a `navLinks` endpoint may be from the mesh and still snap to it, m (horizontal). */
  linkSnapHorizontal: number;
  /** Vertical tolerance for snapping link endpoints, m. */
  linkSnapVertical: number;
}

const STANDING_HEIGHT = 2 * (PAWN_CAPSULE.halfHeight + PAWN_CAPSULE.radius);

export const DEFAULT_NAV_CONFIG: Readonly<NavBakeConfig> = Object.freeze({
  cellSize: 0.25,
  agentRadius: PAWN_CAPSULE.radius,
  agentHeight: STANDING_HEIGHT,
  agentClimb: DEFAULT_MOVEMENT.stepHeight,
  maxSlope: DEFAULT_MOVEMENT.walkableSlope,
  linkSnapHorizontal: 2,
  linkSnapVertical: 2,
});

/** Bumped whenever the bake output changes, so stale cache entries are ignored. */
export const NAV_BAKE_VERSION = 1;

/** Surface types stored per node. */
export const NavArea = { walk: 0, water: 1, damage: 2 } as const;
export type NavAreaId = (typeof NavArea)[keyof typeof NavArea];

/** Path cost multiplier per area, indexed by `NavAreaId`. */
export const AREA_COST: readonly number[] = [1, 2, 6];

/** Extra cost (in meters of walking) added to each off-mesh link of a kind. */
export const LINK_PENALTY: Readonly<Record<NavLinkKind, number>> = Object.freeze({
  pad: 2,
  jump: 1,
  doubleJump: 2,
  drop: 1,
  translocate: 6,
});

/**
 * Inputs a controller performs to traverse a link, in order (§9: "links carry
 * the input sequence needed to traverse them").
 * - `walkOnto`: move onto the link start and let the pad or ledge do the rest.
 * - `jump`: press Jump at the link start while moving toward the end.
 * - `doubleJumpAtApex`: press Jump again near the top of the first jump.
 * - `fireTranslocator` / `teleport`: throw the disc at the end, then recall to it.
 */
export type NavLinkStep =
  'walkOnto' | 'jump' | 'doubleJumpAtApex' | 'fireTranslocator' | 'teleport';

export const LINK_TRAVERSAL: Readonly<Record<NavLinkKind, readonly NavLinkStep[]>> = Object.freeze({
  pad: ['walkOnto'],
  jump: ['jump'],
  doubleJump: ['jump', 'doubleJumpAtApex'],
  drop: ['walkOnto'],
  translocate: ['fireTranslocator', 'teleport'],
});
