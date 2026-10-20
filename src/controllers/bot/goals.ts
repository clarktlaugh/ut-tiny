/**
 * Utility goal selection (docs/DESIGN.md §9). Every candidate goal gets a
 * score; the controller re-evaluates them every 0.25 s and keeps the current
 * goal unless another beats it by a margin (hysteresis).
 *
 * | Goal          | Scored by                                                   |
 * |---------------|-------------------------------------------------------------|
 * | Attack        | visible enemy, own health/weapon strength vs theirs         |
 * | Hunt          | recent memory of an enemy, not visible                      |
 * | Get weapon    | lack of a good weapon, distance, availability               |
 * | Get health    | health deficit, distance                                    |
 * | Get shield    | shield deficit, distance                                    |
 * | Get ammo      | low ammo on the preferred weapon                            |
 * | Camp Redeemer | Redeemer about to respawn, skill ≥ Adept                    |
 * | Roam          | default: high-value pickups weighted by distance and visits |
 * | Retreat       | low health and a stronger enemy                             |
 */
import type { WeaponTable } from '../../sim/inventory';
import { ammoOf, bestWeapon, owns } from '../../sim/inventory';
import {
  PAWN_STATS,
  TICK_RATE,
  type EntityId,
  type PawnId,
  type PawnState,
  type PickupState,
  type Tick,
  type Vec3,
  type WorldState,
} from '../../sim/types';
import { travelDistance } from './math';
import type { EnemyMemory } from './perception';
import type { SkillProfile } from './skill';
import type { BotSenses } from './types';

export type GoalKind =
  | 'attack'
  | 'hunt'
  | 'getWeapon'
  | 'getHealth'
  | 'getShield'
  | 'getAmmo'
  | 'campRedeemer'
  | 'roam'
  | 'retreat';

export interface BotGoal {
  kind: GoalKind;
  score: number;
  /** Enemy pawn for attack / hunt / retreat. */
  enemy?: PawnId;
  /** Pickup entity for pickup goals and roaming. */
  pickup?: EntityId;
  /** Feet-level destination, or null when the goal has nowhere to go. */
  position: Vec3 | null;
}

/** Multipliers per goal kind; zero disables a goal. */
export type GoalWeights = Record<GoalKind, number>;

export const DEFAULT_GOAL_WEIGHTS: Readonly<GoalWeights> = Object.freeze({
  attack: 1,
  hunt: 0.6,
  getWeapon: 0.9,
  getHealth: 1,
  getShield: 0.9,
  getAmmo: 0.7,
  campRedeemer: 0.8,
  roam: 0.6,
  retreat: 1,
});

/** Score bonus for keeping the current goal. */
export const GOAL_HYSTERESIS = 0.12;
/** A pickup visited this recently is worth less (seconds). */
export const VISIT_MEMORY_SECONDS = 25;
/** Distance at which a pickup's score halves, m. */
export const PICKUP_HALF_DISTANCE = 25;
/** Redeemer camping starts this many seconds before it returns. */
export const CAMP_SECONDS = 15;

export type PickupCategory = 'weapon' | 'health' | 'shield' | 'ammo' | 'power';

export interface PickupOption {
  pickup: PickupState;
  category: PickupCategory;
  /** How much the bot wants it, 0..1, before distance. */
  value: number;
  /** Travel estimate, m. */
  distance: number;
  /** `value` scaled by distance and recent visits. */
  score: number;
}

export interface GoalContext {
  tick: Tick;
  self: Readonly<PawnState>;
  state: Readonly<WorldState>;
  senses: BotSenses;
  weapons: WeaponTable;
  profile: SkillProfile;
  /** Enemy to consider, from perception. */
  target: EnemyMemory | null;
  /** 0..1 confidence in `target`. */
  targetConfidence: number;
  /** Tick each pickup entity was last taken by this bot. */
  visited: ReadonlyMap<EntityId, Tick>;
  /** Pickups and enemies to ignore for now (unreachable, failed). */
  isBlacklisted: (key: EntityId | string) => boolean;
  /** Cheap reachability test for a destination (`PathFollower.canReach`). */
  canReach?: (position: Readonly<Vec3>) => boolean;
  weights?: Partial<GoalWeights>;
  /** Ground speed for respawn-timing estimates, m/s. */
  groundSpeed?: number;
}

export const WEAPON_PRIORITY_MAX = 9;

