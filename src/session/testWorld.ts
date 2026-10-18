/**
 * Minimal in-memory `World` for session tests. It records the inputs it was
 * stepped with and emits no gameplay events. Not used at runtime.
 */
import {
  NO_ENTITY,
  NULL_INPUT,
  TICK_DT,
  type EntityState,
  type InputCommand,
  type PawnId,
  type PlayerId,
  type PlayerProfile,
  type SimEvent,
  type World,
  type WorldOptions,
  type WorldState,
} from '../sim/types';

export class TestWorld implements World {
  readonly options = {} as Readonly<WorldOptions>;
  readonly steppedInputs: Map<PawnId, InputCommand>[] = [];
  readonly players = new Map<PlayerId, PawnId>();
  private nextId = 1;
  private state: WorldState = {
    tick: 0,
    time: 0,
    rngState: 1,
    entities: [],
    match: {
      phase: 'playing',
      fragLimit: 0,
      timeLimit: 0,
      elapsed: 0,
      scores: [],
      winner: null,
    },
  };

  get tick(): number {
    return this.state.tick;
  }

  step(inputs: ReadonlyMap<PawnId, InputCommand>): readonly SimEvent[] {
    const resolved = new Map<PawnId, InputCommand>();
    for (const pawn of this.players.values()) resolved.set(pawn, inputs.get(pawn) ?? NULL_INPUT);
    for (const [pawn, cmd] of inputs) resolved.set(pawn, cmd);
    this.steppedInputs.push(resolved);
    this.state = { ...this.state, tick: this.state.tick + 1, time: this.state.time + TICK_DT };
    return [];
  }

  addPlayer(playerId: PlayerId, _profile: PlayerProfile): PawnId {
    void _profile;
    const id = this.nextId++;
    this.players.set(playerId, id);
    return id;
  }

  removePlayer(playerId: PlayerId): void {
    this.players.delete(playerId);
  }

  pawnFor(playerId: PlayerId): PawnId {
    return this.players.get(playerId) ?? NO_ENTITY;
  }

  getState(): Readonly<WorldState> {
    return this.state;
  }

  getEntity(): Readonly<EntityState> | undefined {
    return undefined;
  }
}

export function cmd(seq: number, buttons = 0): InputCommand {
  return { ...NULL_INPUT, seq, buttons };
}
