/**
 * Deathmatch rules (docs/DESIGN.md §6, §8.1): the `MatchRules` the world runs
 * last in every tick. Pass one to `createWorld(options, { rules })`.
 *
 * Phases: `warmup` until the first tick, then `countdown` (3 s by default,
 * with countdown3 / countdown2 / countdown1), then `playing` (announces
 * `play`). The first of frag limit or time limit ends the match. A tie for
 * the lead at the time limit enters `overtime`, and the first frag that
 * breaks the tie (or the frag limit) ends it. `ended` freezes the scores and
 * the clock; `winner` is the leader, or null with nobody playing.
 *
 * Scoring: a kill of another player is +1 frag for the killer (telefrags
 * included); a death by your own hand or the environment is a suicide and
 * costs 1 frag. Every death counts for the victim and ends their spree.
 * Deaths outside `playing` / `overtime` are not scored.
 *
 * Announcer (`announcer` events; `toPawn` NO_ENTITY means everyone):
 * - firstBlood, everyone, once per match on the first kill;
 * - headshot, to the killer, when the killing blow was a headshot;
 * - doubleKill .. monsterKill, to the killer, kills < 3 s apart;
 * - killingSpree .. godlike, to the killer, at 5 / 10 / 15 / 20 / 25;
 * - threeFragsLeft / twoFragsLeft / oneFragLeft, everyone, as the leader
 *   approaches the frag limit (each at most once);
 * - countdown3 / 2 / 1 and play, everyone; overtime, everyone;
 * - youWin to the winner's pawn and youLose to everyone else's at the end.
 * One kill can trigger several categories; within one tick each killer gets
 * at most one multi-kill and one spree line (the highest reached).
 *
 * Spawn protection and respawn timing come from the `RulesConfig` and are
 * enforced by the pawn and damage code; see `DEATHMATCH_RULES`.
 *
 * Deterministic: time comes from the tick, players are visited in join order.
 */
import {
  NO_ENTITY,
  TICK_RATE,
  type AnnouncerLine,
  type MatchPhase,
  type MatchState,
  type PawnId,
  type PlayerId,
  type PlayerProfile,
  type PlayerScore,
  type RulesConfig,
  type SimEvent,
  type Tick,
} from '../types';
import type { MatchRules, MatchView } from '../world/matchRules';
import {
  COUNTDOWN_LINES,
  FRAGS_LEFT_LINES,
  MultiKillTracker,
  multiKillLine,
  spreeLine,
} from './announcer';
import { DEFAULT_DEATHMATCH_OPTIONS, type DeathmatchOptions } from './config';
import { leaderFrags, leaders } from './scoreboard';

interface KillerLines {
  pawn: PawnId;
  headshot: boolean;
  multi?: AnnouncerLine;
  spree?: AnnouncerLine;
}

export class DeathmatchRules implements MatchRules {
  readonly options: Readonly<DeathmatchOptions>;
  private readonly match: MatchState;
  private readonly pawns = new Map<PlayerId, PawnId>();
  private readonly multi = new Map<PlayerId, MultiKillTracker>();
  private countdownStart: Tick = 0;
  private lastCountdown = Infinity;
  private playStart: Tick = 0;
  private firstBloodDone = false;
  private fragsLeftAnnounced = Infinity;

  constructor(rules: Readonly<RulesConfig>, options: Partial<DeathmatchOptions> = {}) {
    this.options = { ...DEFAULT_DEATHMATCH_OPTIONS, ...options };
    this.match = {
      phase: 'warmup',
      fragLimit: Math.max(0, rules.fragLimit),
      timeLimit: Math.max(0, rules.timeLimit),
      elapsed: 0,
      scores: [],
      winner: null,
    };
  }

  get phase(): MatchPhase {
    return this.match.phase;
  }

  /** Last known pawn of a participant (learned from spawn, respawn and death events). */
  pawnOf(playerId: PlayerId): PawnId {
    return this.pawns.get(playerId) ?? NO_ENTITY;
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
    this.pawns.delete(playerId);
    this.multi.delete(playerId);
    return [];
  }

  update(events: readonly SimEvent[], view: MatchView): SimEvent[] {
    const out: SimEvent[] = [];
    this.learnPawns(events, view);

    if (this.match.phase === 'warmup') {
      this.countdownStart = view.tick;
      if (this.options.countdown > 0) this.setPhase('countdown', view.tick, out);
    }
    if (this.match.phase === 'countdown') this.stepCountdown(view.tick, out);
    else if (this.match.phase === 'warmup') this.startPlay(view.tick, out);

    if (this.match.phase === 'playing' || this.match.phase === 'overtime') {
      this.match.elapsed = (view.tick - this.playStart) / TICK_RATE;
      const fragged = this.scoreDeaths(events, view, out);
      this.checkEnd(fragged, view.tick, out);
    }
    return out;
  }

  state(): Readonly<MatchState> {
    return this.match;
  }

  // -- Phases ---------------------------------------------------------------

  private stepCountdown(tick: Tick, out: SimEvent[]): void {
    const total = Math.round(this.options.countdown * TICK_RATE);
    const done = tick - this.countdownStart;
    if (done >= total) {
      this.startPlay(tick, out);
      return;
    }
    const remaining = Math.ceil((total - done) / TICK_RATE);
    if (remaining < this.lastCountdown) {
      this.lastCountdown = remaining;
      const line = COUNTDOWN_LINES.get(remaining);
      if (line) out.push(announce(tick, line));
    }
  }

