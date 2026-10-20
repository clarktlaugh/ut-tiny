/**
 * Bot controller (docs/DESIGN.md §8.2, §9): just another `Controller`. It
 * reads the previous tick's `WorldState`, perceives enemies, picks a goal by
 * utility, follows navmesh paths through `InputCommand`s, and lets the combat
 * behavior aim and fire. It never touches the sim directly, so bots cannot
 * cheat and a multiplayer host can run them like any other controller.
 *
 * Per tick:
 *  1. Dead: press Fire (on alternate ticks, so each press is an edge) once
 *     the respawn delay is over.
 *  2. Perception update (vision at 10 Hz, projectile noise); events the
 *     session passes to `observe` add hearing.
 *  3. Decision every `DECISION_INTERVAL` ticks, or at once when the current
 *     goal became invalid (pickup gone, enemy lost or dead, path failed).
 *  4. Path following toward the goal position; combat aim and fire when a
 *     target is visible, combat movement when attacking at close range.
 *  5. Compose the command: axes relative to the chosen yaw, buttons, slot.
 *
 * Determinism: all randomness is a seeded `Rng` per bot.
 */
import { WEAPONS } from '../../data/weapons';
import type { NavMesh } from '../../nav';
import type { WeaponTable } from '../../sim/inventory';
import { forwardVector, rightVector, type MovementConfig } from '../../sim/movement';
import { Rng } from '../../sim/rng';
import {
  Buttons,
  NULL_INPUT,
  TICK_RATE,
  type Controller,
  type EntityId,
  type InputCommand,
  type MapDef,
  type PawnId,
  type PawnState,
  type PickupState,
  type SimEvent,
  type Tick,
  type Vec3,
  type WorldState,
} from '../../sim/types';
import { wrapAngle } from '../../sim/weapons/core';
import { BasicCombat, type CombatBehavior, type CombatOutput } from './combat';
import { chooseGoal, type BotGoal, type GoalContext, type GoalWeights } from './goals';
import { padHazards } from './hazards';
import { copy, horizontalDistance } from './math';
import { PathFollower, feetOf } from './pathFollower';
import { Perception, type EnemyMemory } from './perception';
import type { RoutePlanner } from './routeGraph';
import { skillProfile, type SkillProfile } from './skill';
import type { BotSenses } from './types';

export interface BotOptions {
  pawnId: PawnId;
  nav: NavMesh;
  senses: BotSenses;
  /** Skill 0–7 (§9); default Average (2). */
  skill?: number;
  /** Seed for this bot's `Rng`; defaults to the pawn id. */
  seed?: number;
  weapons?: WeaponTable;
  /** Combat behavior; P22 replaces the default. */
  combat?: CombatBehavior;
  weights?: Partial<GoalWeights>;
  movement?: Readonly<MovementConfig>;
  /** Route planner shared by the bots on a mesh; defaults to `routeGraphFor(nav)`. */
  planner?: RoutePlanner;
  /** The map, for its jump pads: bots walk around pads they are not using. */
  map?: Readonly<Pick<MapDef, 'jumpPads'>>;
}

/** Ticks between goal re-evaluations (§9: 0.25 s). */
export const DECISION_INTERVAL = 15;
/** Seconds an unreachable or failed goal target is ignored. */
export const BLACKLIST_SECONDS = 20;
/** Fastest the bot turns its view when following a path, rad/s. */
export const PATH_TURN_RATE = 8;
/** Within this distance of a pickup, its disappearance counts as our visit, m. */
export const VISIT_RADIUS = 2;
/** Ticks to stand at an arrived-at pickup that is still there before giving it up. */
export const ARRIVAL_GRACE = 30;

export class BotController implements Controller {
  readonly pawnId: PawnId;
  readonly profile: SkillProfile;
  readonly perception: Perception;
  readonly follower: PathFollower;
  readonly combat: CombatBehavior;
  readonly rng: Rng;
  private readonly nav: NavMesh;
  private readonly senses: BotSenses;
  private readonly weapons: WeaponTable;
  private readonly weights: Partial<GoalWeights> | undefined;
  private readonly groundSpeed: number;
  private seq = 0;
  private yaw = 0;
  private pitch = 0;
  private wasAlive = false;
  private goal: BotGoal | null = null;
  private nextDecisionTick = 0;
  private arrivedTick = -1;
  private readonly visited = new Map<EntityId, Tick>();
  private readonly blacklist = new Map<EntityId | string, Tick>();
  private lastCombat: CombatOutput | null = null;

