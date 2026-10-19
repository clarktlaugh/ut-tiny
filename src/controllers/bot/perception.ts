/**
 * Bot perception with memory (docs/DESIGN.md §9).
 *
 * - Vision: a cone plus a line-of-sight check to each live enemy, run at
 *   10 Hz on a tick offset so bots do not all raycast together.
 * - Hearing: weapon fire, footsteps, jump pads and landings within the
 *   hearing radius leave a "noise" memory. Sessions pass events through
 *   `hear`; because `Controller.produce` only sees state, newly fired enemy
 *   projectiles in the snapshot count as noise too.
 * - Memory: last-known position and velocity per enemy; confidence decays to
 *   0 over `memorySeconds` after the last sighting or sound.
 */
import { NO_ENTITY, TICK_RATE } from '../../sim/types';
import type {
  EntityId,
  PawnId,
  PawnState,
  SimEvent,
  Tick,
  Vec3,
  WorldState,
} from '../../sim/types';
import { directionFromAngles, eyePosition } from '../../sim/weapons/core';
import { copy, distance } from './math';
import type { SkillProfile } from './skill';
import type { BotSenses } from './types';

export interface EnemyMemory {
  pawn: PawnId;
  /** Last known capsule center. */
  position: Vec3;
  velocity: Vec3;
  /** Tick of the last sighting or sound. */
  tick: Tick;
  /** Seen on the latest vision pass. */
  visible: boolean;
  /** Tick the current unbroken sighting began; for reaction delay. */
  sightedAt: Tick;
  source: 'sight' | 'sound';
}

export interface PerceptionOptions {
  pawnId: PawnId;
  senses: BotSenses;
  profile: SkillProfile;
  /** Ticks between vision passes (default 6: 10 Hz). */
  interval?: number;
  /** Offset of this bot's vision ticks within the interval. */
  phase?: number;
}

/** Footsteps carry this fraction of the hearing radius. */
const FOOTSTEP_RANGE = 0.4;

export class Perception {
  readonly pawnId: PawnId;
  private readonly senses: BotSenses;
  private readonly profile: SkillProfile;
  private readonly interval: number;
  private readonly phase: number;
  private readonly memories = new Map<PawnId, EnemyMemory>();
  /** Projectiles already treated as noise. */
  private readonly knownProjectiles = new Set<EntityId>();

  constructor(options: PerceptionOptions) {
    this.pawnId = options.pawnId;
    this.senses = options.senses;
    this.profile = options.profile;
    this.interval = Math.max(1, options.interval ?? 6);
    this.phase = options.phase ?? 0;
  }

  /** Every memory, visible ones first, then by recency. */
  all(): EnemyMemory[] {
    return [...this.memories.values()].sort(
      (a, b) => Number(b.visible) - Number(a.visible) || b.tick - a.tick,
    );
  }

  get(pawn: PawnId): EnemyMemory | undefined {
    return this.memories.get(pawn);
  }

  /** 1 while visible, fading to 0 over the memory window. */
  confidence(m: Readonly<EnemyMemory>, tick: Tick): number {
    if (m.visible) return 1;
    const life = this.profile.memorySeconds * TICK_RATE;
    return Math.max(0, 1 - (tick - m.tick) / life);
  }

  /** The enemy to act on: the nearest visible one, else the most confident memory. */
  target(tick: Tick, self: Readonly<PawnState>): EnemyMemory | null {
    let best: EnemyMemory | null = null;
    let bestKey = -Infinity;
    for (const m of this.memories.values()) {
      const c = this.confidence(m, tick);
      if (c <= 0) continue;
      const key = (m.visible ? 1000 : 0) + c * 100 - distance(self.position, m.position) / 100;
      if (key > bestKey) {
        bestKey = key;
        best = m;
      }
    }
    return best;
  }

  forget(pawn: PawnId): void {
    this.memories.delete(pawn);
  }

  clear(): void {
    this.memories.clear();
    this.knownProjectiles.clear();
  }

  /** One tick: forget the dead, run vision when due, listen for new projectiles, decay. */
  update(tick: Tick, self: Readonly<PawnState>, state: Readonly<WorldState>): void {
    const enemies = new Map<PawnId, PawnState>();
    for (const e of state.entities) {
      if (e.kind === 'pawn' && e.id !== self.id && e.alive) enemies.set(e.id, e);
    }
    for (const id of this.memories.keys()) if (!enemies.has(id)) this.memories.delete(id);

    if ((tick + this.phase) % this.interval === 0) this.look(tick, self, enemies);
    this.listenToProjectiles(tick, self, state, enemies);

    for (const [id, m] of this.memories) {
      if (this.confidence(m, tick) <= 0) this.memories.delete(id);
    }
  }

