/**
 * Deathmatch rules (§6): scoring, every announcer trigger, and every way a
 * match ends.
 */
import { describe, expect, it } from 'vitest';
import { NO_ENTITY, TICK_RATE, type RulesConfig, type SimEvent } from '../types';
import { DEATHMATCH_RULES } from './config';
import { DeathmatchRules } from './deathmatch';
import { RulesHarness, death, lines, phases } from './testing';

const A = 1;
const B = 2;
const C = 3;
const D = 4;

function harness(
  rules: Partial<RulesConfig> = {},
  countdown = 0,
  players = ['a', 'b', 'c', 'd'],
): RulesHarness {
  const h = new RulesHarness(
    new DeathmatchRules(
      { ...DEATHMATCH_RULES, fragLimit: 0, timeLimit: 0, ...rules },
      { countdown },
    ),
  );
  players.forEach((p, i) => h.join(p, i + 1));
  return h;
}

function score(h: RulesHarness, playerId: string) {
  const s = h.rules.state().scores.find((x) => x.playerId === playerId);
  if (!s) throw new Error(`no score for ${playerId}`);
  return s;
}

describe('match phases', () => {
  it('starts in warmup, counts down 3 s with countdown3/2/1, then announces play', () => {
    const h = harness({}, 3);
    expect(h.rules.state().phase).toBe('warmup');
    const first = h.step();
    expect(phases(first)).toEqual(['countdown']);
    expect(lines(first)).toEqual(['countdown3']);
    expect(lines(h.run(TICK_RATE - 1))).toEqual([]);
    expect(lines(h.step())).toEqual(['countdown2']);
    expect(lines(h.run(TICK_RATE - 1))).toEqual([]);
    expect(lines(h.step())).toEqual(['countdown1']);
    expect(h.run(TICK_RATE - 1)).toEqual([]);
    const go = h.step();
    expect(phases(go)).toEqual(['playing']);
    expect(lines(go)).toEqual(['play']);
    expect(h.rules.state().elapsed).toBe(0);
    h.wait(2);
    expect(h.rules.state().elapsed).toBeCloseTo(2);
  });

  it('countdown 0 starts playing on the first tick', () => {
    const h = harness();
    const out = h.step();
    expect(phases(out)).toEqual(['playing']);
    expect(lines(out)).toEqual(['play']);
  });

  it('does not score deaths before play starts and keeps the clock at 0', () => {
    const h = harness({}, 3);
    h.step();
    h.kill(A, B);
    h.kill(C, C);
    expect(score(h, 'a').frags).toBe(0);
    expect(score(h, 'b').deaths).toBe(0);
    expect(score(h, 'c').frags).toBe(0);
    expect(h.rules.state().elapsed).toBe(0);
  });
});

describe('scoring', () => {
  it('a kill is +1 frag for the killer and a death for the victim, with score events', () => {
    const h = harness();
    h.step();
    const out = h.kill(A, B);
    expect(score(h, 'a')).toMatchObject({ frags: 1, deaths: 0, spree: 1 });
    expect(score(h, 'b')).toMatchObject({ frags: 0, deaths: 1, spree: 0 });
    const scores = out.filter((e) => e.type === 'score');
    expect(scores).toEqual([
      { type: 'score', tick: h.tick, playerId: 'b', frags: 0, deaths: 1 },
      { type: 'score', tick: h.tick, playerId: 'a', frags: 1, deaths: 0 },
    ]);
  });

  it('suicide by own weapon or the environment costs 1 frag', () => {
    const h = harness();
    h.step();
    h.kill(A, B);
    h.kill(A, A, 'rocket');
    expect(score(h, 'a')).toMatchObject({ frags: 0, deaths: 1, suicides: 1, spree: 0 });
    h.kill(NO_ENTITY, A, 'killVolume');
    expect(score(h, 'a')).toMatchObject({ frags: -1, deaths: 2, suicides: 2 });
  });

  it('telefrags count as frags for the teleporting pawn', () => {
    const h = harness();
    h.step();
    h.kill(C, D, 'telefrag');
    expect(score(h, 'c').frags).toBe(1);
    expect(score(h, 'd').deaths).toBe(1);
  });
});

