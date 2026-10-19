/**
 * Target dummies for the demo (docs/DESIGN.md §13, M2): pawns that pace back
 * and forth, turn slowly, hop now and then, and never fire. They respawn like
 * anyone else, so there is always something to shoot at.
 */
import {
  Buttons,
  type Controller,
  type InputCommand,
  type PawnId,
  type Tick,
  type WorldState,
} from '../../sim/types';

export interface DummyOptions {
  pawnId: PawnId;
  /** Phase offset so dummies do not move in lockstep. */
  phase?: number;
  /** Seconds per pacing cycle (default 3). */
  period?: number;
  /** Radians per second of slow turning (default 0.25). */
  turnRate?: number;
  /** Jump every this many seconds (0 = never, default 4). */
  hopEvery?: number;
}

export class DummyController implements Controller {
  readonly pawnId: PawnId;
  private readonly phase: number;
  private readonly period: number;
  private readonly turnRate: number;
  private readonly hopEvery: number;
  private seq = 0;
  private yaw = 0;
  private wasAlive = false;

  constructor(options: DummyOptions) {
    this.pawnId = options.pawnId;
    this.phase = options.phase ?? 0;
    this.period = options.period ?? 3;
    this.turnRate = options.turnRate ?? 0.25;
    this.hopEvery = options.hopEvery ?? 4;
  }

  produce(tick: Tick, state: Readonly<WorldState>): InputCommand {
    const t = tick / 60 + this.phase;
    const pawn = state.entities.find((e) => e.id === this.pawnId && e.kind === 'pawn');
    const alive = pawn?.kind === 'pawn' && pawn.alive;
    if (alive && !this.wasAlive) this.yaw = pawn.yaw;
    this.wasAlive = alive;
    this.yaw += this.turnRate / 60;
    const cycle = (t % this.period) / this.period;
    // Short steps forward and back around the spawn point, so a dummy on a ledge stays on it.
    const moveY = cycle < 0.12 ? 1 : cycle < 0.5 ? 0 : cycle < 0.62 ? -1 : 0;
    let buttons = 0;
    if (
      this.hopEvery > 0 &&
      Math.floor(t / this.hopEvery) !== Math.floor((t - 1 / 60) / this.hopEvery)
    ) {
      buttons |= Buttons.Jump;
    }
    this.seq++;
    return { seq: this.seq, moveX: 0, moveY, yaw: this.yaw, pitch: 0, buttons, weapon: 0 };
  }
}
