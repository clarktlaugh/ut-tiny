/**
 * Spawn point selection for respawns (docs/DESIGN.md §6).
 *
 * Respawn timing, spawn protection and the `respawn` event live in
 * `pawn.ts` (`wantsRespawn`, `respawnPawn`); this module only decides where.
 *
 * Spawn points are scored by distance to the nearest enemy (capped), how
 *   recently they were used, and whether an enemy can see them; blocked points
 *   (a pawn standing on them) are skipped. A little seeded noise is added so the
 *   choice is not predictable, while a clearly safer point still wins.
 *
 * Pure sim code: no DOM, no wall-clock time; randomness comes from the world's
 * seeded `Rng`. Spawn poses are feet positions (map authors place them on the
 * floor); `planRespawn` converts to the capsule center the mover uses.
 */
import { PAWN_CAPSULE, type CapsuleDims } from './physics/physicsWorld';
import type { Rng } from './rng';
import { TICK_RATE, type PawnId, type Pose, type Tick, type Vec3 } from './types';

// ---------------------------------------------------------------------------
// Spawn scoring
// ---------------------------------------------------------------------------

export interface SpawnScoringConfig {
  /** Points per meter to the nearest enemy. */
  enemyWeight: number;
  /** Distances beyond this count as this (m). Default: no cap, the farthest spawn wins. */
  enemyDistanceCap: number;
  /** Penalty for a point used this very tick; fades linearly to 0 over `recencySeconds`. */
  recencyPenalty: number;
  recencySeconds: number;
  /** Penalty when any enemy has line of sight to the point (needs `SpawnQuery.canSee`). */
  visiblePenalty: number;
  /** A point with any live pawn closer than this (m) is blocked. */
  blockedRadius: number;
  /** Uniform noise in [0, noise) points added to every score. */
  noise: number;
}

export const DEFAULT_SPAWN_SCORING: Readonly<SpawnScoringConfig> = Object.freeze({
  enemyWeight: 1,
  enemyDistanceCap: Infinity,
  recencyPenalty: 20,
  recencySeconds: 10,
  visiblePenalty: 15,
  blockedRadius: 1.2,
  noise: 3,
});

export interface SpawnQuery {
  /** Positions of live enemies of the respawning pawn. */
  enemies: readonly Vec3[];
  /** Positions of every other live pawn (enemies included), for blocking. Defaults to `enemies`. */
  occupied?: readonly Vec3[];
  /** Line-of-sight test, e.g. a physics raycast against map geometry. */
  canSee?: (from: Readonly<Vec3>, to: Readonly<Vec3>) => boolean;
}

export interface SpawnScore {
  index: number;
  /** Final score including noise; higher is better. */
  score: number;
  /** Distance to the nearest enemy, `Infinity` when there are none. */
  nearestEnemy: number;
  blocked: boolean;
  visible: boolean;
}

/** Eye height above the spawn's feet for line-of-sight tests, m. */
const EYE_HEIGHT = 1.6;

