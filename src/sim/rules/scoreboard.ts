/**
 * Scoreboard data (§6): rows sorted for display plus the match clock and
 * frags remaining. Pure functions of `MatchState`; the HUD and the
 * end-of-match screen (P24) render them.
 */
import type { MatchState, PlayerId, PlayerScore, Seconds } from '../types';

export interface ScoreboardRow {
  /** 1-based; tied players share a rank. */
  rank: number;
  playerId: PlayerId;
  name: string;
  isBot: boolean;
  frags: number;
  /** Frags plus suicides: kills of other players. */
  kills: number;
  deaths: number;
  suicides: number;
  spree: number;
  /** kills / (kills + deaths), 0..1; 0 before any kill or death. */
  efficiency: number;
  /** Network ping in ms; null in single-player (multiplayer fills it later). */
  ping: number | null;
  isWinner: boolean;
}

export interface Scoreboard {
  rows: ScoreboardRow[];
  /** Frags the leader still needs, or null without a frag limit. */
  fragsRemaining: number | null;
  /** Seconds left on the clock (0 in overtime), or null without a time limit. */
  timeRemaining: Seconds | null;
  /** Seconds past the time limit while in overtime, else 0. */
  overtime: Seconds;
  winner: PlayerId | null;
}

/** Kills of other players (suicides cost a frag each, so add them back). */
export function killsOf(score: Readonly<PlayerScore>): number {
  return score.frags + score.suicides;
}

export function efficiencyOf(score: Readonly<PlayerScore>): number {
  const kills = killsOf(score);
  const total = kills + score.deaths;
  return total > 0 ? kills / total : 0;
}

/** Display order: frags high to low, then fewer deaths, then name, then id. */
export function compareScores(a: Readonly<PlayerScore>, b: Readonly<PlayerScore>): number {
  return (
    b.frags - a.frags ||
    a.deaths - b.deaths ||
    a.name.localeCompare(b.name) ||
    (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0)
  );
}

/** Highest frag count, or 0 with no players. */
export function leaderFrags(match: Readonly<MatchState>): number {
  let best = -Infinity;
  for (const s of match.scores) best = Math.max(best, s.frags);
  return best === -Infinity ? 0 : best;
}

/** Players sharing the highest frag count. */
export function leaders(match: Readonly<MatchState>): PlayerScore[] {
  if (match.scores.length === 0) return [];
  const top = leaderFrags(match);
  return match.scores.filter((s) => s.frags === top);
}

export function buildScoreboard(
  match: Readonly<MatchState>,
  pings?: ReadonlyMap<PlayerId, number>,
): Scoreboard {
  const sorted = [...match.scores].sort(compareScores);
  const rows: ScoreboardRow[] = [];
  sorted.forEach((s, i) => {
    const prev = rows[i - 1];
    const rank = prev && prev.frags === s.frags ? prev.rank : i + 1;
    rows.push({
      rank,
      playerId: s.playerId,
      name: s.name,
      isBot: s.isBot,
      frags: s.frags,
      kills: killsOf(s),
      deaths: s.deaths,
      suicides: s.suicides,
      spree: s.spree,
      efficiency: efficiencyOf(s),
      ping: pings?.get(s.playerId) ?? null,
      isWinner: match.winner === s.playerId,
    });
  });
  const fragsRemaining =
    match.fragLimit > 0 ? Math.max(0, match.fragLimit - leaderFrags(match)) : null;
  const timeRemaining = match.timeLimit > 0 ? Math.max(0, match.timeLimit - match.elapsed) : null;
  const overtime =
    match.phase === 'overtime' && match.timeLimit > 0
      ? Math.max(0, match.elapsed - match.timeLimit)
      : 0;
  return { rows, fragsRemaining, timeRemaining, overtime, winner: match.winner };
}
