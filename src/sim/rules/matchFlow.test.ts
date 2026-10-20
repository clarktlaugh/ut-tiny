/**
 * App match flow (`src/app/matchFlow.ts`, §6). Lives here because the
 * packet owns `src/sim/rules/` and only the one file under `src/app/`.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MATCH_SETUP,
  END_SCREEN_SECONDS,
  MatchFlow,
  rulesFor,
  sanitizeSetup,
  type FlowState,
} from '../../app/matchFlow';
import type { MatchPhase, MatchState, SimEvent } from '../types';
import { DEATHMATCH_RULES } from './config';
import { DeathmatchRules } from './deathmatch';
import { RulesHarness } from './testing';

const phase = (p: MatchPhase): SimEvent => ({ type: 'matchPhase', tick: 1, phase: p });

function ended(): MatchState {
  return {
    phase: 'ended',
    fragLimit: 5,
    timeLimit: 0,
    elapsed: 61,
    winner: 'local',
    scores: [
      { playerId: 'bot:1', name: 'Bot', isBot: true, frags: 2, deaths: 5, suicides: 0, spree: 0 },
      { playerId: 'local', name: 'You', isBot: false, frags: 5, deaths: 2, suicides: 0, spree: 3 },
    ],
  };
}

describe('MatchFlow', () => {
  it('walks menu → setup → loading → countdown → playing → ended → menu', () => {
    const flow = new MatchFlow();
    const seen: [FlowState, FlowState][] = [];
    flow.onChange((s, prev) => seen.push([prev, s]));
    expect(flow.state).toBe('menu');
    expect(flow.openSetup()).toBe(true);
    expect(flow.start({ bots: 1, fragLimit: 5 })).toBe(true);
    expect(flow.setup).toMatchObject({ bots: 1, fragLimit: 5, map: 'laundry-room' });
    expect(flow.loaded()).toBe(true);
    expect(flow.inputEnabled).toBe(false);
    flow.handleEvents([phase('countdown')]);
    expect(flow.state).toBe('countdown');
    flow.handleEvents([phase('playing')]);
    expect(flow.state).toBe('playing');
    expect(flow.inputEnabled).toBe(true);
    flow.handleEvents([phase('ended')], ended());
    expect(flow.state).toBe('ended');
    expect(flow.inputEnabled).toBe(false);
    expect(flow.result?.winner).toBe('local');
    expect(flow.result?.scoreboard.rows[0]?.playerId).toBe('local');
    expect(flow.endScreenRemaining).toBe(END_SCREEN_SECONDS);
    flow.update(END_SCREEN_SECONDS - 0.5);
    expect(flow.state).toBe('ended');
    expect(flow.endScreenRemaining).toBeCloseTo(0.5);
    flow.update(0.5);
    expect(flow.state).toBe('menu');
    expect(seen).toEqual([
      ['menu', 'setup'],
      ['setup', 'loading'],
      ['loading', 'countdown'],
      ['countdown', 'playing'],
      ['playing', 'ended'],
      ['ended', 'menu'],
    ]);
  });

  it('rematch reloads with the same setup', () => {
    const flow = new MatchFlow();
    flow.start({ bots: 5, timeLimit: 120 });
    flow.loaded();
    flow.handleEvents([phase('playing'), phase('ended')]);
    expect(flow.rematch()).toBe(true);
    expect(flow.state).toBe('loading');
    expect(flow.setup).toMatchObject({ bots: 5, timeLimit: 120 });
  });

  it('overtime stays in playing and is flagged through to the end screen', () => {
    const flow = new MatchFlow();
    flow.start();
    flow.loaded();
    flow.handleEvents([phase('playing'), phase('overtime')]);
    expect(flow.state).toBe('playing');
    expect(flow.overtime).toBe(true);
    flow.handleEvents([phase('ended')]);
    expect(flow.overtime).toBe(true);
    flow.toMenu();
    expect(flow.overtime).toBe(false);
  });

  it('ignores invalid transitions and stray phase events', () => {
    const flow = new MatchFlow();
    expect(flow.loaded()).toBe(false);
    expect(flow.rematch()).toBe(false);
    flow.handleEvents([phase('playing')]);
    expect(flow.state).toBe('menu');
    flow.openSetup();
    expect(flow.openSetup()).toBe(false);
    flow.start();
    expect(flow.start()).toBe(false);
    flow.handleEvents([phase('ended')]);
    expect(flow.state).toBe('loading');
    flow.update(100);
    expect(flow.state).toBe('loading');
    expect(flow.toMenu()).toBe(true);
    expect(flow.toMenu()).toBe(false);
  });

  it('follows a real DeathmatchRules match to the end', () => {
    const flow = new MatchFlow();
    flow.start({ fragLimit: 1, timeLimit: 0 });
    const rules = new DeathmatchRules(rulesFor(flow.setup));
    const h = new RulesHarness(rules).join('local', 1).join('bot:1', 2, true);
    flow.loaded();
    flow.handleEvents(h.step(), rules.state());
    expect(flow.state).toBe('countdown');
    flow.handleEvents(h.wait(3), rules.state());
    expect(flow.state).toBe('playing');
    flow.handleEvents(h.kill(1, 2), rules.state());
    expect(flow.state).toBe('ended');
    expect(flow.result?.winner).toBe('local');
  });
});

describe('setup', () => {
  it('sanitizes setups', () => {
    expect(sanitizeSetup({})).toEqual(DEFAULT_MATCH_SETUP);
    expect(
      sanitizeSetup({ map: '', bots: -2, botSkill: 9.6, fragLimit: 2.4, timeLimit: Number.NaN }),
    ).toEqual({
      map: DEFAULT_MATCH_SETUP.map,
      bots: 0,
      botSkill: 7,
      fragLimit: 2,
      timeLimit: DEFAULT_MATCH_SETUP.timeLimit,
    });
  });

  it('rulesFor keeps the deathmatch defaults and applies the limits', () => {
    expect(rulesFor({ ...DEFAULT_MATCH_SETUP, fragLimit: 7, timeLimit: 0 })).toEqual({
      ...DEATHMATCH_RULES,
      fragLimit: 7,
      timeLimit: 0,
    });
    expect(DEFAULT_MATCH_SETUP).toMatchObject({ fragLimit: 20, timeLimit: 600 });
  });
});