  private startPlay(tick: Tick, out: SimEvent[]): void {
    this.playStart = tick;
    this.match.elapsed = 0;
    this.setPhase('playing', tick, out);
    out.push(announce(tick, 'play'));
  }

  private setPhase(phase: MatchPhase, tick: Tick, out: SimEvent[]): void {
    this.match.phase = phase;
    out.push({ type: 'matchPhase', tick, phase });
  }

  private checkEnd(fragged: PlayerScore | undefined, tick: Tick, out: SimEvent[]): void {
    const { fragLimit, timeLimit } = this.match;
    if (fragLimit > 0 && fragged) {
      this.end(fragged.playerId, tick, out);
      return;
    }
    const top = leaders(this.match);
    if (this.match.phase === 'overtime') {
      if (top.length <= 1) this.end(top[0]?.playerId ?? null, tick, out);
      return;
    }
    if (timeLimit > 0 && this.match.elapsed >= timeLimit) {
      if (top.length <= 1) {
        this.end(top[0]?.playerId ?? null, tick, out);
      } else {
        this.setPhase('overtime', tick, out);
        out.push(announce(tick, 'overtime'));
      }
    }
  }

  private end(winner: PlayerId | null, tick: Tick, out: SimEvent[]): void {
    this.match.winner = winner;
    this.setPhase('ended', tick, out);
    for (const s of this.match.scores) {
      const pawn = this.pawns.get(s.playerId);
      if (pawn === undefined) continue;
      out.push(announce(tick, s.playerId === winner ? 'youWin' : 'youLose', pawn));
    }
  }

  // -- Scoring --------------------------------------------------------------

  /**
   * Scores this tick's deaths and appends score and announcer events.
   * Returns the first player to reach the frag limit, if any.
   */
  private scoreDeaths(
    events: readonly SimEvent[],
    view: MatchView,
    out: SimEvent[],
  ): PlayerScore | undefined {
    const headshots = new Set<string>();
    for (const ev of events) {
      if (ev.type === 'hitscan' && ev.headshot && ev.hitPawn !== NO_ENTITY) {
        headshots.add(`${ev.pawn}:${ev.hitPawn}`);
      }
    }

    const changed: PlayerScore[] = [];
    const touch = (s: PlayerScore): void => {
      if (!changed.includes(s)) changed.push(s);
    };
    const lines: SimEvent[] = [];
    const perKiller = new Map<PlayerScore, KillerLines>();
    const before = leaderFrags(this.match);
    let reachedLimit: PlayerScore | undefined;
    let anyKill = false;

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
        anyKill = true;
        killer.frags++;
        killer.spree++;
        touch(killer);
        if (!this.firstBloodDone) {
          this.firstBloodDone = true;
          lines.push(announce(view.tick, 'firstBlood'));
        }
        const entry = perKiller.get(killer) ?? { pawn: ev.killer, headshot: false };
        perKiller.set(killer, entry);
        if (headshots.has(`${ev.killer}:${ev.victim}`)) entry.headshot = true;
        entry.multi = multiKillLine(this.tracker(killer.playerId).kill(view.time)) ?? entry.multi;
        entry.spree = spreeLine(killer.spree) ?? entry.spree;
        if (!reachedLimit && this.match.fragLimit > 0 && killer.frags >= this.match.fragLimit) {
          reachedLimit = killer;
        }
      } else if (victim) {
        victim.suicides++;
        victim.frags--;
      }
    }

    for (const s of changed) {
      out.push({
        type: 'score',
        tick: view.tick,
        playerId: s.playerId,
        frags: s.frags,
        deaths: s.deaths,
      });
    }
    out.push(...lines);
    for (const entry of perKiller.values()) {
      if (entry.headshot) out.push(announce(view.tick, 'headshot', entry.pawn));
      if (entry.multi) out.push(announce(view.tick, entry.multi, entry.pawn));
      if (entry.spree) out.push(announce(view.tick, entry.spree, entry.pawn));
    }

    if (anyKill && !reachedLimit && this.match.fragLimit > 0) {
      const top = leaderFrags(this.match);
      const left = this.match.fragLimit - top;
      const line = FRAGS_LEFT_LINES.get(left);
      if (top > before && line && left < this.fragsLeftAnnounced) {
        this.fragsLeftAnnounced = left;
        out.push(announce(view.tick, line));
      }
    }
    return reachedLimit;
  }

  private learnPawns(events: readonly SimEvent[], view: MatchView): void {
    const learn = (pawn: PawnId): void => {
      if (pawn === NO_ENTITY) return;
      const playerId = view.playerFor(pawn);
      if (playerId !== undefined) this.pawns.set(playerId, pawn);
    };
    for (const ev of events) {
      if (ev.type === 'entitySpawned' && ev.kind === 'pawn') learn(ev.id);
      else if (ev.type === 'respawn') learn(ev.pawn);
      else if (ev.type === 'death') {
        learn(ev.victim);
        learn(ev.killer);
      }
    }
  }

  private tracker(playerId: PlayerId): MultiKillTracker {
    let t = this.multi.get(playerId);
    if (!t) {
      t = new MultiKillTracker(this.options.multiKillWindow);
      this.multi.set(playerId, t);
    }
    return t;
  }

  private score(playerId: PlayerId): PlayerScore | undefined {
    return this.match.scores.find((s) => s.playerId === playerId);
  }
}

function announce(tick: Tick, line: AnnouncerLine, toPawn: PawnId = NO_ENTITY): SimEvent {
  return { type: 'announcer', tick, line, toPawn };
}