  /** Noise from this tick's events (optional; sessions that have the events call it). */
  hear(
    tick: Tick,
    self: Readonly<PawnState>,
    events: readonly SimEvent[],
    state: Readonly<WorldState>,
  ): void {
    if (!self.alive) return;
    const range = this.profile.hearingRange;
    for (const ev of events) {
      let pawn: PawnId;
      let at: Vec3 | undefined;
      let reach = range;
      switch (ev.type) {
        case 'shotFired':
          pawn = ev.pawn;
          at = ev.origin;
          break;
        case 'footstep':
          pawn = ev.pawn;
          at = ev.position;
          reach = range * FOOTSTEP_RANGE;
          break;
        case 'jumpPad':
        case 'land':
        case 'dodge':
          pawn = ev.pawn;
          break;
        default:
          continue;
      }
      if (pawn === NO_ENTITY || pawn === self.id) continue;
      const other = this.findPawn(state, pawn);
      if (!other?.alive) continue;
      const where = at ?? other.position;
      if (distance(self.position, where) > reach) continue;
      this.noise(tick, other);
    }
  }

  private look(tick: Tick, self: Readonly<PawnState>, enemies: Map<PawnId, PawnState>): void {
    const eye = eyePosition(self);
    const view = directionFromAngles(self.yaw, self.pitch);
    const cosHalf = Math.cos(this.profile.visionCone / 2);
    for (const p of enemies.values()) {
      const seen = this.canSee(eye, view, cosHalf, p);
      const m = this.memories.get(p.id);
      if (seen) {
        if (m) {
          m.position = copy(p.position);
          m.velocity = copy(p.velocity);
          m.tick = tick;
          if (!m.visible) m.sightedAt = tick;
          m.visible = true;
          m.source = 'sight';
        } else {
          this.memories.set(p.id, {
            pawn: p.id,
            position: copy(p.position),
            velocity: copy(p.velocity),
            tick,
            visible: true,
            sightedAt: tick,
            source: 'sight',
          });
        }
      } else if (m) {
        m.visible = false;
      }
    }
  }

  private canSee(
    eye: Readonly<Vec3>,
    view: Readonly<Vec3>,
    cosHalf: number,
    p: Readonly<PawnState>,
  ): boolean {
    const d = { x: p.position.x - eye.x, y: p.position.y - eye.y, z: p.position.z - eye.z };
    const dist = Math.hypot(d.x, d.y, d.z);
    if (dist > this.profile.visionRange) return false;
    if (dist > 1e-3) {
      const dot = (d.x * view.x + d.y * view.y + d.z * view.z) / dist;
      if (dot < cosHalf) return false;
    }
    return this.senses.canSee(eye, p.position);
  }

  private listenToProjectiles(
    tick: Tick,
    self: Readonly<PawnState>,
    state: Readonly<WorldState>,
    enemies: Map<PawnId, PawnState>,
  ): void {
    const present = new Set<EntityId>();
    for (const e of state.entities) {
      if (e.kind !== 'projectile') continue;
      present.add(e.id);
      if (this.knownProjectiles.has(e.id)) continue;
      this.knownProjectiles.add(e.id);
      const owner = enemies.get(e.owner);
      if (!owner) continue;
      if (distance(self.position, e.position) > this.profile.hearingRange) continue;
      this.noise(tick, owner);
    }
    for (const id of this.knownProjectiles) if (!present.has(id)) this.knownProjectiles.delete(id);
  }

  /** Record a sound from `other` at its current position without marking it visible. */
  private noise(tick: Tick, other: Readonly<PawnState>): void {
    const m = this.memories.get(other.id);
    if (m?.visible) return;
    if (m) {
      m.position = copy(other.position);
      m.velocity = copy(other.velocity);
      m.tick = tick;
      m.source = 'sound';
    } else {
      this.memories.set(other.id, {
        pawn: other.id,
        position: copy(other.position),
        velocity: copy(other.velocity),
        tick,
        visible: false,
        sightedAt: tick,
        source: 'sound',
      });
    }
  }

  private findPawn(state: Readonly<WorldState>, id: PawnId): PawnState | undefined {
    const e = state.entities.find((x) => x.id === id);
    return e?.kind === 'pawn' ? e : undefined;
  }
}