  constructor(options: BotOptions) {
    this.pawnId = options.pawnId;
    this.nav = options.nav;
    this.senses = options.senses;
    this.profile = skillProfile(options.skill);
    this.rng = new Rng(options.seed ?? options.pawnId * 7919 + 17);
    this.weapons = options.weapons ?? WEAPONS;
    this.weights = options.weights;
    this.groundSpeed = options.movement?.groundSpeed ?? 8.8;
    this.perception = new Perception({
      pawnId: this.pawnId,
      senses: this.senses,
      profile: this.profile,
      phase: this.pawnId % 6,
    });
    this.follower = new PathFollower(this.nav, {
      allowedLinks: this.profile.allowedLinks,
      hazards: options.map ? padHazards(options.map) : [],
      ...(options.movement ? { movement: options.movement } : {}),
      ...(options.planner ? { planner: options.planner } : {}),
    });
    this.combat = options.combat ?? new BasicCombat();
  }

  /** The goal being pursued, for tests and debug overlays. */
  get currentGoal(): Readonly<BotGoal> | null {
    return this.goal;
  }

  /** Pickup entities this bot has taken, with the tick of the last visit. */
  get visits(): ReadonlyMap<EntityId, Tick> {
    return this.visited;
  }

  /**
   * Hearing and bookkeeping from the tick's events. Optional: a session that
   * has the events calls it after each step with the new state.
   */
  observe(events: readonly SimEvent[], state: Readonly<WorldState>): void {
    const self = this.findSelf(state);
    if (!self) return;
    for (const ev of events) {
      if (ev.type === 'pickupTaken' && ev.pawn === this.pawnId)
        this.visited.set(ev.pickup, ev.tick);
    }
    this.perception.hear(state.tick, self, events, state);
  }

  produce(tick: Tick, state: Readonly<WorldState>): InputCommand {
    this.seq++;
    const self = this.findSelf(state);
    if (!self) return { ...NULL_INPUT, seq: this.seq };
    if (!self.alive) return this.dead(tick, self);
    if (!this.wasAlive) this.onRespawn(self);
    this.wasAlive = true;

    this.perception.update(tick, self, state);
    const target = this.perception.target(tick, self);
    const confidence = target ? this.perception.confidence(target, tick) : 0;

    // Decisions wait for the ground: mid-air the mesh is out of reach, so
    // every pickup would look unreachable and a pad flight would lose its goal.
    const due = tick >= this.nextDecisionTick || !this.goalValid(tick, state, target);
    if (due && (self.grounded || !this.goal)) {
      this.decide(tick, self, state, target, confidence);
    }
    this.noteVisit(tick, self, state);

    // Combat: aim and fire whenever a target is known; move only when attacking.
    let combat: CombatOutput | null = null;
    if (target && (target.visible || this.goal?.kind === 'hunt')) {
      combat = this.combat.update({
        tick,
        self,
        target,
        weapons: this.weapons,
        profile: this.profile,
        rng: this.rng,
        canStep: (dir) => this.canStep(self, dir),
      });
    }
    this.lastCombat = combat;
    const fighting = combat?.move !== null && combat !== null && this.goal?.kind === 'attack';

    // Navigation.
    const destination = this.destination(target);
    if (destination && !fighting) this.follower.setGoal(destination);
    else if (!destination) this.follower.clear();
    const step = fighting ? null : this.follower.update(tick, self, this.rng);
    if (step?.status === 'unreachable' && self.grounded) {
      this.blacklistGoal(tick);
      this.nextDecisionTick = tick;
    } else if (step?.status === 'arrived') {
      if (this.arrivedTick < 0) this.arrivedTick = tick;
      this.nextDecisionTick = tick;
      if (this.goal?.kind === 'hunt') this.perception.forget(this.goal.enemy ?? 0);
      // Standing at a pickup that is still there: it is out of reach from here.
      if (this.goal?.pickup !== undefined && tick - this.arrivedTick >= ARRIVAL_GRACE) {
        this.blacklistGoal(tick);
      }
    } else {
      this.arrivedTick = -1;
    }

    // View.
    if (combat) {
      this.yaw = combat.yaw;
      this.pitch = combat.pitch;
    } else if (step?.lookAt) {
      this.turnToward(self, step.lookAt);
    }

    // Movement axes relative to the yaw this command carries.
    const move = fighting
      ? combat?.move
        ? this.follower.steer(self, combat.move)
        : null
      : (step?.move ?? null);
    let moveX = 0;
    let moveY = 0;
    if (move) {
      const f = forwardVector(this.yaw);
      const r = rightVector(this.yaw);
      moveY = move.x * f.x + move.z * f.z;
      moveX = move.x * r.x + move.z * r.z;
    }

    let buttons = combat?.buttons ?? 0;
    if (step?.jump) buttons |= Buttons.Jump;
    if (step?.dodge) buttons |= dodgeButton(step.dodge, this.yaw);

    return {
      seq: this.seq,
      moveX,
      moveY,
      yaw: this.yaw,
      pitch: this.pitch,
      buttons,
      weapon: combat?.weapon ?? 0,
    };
  }

