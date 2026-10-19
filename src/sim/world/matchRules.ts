/**
 * The world's hook for match rules (docs/DESIGN.md §6, §8.1).
 *
 * Deathmatch rules (frag and time limits, announcer, match flow) are P23's
 * packet. The world only needs something that keeps `WorldState.match` and
 * reacts to each tick's events, so it takes a `MatchRules` and ships with
 * `BasicMatchRules`: always `playing`, frags and deaths counted, no limits
 * enforced, no announcer. P23 passes its own implementation to `createWorld`.
 */
import {
  NO_ENTITY,
  type MatchState,
  type PawnId,
  type PlayerId,
  type PlayerProfile,
  type PlayerScore,
  type RulesConfig,
  type Seconds,
  type SimEvent,
  type Tick,
} from '../types';

/** What rules may read from the world while updating. */
export interface MatchView {
  readonly tick: Tick;
  readonly time: Seconds;
  /** Participant owning a pawn, or undefined. */
  playerFor(pawn: PawnId): PlayerId | undefined;
}

export interface MatchRules {
  /** A participant joined. Returned events are reported with the next tick. */
  addPlayer(playerId: PlayerId, profile: Readonly<PlayerProfile>, tick: Tick): SimEvent[];
  /** A participant left. Returned events are reported with the next tick. */
  removePlayer(playerId: PlayerId, tick: Tick): SimEvent[];
  /** Runs last in every tick with that tick's events so far; returns events to append. */
  update(events: readonly SimEvent[], view: MatchView): SimEvent[];
  /** Current match state; the world deep-copies it into each snapshot. */
  state(): Readonly<MatchState>;
}

/**
 * Minimal rules until P23: phase `playing`, a kill gives the killer a frag,
 * every death counts, a death with no other killer (environment or self) is
 * a suicide and costs a frag. Emits `score` events for changed players.
 */
export class BasicMatchRules implements MatchRules {
  private readonly match: MatchState;

  constructor(rules: Readonly<RulesConfig>) {
    this.match = {
      phase: 'playing',
      fragLimit: rules.fragLimit,
      timeLimit: rules.timeLimit,
      elapsed: 0,
      scores: [],
      winner: null,
    };
  }

  addPlayer(playerId: PlayerId, profile: Readonly<PlayerProfile>): SimEvent[] {
    if (!this.score(playerId)) {
      this.match.scores.push({
        playerId,
        name: profile.name,
        isBot: profile.isBot,
        frags: 0,
        deaths: 0,
        suicides: 0,
        spree: 0,
      });
    }
    return [];
  }

  removePlayer(playerId: PlayerId): SimEvent[] {
    this.match.scores = this.match.scores.filter((s) => s.playerId !== playerId);
    return [];
  }

  update(events: readonly SimEvent[], view: MatchView): SimEvent[] {
    this.match.elapsed = view.time;
    const changed: PlayerScore[] = [];
    const touch = (s: PlayerScore): void => {
      if (!changed.includes(s)) changed.push(s);
    };
    for (const ev of events) {
      if (ev.type !== 'death') continue;
      const victimId = view.playerFor(ev.victim);
      const victim = victimId === undefined ? undefined : this.score(victimId);
      const killerId = ev.killer === NO_ENTITY ? undefined : view.playerFor(ev.killer);
      const killer = killerId === undefined ? undefined : this.score(killerId);
      if (victim) {
        victim.deaths++;
        victim.spree = 0;
        touch(victim);
      }
      if (killer && killer !== victim) {
        killer.frags++;
        killer.spree++;
        touch(killer);
      } else if (victim) {
        victim.suicides++;
        victim.frags--;
      }
    }
    return changed.map((s) => ({
      type: 'score',
      tick: view.tick,
      playerId: s.playerId,
      frags: s.frags,
      deaths: s.deaths,
    }));
  }

  state(): Readonly<MatchState> {
    return this.match;
  }

  private score(playerId: PlayerId): PlayerScore | undefined {
    return this.match.scores.find((s) => s.playerId === playerId);
  }
}