const distance = (a: Readonly<Vec3>, b: Readonly<Vec3>): number =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export class SpawnSelector {
  readonly config: SpawnScoringConfig;
  /** Tick each spawn was last used, or undefined. Plain data for snapshots. */
  readonly lastUsed: (Tick | undefined)[];

  constructor(
    readonly spawns: readonly Pose[],
    config: Partial<SpawnScoringConfig> = {},
  ) {
    if (spawns.length === 0) throw new Error('Map has no spawn points');
    this.config = { ...DEFAULT_SPAWN_SCORING, ...config };
    this.lastUsed = spawns.map(() => undefined);
  }

  /**
   * Score every spawn on `tick`. Draws exactly one value from `rng` per spawn,
   * in index order, whatever the config, so the RNG stream stays stable.
   */
  score(tick: Tick, query: Readonly<SpawnQuery>, rng: Rng): SpawnScore[] {
    const cfg = this.config;
    const occupied = query.occupied ?? query.enemies;
    return this.spawns.map((pose, index) => {
      const at = pose.position;
      let nearestEnemy = Infinity;
      for (const e of query.enemies) nearestEnemy = Math.min(nearestEnemy, distance(at, e));
      const blocked = occupied.some((p) => blocksSpawn(at, p, cfg.blockedRadius));
      const eye = { x: at.x, y: at.y + EYE_HEIGHT, z: at.z };
      const visible = query.canSee ? query.enemies.some((e) => query.canSee?.(e, eye)) : false;

      // No enemies: distance does not separate spawns; recency and noise decide.
      const safety = Number.isFinite(nearestEnemy)
        ? Math.min(nearestEnemy, cfg.enemyDistanceCap)
        : 0;
      let score = cfg.enemyWeight * safety;
      const used = this.lastUsed[index];
      if (used !== undefined && cfg.recencySeconds > 0) {
        const age = (tick - used) / TICK_RATE;
        score -= cfg.recencyPenalty * Math.max(0, 1 - age / cfg.recencySeconds);
      }
      if (visible) score -= cfg.visiblePenalty;
      score += rng.nextFloat() * Math.max(0, cfg.noise);
      return { index, score, nearestEnemy, blocked, visible };
    });
  }

  /**
   * Choose a spawn for a pawn respawning on `tick` and mark it used. Blocked
   * points are skipped unless every point is blocked. Ties go to the lower index.
   */
  pick(tick: Tick, query: Readonly<SpawnQuery>, rng: Rng): { index: number; pose: Pose } {
    const scores = this.score(tick, query, rng);
    const open = scores.filter((s) => !s.blocked);
    const pool = open.length ? open : scores;
    let best = pool[0];
    for (const s of pool) if (best && s.score > best.score) best = s;
    const index = best?.index ?? 0;
    this.markUsed(index, tick);
    return { index, pose: clonePose(this.spawnAt(index)) };
  }

  /** Record that a spawn was used on `tick` (also called by `pick`). */
  markUsed(index: number, tick: Tick): void {
    if (index >= 0 && index < this.lastUsed.length) this.lastUsed[index] = tick;
  }

  private spawnAt(index: number): Pose {
    const pose = this.spawns[index];
    if (!pose) throw new Error(`No spawn ${index}`);
    return pose;
  }
}

/**
 * A pawn at capsule center `p` blocks spawn feet `at` when it is within
 * `radius` horizontally and its capsule overlaps the standing height.
 */
function blocksSpawn(at: Readonly<Vec3>, p: Readonly<Vec3>, radius: number): boolean {
  const height = 2 * (PAWN_CAPSULE.radius + PAWN_CAPSULE.halfHeight);
  return (
    Math.hypot(at.x - p.x, at.z - p.z) < radius && p.y > at.y - height && p.y < at.y + 2 * height
  );
}

function clonePose(p: Readonly<Pose>): Pose {
  return { position: { ...p.position }, yaw: p.yaw, pitch: p.pitch };
}

// ---------------------------------------------------------------------------
// Respawn
// ---------------------------------------------------------------------------

export interface RespawnPlan {
  pawn: PawnId;
  spawnIndex: number;
  /** Spawn pose (feet position); pass to `respawnPawn`. */
  pose: Pose;
  /** Capsule center for `CharacterMover.teleport`. */
  center: Vec3;
}

/**
 * Pick a spawn for `pawn` respawning on `tick` and work out where its capsule
 * goes. The world then calls `respawnPawn(rec, plan.pose, ctx)` (health,
 * loadout, protection, `respawn` event) and
 * `mover.teleport(pawn, moverState, plan.center, plan.pose.yaw)`.
 */
export function planRespawn(
  pawn: PawnId,
  tick: Tick,
  selector: SpawnSelector,
  query: Readonly<SpawnQuery>,
  rng: Rng,
  capsule: Readonly<CapsuleDims> = PAWN_CAPSULE,
): RespawnPlan {
  const { index, pose } = selector.pick(tick, query, rng);
  const lift = capsule.radius + capsule.halfHeight + 0.02;
  return {
    pawn,
    spawnIndex: index,
    pose,
    center: { x: pose.position.x, y: pose.position.y + lift, z: pose.position.z },
  };
}