/** Health + shield + a weapon term, for comparing two pawns. */
export function strength(pawn: Readonly<PawnState>, weapons: WeaponTable): number {
  const best = bestWeapon(pawn, weapons);
  const w = best ? weapons[best].priority : 0;
  return pawn.health + pawn.shield + 12 * w;
}

function categoryOf(p: Readonly<PickupState>): PickupCategory {
  switch (p.type) {
    case 'weapon':
      return 'weapon';
    case 'ammo':
      return 'ammo';
    case 'healthVial':
    case 'healthPack':
      return 'health';
    case 'shieldPack':
    case 'superShield':
      return 'shield';
    case 'udamage':
      return 'power';
  }
}

/** Intrinsic value of a pickup for `self`, 0..1, ignoring distance and availability. */
export function pickupValue(
  self: Readonly<PawnState>,
  p: Readonly<PickupState>,
  weapons: WeaponTable,
): number {
  const health = Math.min(self.health, 100) / 100;
  switch (p.type) {
    case 'healthPack':
      return Math.max(0, 1 - health);
    case 'healthVial':
      return 0.15 + 0.25 * (1 - health);
    case 'shieldPack':
      return 0.7 * (1 - self.shield / PAWN_STATS.shieldMax);
    case 'superShield':
      return 1 - self.shield / PAWN_STATS.shieldMax;
    case 'udamage':
      return 1;
    case 'weapon': {
      if (!p.weapon) return 0;
      const def = weapons[p.weapon];
      const best = bestWeapon(self, weapons);
      const bestPriority = best ? weapons[best].priority : 0;
      if (!owns(self, p.weapon)) {
        const gain = def.priority > bestPriority ? 1 : 0.3;
        return gain * (def.priority / WEAPON_PRIORITY_MAX);
      }
      return def.ammo ? 0.3 * (1 - ammoOf(self, p.weapon, weapons) / def.ammo.max) : 0;
    }
    case 'ammo': {
      if (!p.weapon) return 0;
      const def = weapons[p.weapon];
      if (!def.ammo) return 0;
      if (!owns(self, p.weapon)) return 0.1;
      const need = 1 - ammoOf(self, p.weapon, weapons) / def.ammo.max;
      const best = bestWeapon(self, weapons);
      return need * (best === p.weapon ? 0.7 : 0.5);
    }
  }
}

