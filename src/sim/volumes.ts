/**
 * Jump pads and kill / damage / water volumes (docs/DESIGN.md §4, §6, §8.1).
 *
 * `VolumeSystem` turns the physics world's sensor transitions into gameplay:
 *
 * - **Jump pad**: a live pawn entering the pad's trigger is launched with the
 *   pad's `launch` velocity (`CharacterMover.launch`) and a `jumpPad` event is
 *   emitted. A pad fires on entry only; standing on it does not re-launch.
 * - **Kill volume**: a live pawn inside dies at once, shield or not. The system
 *   emits the `death` event (killer `NO_ENTITY`, damage type `killVolume`, the
 *   volume's death message) and reports the kill so the world can mark the pawn
 *   dead without routing it through the damage pipeline.
 * - **Damage volume**: a live pawn inside takes `damagePerSecond`, accumulated
 *   per tick and released in whole points, as `damageVolume` damage for the
 *   damage pipeline (P12) to apply.
 * - **Water volume**: tracked only; `inWater(pawn)` tells movement and audio.
 *
 * The system is pure sim code: no DOM, no wall-clock time, no randomness. It
 * holds per-pawn occupancy derived from `PhysicsWorld.step()` sensor events and
 * nothing else, so feeding the same events gives the same results.
 *
 * Per tick, the world calls:
 *
 * ```ts
 * const sensorEvents = physics.step();
 * const out = volumes.update(tick, sensorEvents, { isAlive, entityForSensor });
 * for (const l of out.launches) mover.launch(moverStateOf(l.pawn), l.velocity);
 * for (const k of out.kills) markDead(k.pawn);           // `out.events` already has the death
 * for (const d of out.damage) applyDamage(d.pawn, d.amount, ZERO, NO_ENTITY, 'damageVolume');
 * events.push(...out.events);
 * ```
 */
import type { SensorEvent, SensorTag } from './physics/physicsWorld';
import {
  NO_ENTITY,
  TICK_DT,
  type EntityId,
  type JumpPadDef,
  type MapDef,
  type PawnId,
  type SimEvent,
  type Tick,
  type Vec3,
  type VolumeDef,
  type VolumeKind,
} from './types';

/** Death message used by kill volumes that do not name one. */
export const DEFAULT_KILL_MESSAGE = 'fell';

/** A pawn to launch this tick. Apply with `CharacterMover.launch`. */
export interface PadLaunch {
  pawn: PawnId;
  /** Index into `MapDef.jumpPads`. */
  placementIndex: number;
  velocity: Vec3;
}

/** A pawn a kill volume killed this tick. The `death` event is already in `VolumeUpdate.events`. */
export interface VolumeKill {
  pawn: PawnId;
  /** Index into `MapDef.volumes`. */
  placementIndex: number;
  message: string;
}

/** Whole points of `damageVolume` damage to apply this tick. */
export interface VolumeDamage {
  pawn: PawnId;
  /** Index into `MapDef.volumes`. */
  placementIndex: number;
  amount: number;
}

export interface VolumeUpdate {
  /** `jumpPad` and `death` events, in order of pawn id then volume. */
  events: SimEvent[];
  launches: PadLaunch[];
  kills: VolumeKill[];
  damage: VolumeDamage[];
}

/** What the system needs to know about the world beyond sensor events. */
export interface VolumeContext {
  /** Dead pawns (and their corpses) are not launched, killed or hurt. */
  isAlive(pawn: PawnId): boolean;
  /**
   * Entity id of a jump pad or volume, for the `jumpPad` event's `pad` field.
   * Defaults to `NO_ENTITY` when the world has not allocated pad entities.
   */
  entityFor?(kind: 'jumpPad' | 'volume', placementIndex: number): EntityId;
}

interface Occupant {
  /** Volume placement indices the pawn is inside, in entry order. */
  volumes: number[];
  /** Fractional damage carried over per damage volume. */
  damageCarry: Map<number, number>;
}

export class VolumeSystem {
  private readonly pads: readonly JumpPadDef[];
  private readonly volumes: readonly VolumeDef[];
  private readonly occupants = new Map<PawnId, Occupant>();

  constructor(map: Pick<MapDef, 'jumpPads' | 'volumes'>) {
    this.pads = map.jumpPads;
    this.volumes = map.volumes;
  }