describe('announcer', () => {
  it('firstBlood goes to everyone once, on the first kill only (not a suicide)', () => {
    const h = harness();
    h.step();
    expect(lines(h.kill(B, B))).not.toContain('firstBlood');
    const first = h.kill(A, B);
    expect(first).toContainEqual({
      type: 'announcer',
      tick: h.tick,
      line: 'firstBlood',
      toPawn: NO_ENTITY,
    });
    expect(lines(h.kill(C, D))).not.toContain('firstBlood');
    expect(lines(h.log).filter((l) => l === 'firstBlood')).toHaveLength(1);
  });

  it('kills under 3 s apart escalate double → multi → mega → ultra → monster', () => {
    const h = harness();
    h.step();
    const got: (string | undefined)[] = [];
    for (let i = 0; i < 7; i++) {
      got.push(lines(h.kill(A, B), A).find((l) => l.endsWith('Kill')));
      h.wait(2.9);
    }
    expect(got).toEqual([
      undefined,
      'doubleKill',
      'multiKill',
      'megaKill',
      'ultraKill',
      'monsterKill',
      'monsterKill',
    ]);
  });

  it('a 3 s gap breaks the chain', () => {
    const h = harness();
    h.step();
    h.kill(A, B);
    h.wait(3);
    expect(lines(h.kill(A, B), A)).toEqual([]);
    h.wait(1);
    expect(lines(h.kill(A, B), A)).toEqual(['doubleKill']);
  });

  it('several kills in one tick give one line, the highest reached', () => {
    const h = harness();
    h.step();
    const out = h.step([death(A, B), death(A, C), death(A, D)]);
    expect(lines(out, A)).toEqual(['multiKill']);
  });

  it('sprees announce to the killer at 5, 10, 15, 20, 25 and reset on death', () => {
    const h = harness();
    h.step();
    const heard: [number, string][] = [];
    for (let k = 1; k <= 26; k++) {
      h.wait(4); // past the multi-kill window
      for (const l of lines(h.kill(A, B), A)) heard.push([k, l]);
    }
    expect(heard).toEqual([
      [5, 'killingSpree'],
      [10, 'rampage'],
      [15, 'dominating'],
      [20, 'unstoppable'],
      [25, 'godlike'],
    ]);
    h.kill(C, A);
    expect(score(h, 'a').spree).toBe(0);
    for (let k = 1; k <= 4; k++) {
      h.wait(4);
      expect(lines(h.kill(A, B), A)).toEqual([]);
    }
    h.wait(4);
    expect(lines(h.kill(A, B), A)).toEqual(['killingSpree']);
  });

  it('headshot goes to the killer when the killing hit was a headshot', () => {
    const h = harness();
    h.step();
    const shot = (headshot: boolean) => ({
      type: 'hitscan' as const,
      pawn: A,
      weapon: 'sniper' as const,
      from: { x: 0, y: 0, z: 0 },
      to: { x: 1, y: 0, z: 0 },
      hitPawn: B,
      headshot,
    });
    const hit = h.step([shot(true), death(A, B, 'sniper')]);
    expect(hit).toContainEqual({ type: 'announcer', tick: h.tick, line: 'headshot', toPawn: A });
    h.wait(4);
    expect(lines(h.step([shot(false), death(A, B, 'sniper')]))).not.toContain('headshot');
    h.wait(4);
    // A headshot that did not kill is no announcement.
    expect(lines(h.step([shot(true)]))).toEqual([]);
  });

  it('frags-remaining lines play once each as the leader nears the limit', () => {
    const h = harness({ fragLimit: 5 });
    h.step();
    const heard = (): string[] =>
      lines(h.kill(A, B)).filter((l) => l.endsWith('FragsLeft') || l === 'oneFragLeft');
    h.wait(4);
    expect(heard()).toEqual([]); // 1 frag, 4 left
    h.wait(4);
    expect(heard()).toEqual(['threeFragsLeft']);
    h.wait(4);
    expect(heard()).toEqual(['twoFragsLeft']);
    // Leader suicides back down and climbs again: no repeat.
    h.kill(A, A);
    h.wait(4);
    expect(heard()).toEqual([]);
    h.wait(4);
    expect(heard()).toEqual(['oneFragLeft']);
    // The broadcast goes to everyone.
    expect(h.log.find((e) => e.type === 'announcer' && e.line === 'oneFragLeft')).toMatchObject({
      toPawn: NO_ENTITY,
    });
  });

  it('a jump past several thresholds plays only the closest', () => {
    const h = harness({ fragLimit: 4 });
    h.step();
    const out = h.step([death(A, B), death(A, C), death(A, D)]);
    expect(lines(out)).toContain('oneFragLeft');
    expect(lines(out)).not.toContain('twoFragsLeft');
    expect(lines(out)).not.toContain('threeFragsLeft');
  });

  it('a frag limit of 3 does not announce threeFragsLeft at the start', () => {
    const h = harness({ fragLimit: 3 });
    expect(lines(h.step())).toEqual(['play']);
    expect(lines(h.kill(A, B))).toContain('twoFragsLeft');
  });

  it('overtime is announced to everyone', () => {
    const h = harness({ timeLimit: 1 });
    h.step();
    const out = h.wait(1);
    expect(phases(out)).toEqual(['overtime']);
    expect(out).toContainEqual({
      type: 'announcer',
      tick: h.tick,
      line: 'overtime',
      toPawn: NO_ENTITY,
    });
  });
});

