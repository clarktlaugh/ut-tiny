/**
 * Test harness for match rules: drives a `MatchRules` with hand-written
 * events and a fake `MatchView`, one tick per `step`. Not used at runtime.
 */
import {
  NO_ENTITY,
  TICK_DT,
  TICK_RATE,
  type AnnouncerLine,
  type DamageType,
  type PawnId,
  type PlayerId,
  type SimEvent,
  type Tick,
} from '../types';
import type { MatchRules, MatchView } from '../world/matchRules';

/** Events without the tick; `step` stamps them. */
type OmitEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type Unticked = OmitEach<SimEvent, 'tick'>;

export class RulesHarness {
  tick: Tick = 0;
  readonly log: SimEvent[] = [];
  private readonly owners = new Map<PawnId, PlayerId>();
  private queued: Unticked[] = [];

  constructor(readonly rules: MatchRules) {}

  /** Join a player whose pawn id is `pawn`; the spawn event goes out with the next step. */
  join(playerId: PlayerId, pawn: PawnId, isBot = false): this {
    this.owners.set(pawn, playerId);
    this.rules.addPlayer(playerId, { name: playerId, isBot }, this.tick + 1);
    this.queued.push({ type: 'entitySpawned', id: pawn, kind: 'pawn' });
    return this;
  }

  leave(playerId: PlayerId): void {
    for (const [pawn, id] of this.owners) if (id === playerId) this.owners.delete(pawn);
    this.rules.removePlayer(playerId, this.tick + 1);
  }

  /** One tick with these world events; returns the rules' events. */
  step(events: readonly Unticked[] = []): SimEvent[] {
    this.tick++;
    const all = [...this.queued, ...events].map((e) => ({ ...e, tick: this.tick }) as SimEvent);
    this.queued = [];
    const view: MatchView = {
      tick: this.tick,
      time: this.tick * TICK_DT,
      playerFor: (pawn) => this.owners.get(pawn),
    };
    const out = this.rules.update(all, view);
    this.log.push(...out);
    return out;
  }

  /** `n` empty ticks; returns all rules events. */
  run(n: number): SimEvent[] {
    const out: SimEvent[] = [];
    for (let i = 0; i < n; i++) out.push(...this.step());
    return out;
  }

  /** Run until `seconds` of sim time have passed since now. */
  wait(seconds: number): SimEvent[] {
    return this.run(Math.round(seconds * TICK_RATE));
  }

  /** One tick where `killer` kills `victim` (NO_ENTITY for the environment). */
  kill(killer: PawnId, victim: PawnId, damageType: DamageType = 'rocket'): SimEvent[] {
    return this.step([death(killer, victim, damageType)]);
  }
}

export function death(killer: PawnId, victim: PawnId, damageType: DamageType = 'rocket'): Unticked {
  return {
    type: 'death',
    victim,
    killer,
    damageType,
    weapon: killer === NO_ENTITY ? null : 'rocket',
  };
}

/** Announcer lines in `events`, optionally only those addressed to `toPawn`. */
export function lines(events: readonly SimEvent[], toPawn?: PawnId): AnnouncerLine[] {
  const out: AnnouncerLine[] = [];
  for (const e of events) {
    if (e.type === 'announcer' && (toPawn === undefined || e.toPawn === toPawn)) out.push(e.line);
  }
  return out;
}

export function phases(events: readonly SimEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) if (e.type === 'matchPhase') out.push(e.phase);
  return out;
}