  /**
   * Apply one tick: consume the sensor transitions from `PhysicsWorld.step()`
   * (actors are pawn ids), then run kill and damage volumes for every pawn
   * inside one. Results are ordered by ascending pawn id.
   */
  update(tick: Tick, sensorEvents: readonly SensorEvent[], ctx: VolumeContext): VolumeUpdate {
    const out: VolumeUpdate = { events: [], launches: [], kills: [], damage: [] };
    const entered: { pawn: PawnId; pad: number }[] = [];

    for (const ev of sensorEvents) {
      const tag: SensorTag = ev.tag;
      if (tag.kind === 'jumpPad') {
        if (ev.type === 'enter') entered.push({ pawn: ev.actor, pad: tag.placementIndex });
      } else if (tag.kind === 'volume') {
        if (ev.type === 'enter') this.enter(ev.actor, tag.placementIndex);
        else this.exit(ev.actor, tag.placementIndex);
      }
    }

    // Kills and damage first, so a pawn that lands on a pad inside a kill volume dies.
    const killed = new Set<PawnId>();
    const pawns = [...this.occupants.keys()].sort((a, b) => a - b);
    for (const pawn of pawns) {
      const occ = this.occupants.get(pawn);
      if (!occ || !ctx.isAlive(pawn)) continue;
      const kill = occ.volumes.find((i) => this.volumes[i]?.kind === 'kill');
      if (kill !== undefined) {
        const message = this.volumes[kill]?.deathMessage ?? DEFAULT_KILL_MESSAGE;
        killed.add(pawn);
        occ.damageCarry.clear();
        out.kills.push({ pawn, placementIndex: kill, message });
        out.events.push({
          type: 'death',
          tick,
          victim: pawn,
          killer: NO_ENTITY,
          damageType: 'killVolume',
          weapon: null,
          message,
        });
        continue;
      }
      for (const index of occ.volumes) {
        const def = this.volumes[index];
        if (def?.kind !== 'damage') continue;
        const perTick = Math.max(0, def.damagePerSecond ?? 0) * TICK_DT;
        const total = (occ.damageCarry.get(index) ?? 0) + perTick;
        // Round away float noise so 60 × (60/60) reaches exactly 60.
        const whole = Math.floor(total + 1e-9);
        occ.damageCarry.set(index, Math.max(0, total - whole));
        if (whole > 0) out.damage.push({ pawn, placementIndex: index, amount: whole });
      }
    }

    entered.sort((a, b) => a.pawn - b.pawn || a.pad - b.pad);
    for (const { pawn, pad } of entered) {
      const def = this.pads[pad];
      if (!def || killed.has(pawn) || !ctx.isAlive(pawn)) continue;
      out.launches.push({ pawn, placementIndex: pad, velocity: { ...def.launch } });
      out.events.push({
        type: 'jumpPad',
        tick,
        pawn,
        pad: ctx.entityFor?.('jumpPad', pad) ?? NO_ENTITY,
      });
    }
    return out;
  }

  /** True while the pawn is inside a water volume. */
  inWater(pawn: PawnId): boolean {
    return this.isInside(pawn, 'water');
  }

  /** True while the pawn is inside a volume of `kind`. */
  isInside(pawn: PawnId, kind: VolumeKind): boolean {
    const occ = this.occupants.get(pawn);
    return occ?.volumes.some((i) => this.volumes[i]?.kind === kind) ?? false;
  }

  /** Volume placement indices the pawn is inside, in entry order. */
  volumesContaining(pawn: PawnId): readonly number[] {
    return this.occupants.get(pawn)?.volumes ?? [];
  }

  /** Forget a pawn (removed from the match). Its physics exits are then ignored. */
  removePawn(pawn: PawnId): void {
    this.occupants.delete(pawn);
  }

  private enter(pawn: PawnId, index: number): void {
    let occ = this.occupants.get(pawn);
    if (!occ) {
      occ = { volumes: [], damageCarry: new Map() };
      this.occupants.set(pawn, occ);
    }
    if (!occ.volumes.includes(index)) occ.volumes.push(index);
  }

  private exit(pawn: PawnId, index: number): void {
    const occ = this.occupants.get(pawn);
    if (!occ) return;
    occ.volumes = occ.volumes.filter((i) => i !== index);
    occ.damageCarry.delete(index);
    if (occ.volumes.length === 0) this.occupants.delete(pawn);
  }
}

/**
 * Launch velocity that carries a body from `from` to `to` under `gravity`
 * (m/s², positive down), peaking `apexHeight` meters above the higher of the
 * two points. A helper for map authors placing pads; the result goes in
 * `JumpPadDef.launch`.
 */
export function launchVelocityTo(
  from: Readonly<Vec3>,
  to: Readonly<Vec3>,
  apexHeight: number,
  gravity: number,
): Vec3 {
  if (!(gravity > 0)) throw new Error('gravity must be positive');
  const peak = Math.max(from.y, to.y) + Math.max(0, apexHeight);
  const rise = peak - from.y;
  const fall = peak - to.y;
  const vy = Math.sqrt(2 * gravity * rise);
  const time = vy / gravity + Math.sqrt((2 * fall) / gravity);
  if (!(time > 0)) return { x: 0, y: vy, z: 0 };
  return { x: (to.x - from.x) / time, y: vy, z: (to.z - from.z) / time };
}