/** Every pickup the bot could want, best first. */
export function ratePickups(ctx: GoalContext): PickupOption[] {
  const { self, tick } = ctx;
  const speed = ctx.groundSpeed ?? 8.8;
  const out: PickupOption[] = [];
  for (const e of ctx.state.entities) {
    if (e.kind !== 'pickup') continue;
    if (ctx.isBlacklisted(e.id)) continue;
    if (ctx.canReach && !ctx.canReach(e.position)) continue;
    const asAvailable = e.available ? e : { ...e, available: true };
    if (!ctx.senses.canTake(self, asAvailable)) continue;
    let value = pickupValue(self, e, ctx.weapons);
    if (value <= 0) continue;
    const dist = travelDistance(self.position, e.position);
    if (!e.available) {
      if (!ctx.profile.pickupTiming) continue;
      const wait = (e.respawnAt - tick) / TICK_RATE;
      if (wait > dist / speed + 3) continue;
      value *= 0.7;
    }
    const visitedAt = ctx.visited.get(e.id);
    let visitFactor = 1;
    if (visitedAt !== undefined) {
      const age = (tick - visitedAt) / TICK_RATE;
      if (age < VISIT_MEMORY_SECONDS) visitFactor = 0.25 + (0.75 * age) / VISIT_MEMORY_SECONDS;
    }
    const score = (value * visitFactor) / (1 + dist / PICKUP_HALF_DISTANCE);
    out.push({ pickup: e, category: categoryOf(e), value, distance: dist, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

function feetGoal(p: Readonly<PickupState>): Vec3 {
  return { x: p.position.x, y: p.position.y, z: p.position.z };
}

/**
 * All candidate goals with positive scores, best first. `current` keeps the
 * pickup being pursued among the candidates even when another pickup of its
 * category now rates higher, so hysteresis has something to hold on to.
 */
export function scoreGoals(ctx: GoalContext, current: Readonly<BotGoal> | null = null): BotGoal[] {
  const w: GoalWeights = { ...DEFAULT_GOAL_WEIGHTS, ...ctx.weights };
  const goals: BotGoal[] = [];
  const options = ratePickups(ctx);
  const best = (category: PickupCategory): PickupOption | undefined =>
    options.find((o) => o.category === category);

  const target = ctx.target;
  const enemyBlocked = target ? ctx.isBlacklisted(`enemy:${target.pawn}`) : true;
  const usable = bestWeapon(ctx.self, ctx.weapons) !== null;
  let advantage = 0.5;
  if (target && !enemyBlocked) {
    const enemy = ctx.state.entities.find((e) => e.id === target.pawn);
    if (enemy?.kind === 'pawn') {
      const mine = strength(ctx.self, ctx.weapons);
      const theirs = strength(enemy, ctx.weapons);
      advantage = Math.min(1, Math.max(0, 0.5 + (mine - theirs) / 200));
    }
    if (target.visible && usable) {
      goals.push({
        kind: 'attack',
        score: w.attack * (0.55 + 0.35 * advantage),
        enemy: target.pawn,
        position: target.position,
      });
    } else if (!target.visible && ctx.targetConfidence > 0 && usable) {
      goals.push({
        kind: 'hunt',
        score: w.hunt * (0.4 + 0.5 * ctx.targetConfidence),
        enemy: target.pawn,
        position: target.position,
      });
    }
    if (target.visible && ctx.self.health < 40 && advantage < 0.35) {
      const safe = best('health') ?? best('shield');
      if (safe) {
        goals.push({
          kind: 'retreat',
          score: w.retreat * 0.8,
          enemy: target.pawn,
          pickup: safe.pickup.id,
          position: feetGoal(safe.pickup),
        });
      }
    }
  }

  const held = (kind: GoalKind, except: EntityId | undefined): PickupOption | undefined => {
    if (current?.kind !== kind || current.pickup === undefined || current.pickup === except) {
      return undefined;
    }
    return options.find((x) => x.pickup.id === current.pickup);
  };
  const pickupGoal = (kind: GoalKind, category: PickupCategory, weight: number): void => {
    if (weight <= 0) return;
    for (const o of [best(category), held(kind, best(category)?.pickup.id)]) {
      if (!o) continue;
      goals.push({
        kind,
        score: weight * o.score,
        pickup: o.pickup.id,
        position: feetGoal(o.pickup),
      });
    }
  };
  pickupGoal('getWeapon', 'weapon', w.getWeapon);
  pickupGoal('getHealth', 'health', w.getHealth);
  pickupGoal('getShield', 'shield', w.getShield);
  pickupGoal('getAmmo', 'ammo', w.getAmmo);

  if (ctx.profile.level >= 4 && w.campRedeemer > 0) {
    for (const e of ctx.state.entities) {
      if (e.kind !== 'pickup' || e.type !== 'weapon' || e.weapon !== 'redeemer') continue;
      if (e.available || ctx.isBlacklisted(e.id)) continue;
      const wait = (e.respawnAt - ctx.tick) / TICK_RATE;
      if (wait > CAMP_SECONDS) continue;
      goals.push({
        kind: 'campRedeemer',
        score: w.campRedeemer * 0.75,
        pickup: e.id,
        position: feetGoal(e),
      });
    }
  }

  const roamTo = options[0];
  if (w.roam > 0) {
    goals.push({
      kind: 'roam',
      score: w.roam * (0.4 + 0.6 * (roamTo?.score ?? 0)),
      pickup: roamTo?.pickup.id,
      position: roamTo ? feetGoal(roamTo.pickup) : null,
    });
    const kept = held('roam', roamTo?.pickup.id);
    if (kept) {
      goals.push({
        kind: 'roam',
        score: w.roam * (0.4 + 0.6 * kept.score),
        pickup: kept.pickup.id,
        position: feetGoal(kept.pickup),
      });
    }
  }

  goals.sort((a, b) => b.score - a.score);
  return goals;
}

/** True when two goals are the same thing (kind and target). */
export function sameGoal(a: Readonly<BotGoal> | null, b: Readonly<BotGoal> | null): boolean {
  if (!a || !b) return false;
  return a.kind === b.kind && a.enemy === b.enemy && a.pickup === b.pickup;
}

/** Pick the best goal, favouring `current` by `hysteresis`. */
export function chooseGoal(
  ctx: GoalContext,
  current: Readonly<BotGoal> | null,
  hysteresis = GOAL_HYSTERESIS,
): BotGoal | null {
  const goals = scoreGoals(ctx, current);
  let best: BotGoal | null = null;
  let bestScore = -Infinity;
  for (const g of goals) {
    const s = g.score + (sameGoal(g, current) ? hysteresis : 0);
    if (s > bestScore) {
      bestScore = s;
      best = g;
    }
  }
  return best;
}