  // -- Lifecycle ----------------------------------------------------------------

  private dead(tick: Tick, self: Readonly<PawnState>): InputCommand {
    if (this.wasAlive) {
      this.wasAlive = false;
      this.follower.clear();
      this.perception.clear();
      this.combat.reset();
      this.goal = null;
    }
    const fire = tick >= self.respawnAt && tick % 2 === 0 ? Buttons.Fire : 0;
    return { ...NULL_INPUT, seq: this.seq, yaw: this.yaw, pitch: 0, buttons: fire };
  }

  private onRespawn(self: Readonly<PawnState>): void {
    this.yaw = self.yaw;
    this.pitch = self.pitch;
    this.follower.reset();
    this.goal = null;
    this.nextDecisionTick = 0;
  }

  // -- Decisions ----------------------------------------------------------------

  private goalContext(
    tick: Tick,
    self: Readonly<PawnState>,
    state: Readonly<WorldState>,
    target: EnemyMemory | null,
    confidence: number,
  ): GoalContext {
    return {
      tick,
      self,
      state,
      senses: this.senses,
      weapons: this.weapons,
      profile: this.profile,
      target,
      targetConfidence: confidence,
      visited: this.visited,
      isBlacklisted: (key) => this.isBlacklisted(key, tick),
      canReach: (position) => this.follower.canReach(feetOf(self), position, tick),
      groundSpeed: this.groundSpeed,
      ...(this.weights ? { weights: this.weights } : {}),
    };
  }

  private decide(
    tick: Tick,
    self: Readonly<PawnState>,
    state: Readonly<WorldState>,
    target: EnemyMemory | null,
    confidence: number,
  ): void {
    this.nextDecisionTick = tick + DECISION_INTERVAL;
    let goal = chooseGoal(this.goalContext(tick, self, state, target, confidence), this.goal);
    if (goal && goal.position === null && goal.kind === 'roam') {
      goal = { ...goal, position: this.wanderPoint(self) };
    }
    if (!goal) goal = { kind: 'roam', score: 0, position: this.wanderPoint(self) };
    if (!this.sameTarget(goal)) this.combat.reset();
    this.goal = goal;
  }

  private sameTarget(goal: Readonly<BotGoal>): boolean {
    return this.goal?.enemy === goal.enemy && this.goal?.pickup === goal.pickup;
  }

  /** Still worth pursuing? */
  private goalValid(tick: Tick, state: Readonly<WorldState>, target: EnemyMemory | null): boolean {
    const g = this.goal;
    if (!g) return false;
    if (g.pickup !== undefined) {
      const p = state.entities.find((e) => e.id === g.pickup);
      if (p?.kind !== 'pickup') return false;
      if (!p.available && !(this.profile.pickupTiming && (p.respawnAt - tick) / TICK_RATE < 10)) {
        return false;
      }
      if (this.isBlacklisted(p.id, tick)) return false;
    }
    if (g.enemy !== undefined && g.kind !== 'retreat') {
      if (!target || target.pawn !== g.enemy) return false;
      if (g.kind === 'attack' && !target.visible) return false;
      if (g.kind === 'hunt' && target.visible) return false;
    }
    return true;
  }

