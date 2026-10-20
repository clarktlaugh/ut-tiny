import { describe, expect, it } from 'vitest';
import type { MatchState, PlayerScore } from '../types';
import { buildScoreboard, efficiencyOf, leaders } from './scoreboard';

function row(playerId: string, frags: number, deaths: number, suicides = 0): PlayerScore {
  return { playerId, name: playerId, isBot: playerId !== 'you', frags, deaths, suicides, spree: 0 };
}

function match(overrides: Partial<MatchState> = {}): MatchState {
  return {
    phase: 'playing',
    fragLimit: 20,
    timeLimit: 600,
    elapsed: 125,
    scores: [row('b', 4, 2), row('you', 7, 3, 1), row('c', 4, 1), row('d', 0, 0)],
    winner: null,
    ...overrides,
  };
}

describe('scoreboard', () => {
  it('sorts by frags, then fewer deaths, and shares ranks on equal frags', () => {
    const sb = buildScoreboard(match());
    expect(sb.rows.map((r) => [r.playerId, r.rank])).toEqual([
      ['you', 1],
      ['c', 2],
      ['b', 2],
      ['d', 4],
    ]);
  });

  it('efficiency is kills / (kills + deaths), with suicides added back to kills', () => {
    expect(efficiencyOf(row('you', 7, 3, 1))).toBeCloseTo(8 / 11);
    expect(efficiencyOf(row('d', 0, 0))).toBe(0);
    const you = buildScoreboard(match()).rows[0];
    expect(you).toMatchObject({ kills: 8, suicides: 1, ping: null, isBot: false });
  });

  it('reports frags remaining, time remaining and overtime', () => {
    expect(buildScoreboard(match())).toMatchObject({
      fragsRemaining: 13,
      timeRemaining: 475,
      overtime: 0,
    });
    expect(buildScoreboard(match({ fragLimit: 0, timeLimit: 0 }))).toMatchObject({
      fragsRemaining: null,
      timeRemaining: null,
    });
    expect(buildScoreboard(match({ phase: 'overtime', elapsed: 630 }))).toMatchObject({
      timeRemaining: 0,
      overtime: 30,
    });
  });

  it('marks the winner and fills pings when given', () => {
    const sb = buildScoreboard(match({ phase: 'ended', winner: 'you' }), new Map([['b', 42]]));
    expect(sb.winner).toBe('you');
    expect(sb.rows.find((r) => r.isWinner)?.playerId).toBe('you');
    expect(sb.rows.find((r) => r.playerId === 'b')?.ping).toBe(42);
  });

  it('leaders lists everyone tied for the top', () => {
    expect(leaders(match()).map((s) => s.playerId)).toEqual(['you']);
    expect(leaders(match({ scores: [row('a', 2, 0), row('b', 2, 5)] }))).toHaveLength(2);
    expect(leaders(match({ scores: [] }))).toEqual([]);
  });
});