describe('end of match', () => {
  it('reaching the frag limit ends the match with that player as winner', () => {
    const h = harness({ fragLimit: 3 });
    h.step();
    h.kill(A, B);
    h.kill(A, C);
    h.kill(B, C);
    const end = h.kill(A, D);
    const match = h.rules.state();
    expect(match.phase).toBe('ended');
    expect(match.winner).toBe('a');
    expect(phases(end)).toEqual(['ended']);
    expect(lines(end, A)).toContain('youWin');
    for (const p of [B, C, D]) expect(lines(end, p)).toEqual(['youLose']);
  });

  it('the frag limit is checked per kill: the first to reach it wins', () => {
    const h = harness({ fragLimit: 2 });
    h.step();
    h.kill(A, C);
    h.kill(B, C);
    h.step([death(B, D), death(A, D)]);
    expect(h.rules.state().winner).toBe('b');
  });

  it('nothing is scored after the end and the clock stops', () => {
    const h = harness({ fragLimit: 1 });
    h.step();
    h.kill(A, B);
    const elapsed = h.rules.state().elapsed;
    const after = h.kill(B, A);
    h.wait(5);
    expect(after).toEqual([]);
    expect(score(h, 'b').frags).toBe(0);
    expect(score(h, 'a').deaths).toBe(0);
    expect(h.rules.state().elapsed).toBe(elapsed);
    expect(h.rules.state().phase).toBe('ended');
  });

  it('the time limit ends the match with a single leader as winner', () => {
    const h = harness({ timeLimit: 10 });
    h.step();
    h.kill(B, A);
    const out = h.wait(10);
    expect(phases(out)).toEqual(['ended']);
    expect(h.rules.state().winner).toBe('b');
    expect(h.rules.state().elapsed).toBeCloseTo(10);
  });

  it('a tie at the time limit enters overtime; the next tie-breaking frag ends it', () => {
    const h = harness({ timeLimit: 2 });
    h.step();
    h.kill(A, C);
    h.kill(B, C);
    h.wait(2);
    expect(h.rules.state().phase).toBe('overtime');
    expect(h.rules.state().winner).toBeNull();
    // A frag that keeps a tie at the top (now three-way) does not end it.
    h.kill(C, D);
    expect(h.rules.state().phase).toBe('overtime');
    h.wait(30);
    expect(h.rules.state().phase).toBe('overtime');
    const end = h.kill(B, D);
    expect(phases(end)).toEqual(['ended']);
    expect(h.rules.state().winner).toBe('b');
    expect(lines(end, B)).toContain('youWin');
  });

  it('overtime also ends when a suicide breaks the tie', () => {
    const h = harness({ timeLimit: 1 }, 0, ['a', 'b']);
    h.step();
    h.wait(1);
    expect(h.rules.state().phase).toBe('overtime');
    h.kill(A, A);
    expect(h.rules.state().phase).toBe('ended');
    expect(h.rules.state().winner).toBe('b');
  });

  it('a time limit with nobody playing ends with no winner', () => {
    const h = harness({ timeLimit: 1 }, 0, []);
    h.step();
    h.wait(1);
    expect(h.rules.state()).toMatchObject({ phase: 'ended', winner: null });
  });

  it('a single player wins at the time limit', () => {
    const h = harness({ timeLimit: 1 }, 0, ['solo']);
    h.step();
    const out = h.wait(1);
    expect(h.rules.state().winner).toBe('solo');
    expect(lines(out, A)).toEqual(['youWin']);
  });

  it('with both limits off the match never ends', () => {
    const h = harness();
    h.step();
    for (let i = 0; i < 50; i++) h.kill(A, B);
    h.wait(20 * 60);
    expect(h.rules.state().phase).toBe('playing');
    expect(score(h, 'a').frags).toBe(50);
  });

  it('a player leaving overtime can leave a single leader', () => {
    const h = harness({ timeLimit: 1 }, 0, ['a', 'b']);
    h.step();
    h.wait(1);
    h.leave('a');
    h.step();
    expect(h.rules.state()).toMatchObject({ phase: 'ended', winner: 'b' });
  });
});

describe('players', () => {
  it('learns pawns from spawn, respawn and death events', () => {
    const rules = new DeathmatchRules({ ...DEATHMATCH_RULES, fragLimit: 0, timeLimit: 0 });
    const h = new RulesHarness(rules).join('a', A).join('b', B);
    h.step();
    expect(rules.pawnOf('a')).toBe(A);
    expect(rules.pawnOf('nobody')).toBe(NO_ENTITY);
  });

  it('removePlayer drops the score row', () => {
    const h = harness();
    h.step();
    h.leave('c');
    expect(h.rules.state().scores.map((s) => s.playerId)).toEqual(['a', 'b', 'd']);
  });

  it('adding a player twice keeps one row', () => {
    const rules = new DeathmatchRules(DEATHMATCH_RULES);
    rules.addPlayer('a', { name: 'A', isBot: false });
    rules.addPlayer('a', { name: 'A', isBot: false });
    expect(rules.state().scores).toHaveLength(1);
    expect(rules.state()).toMatchObject({ phase: 'warmup', fragLimit: 20, timeLimit: 600 });
  });

  it('is deterministic for the same event sequence', () => {
    const play = (): SimEvent[] => {
      const h = harness({ fragLimit: 6, timeLimit: 30 }, 3);
      for (let i = 0; i < 400; i++) {
        const k = (i * 7) % 4;
        const v = (i * 3 + 1) % 4;
        h.step(i % 37 === 0 ? [death(k + 1, v + 1)] : []);
      }
      return h.log;
    };
    expect(play()).toEqual(play());
  });
});