  /** Feet-level point the follower should head for under the current goal. */
  private destination(target: EnemyMemory | null): Vec3 | null {
    const g = this.goal;
    if (!g) return null;
    if ((g.kind === 'attack' || g.kind === 'hunt') && target)
      return feetOf({ position: target.position });
    return g.position;
  }

  private blacklistGoal(tick: Tick): void {
    const g = this.goal;
    if (!g) return;
    const until = tick + BLACKLIST_SECONDS * TICK_RATE;
    if (g.pickup !== undefined) this.blacklist.set(g.pickup, until);
    else if (g.enemy !== undefined) this.blacklist.set(`enemy:${g.enemy}`, until);
    this.follower.clear();
    this.goal = null;
  }

  private isBlacklisted(key: EntityId | string, tick: Tick): boolean {
    const until = this.blacklist.get(key);
    if (until === undefined) return false;
    if (until <= tick) {
      this.blacklist.delete(key);
      return false;
    }
    return true;
  }

  /** A pickup we were heading for vanished right under us: count it as visited. */
  private noteVisit(tick: Tick, self: Readonly<PawnState>, state: Readonly<WorldState>): void {
    const g = this.goal;
    if (g?.pickup === undefined) return;
    const p = state.entities.find((e) => e.id === g.pickup) as PickupState | undefined;
    if (!p || p.available) return;
    if (horizontalDistance(self.position, p.position) <= VISIT_RADIUS) this.visited.set(p.id, tick);
  }

  /**
   * Somewhere to go when there is nothing to want: a random node of the
   * walking region the bot stands in (reachable without links, so a bot in a
   * trap keeps moving and fighting instead of freezing).
   */
  private wanderPoint(self: Readonly<PawnState>): Vec3 | null {
    const n = this.nav.nodeCount;
    if (n === 0) return null;
    const here = this.nav.nearest(feetOf(self));
    const region = here >= 0 ? this.nav.data.region[here] : undefined;
    let fallback: Vec3 | null = null;
    for (let i = 0; i < 24; i++) {
      const node = this.rng.nextInt(n);
      if (region !== undefined && this.nav.data.region[node] !== region) continue;
      const p = this.nav.position(node);
      if (this.follower.inHazard(p)) continue;
      if (horizontalDistance(p, self.position) > 8) return p;
      fallback ??= p;
    }
    return fallback ?? copy(self.position);
  }

  // -- Helpers ------------------------------------------------------------------

  private findSelf(state: Readonly<WorldState>): PawnState | undefined {
    const e = state.entities.find((x) => x.id === this.pawnId);
    return e?.kind === 'pawn' ? e : undefined;
  }

  private canStep(self: Readonly<PawnState>, dir: Readonly<Vec3>): boolean {
    return this.follower.canStep(self, dir);
  }

  private turnToward(self: Readonly<PawnState>, point: Readonly<Vec3>): void {
    const dx = point.x - self.position.x;
    const dz = point.z - self.position.z;
    if (Math.hypot(dx, dz) < 1e-3) return;
    const wanted = Math.atan2(-dx, -dz);
    const delta = wrapAngle(wanted - this.yaw);
    const max = PATH_TURN_RATE / TICK_RATE;
    this.yaw = wrapAngle(this.yaw + Math.max(-max, Math.min(max, delta)));
    this.pitch += (0 - this.pitch) * 0.2;
  }

  /** Debug: the last combat output, if any. */
  get lastCombatOutput(): Readonly<CombatOutput> | null {
    return this.lastCombat;
  }
}

/** Dodge bit whose direction (relative to `yaw`) best matches `dir`. */
export function dodgeButton(dir: Readonly<Vec3>, yaw: number): number {
  const f = forwardVector(yaw);
  const r = rightVector(yaw);
  const fwd = dir.x * f.x + dir.z * f.z;
  const right = dir.x * r.x + dir.z * r.z;
  if (Math.abs(fwd) >= Math.abs(right)) return fwd >= 0 ? Buttons.DodgeForward : Buttons.DodgeBack;
  return right >= 0 ? Buttons.DodgeRight : Buttons.DodgeLeft;
}
