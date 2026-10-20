/**
 * `DeathmatchRules` inside the real world (P29's `createWorld`): countdown,
 * kill-volume suicides, spawn protection from the rules config, and the
 * time-limit end of a match.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { NO_ENTITY, type PawnState, type SimEvent } from '../types';
import { createWorld, type SimWorld } from '../world';
import { TEST_WORLD_RULES, flatMap, worldOptions } from '../world/testing';
import { DEATHMATCH_RULES } from './config';
import { DeathmatchRules } from './deathmatch';
import { lines, phases } from './testing';

const worlds: SimWorld[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.dispose();
});

function run(w: SimWorld, ticks: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < ticks; i++) out.push(...w.step(new Map()));
  return out;
}

describe('DeathmatchRules in the world', () => {
  it('counts down, plays, and ends at the time limit; ties go to overtime', async () => {
    const config = { ...DEATHMATCH_RULES, fragLimit: 5, timeLimit: 2 };
    const rules = new DeathmatchRules(config);
    const w = await createWorld(worldOptions({ map: flatMap(), rules: config }), { rules });
    worlds.push(w);
    const a = w.addPlayer('a', { name: 'A', isBot: false });
    w.addPlayer('b', { name: 'B', isBot: true });

    const events = run(w, 3 * 60 + 1);
    expect(lines(events)).toEqual(['countdown3', 'countdown2', 'countdown1', 'play']);
    expect(phases(events)).toEqual(['countdown', 'playing']);
    expect(w.getState().match.phase).toBe('playing');

    const more = run(w, 2 * 60);
    expect(phases(more)).toEqual(['overtime']);
    expect(w.getState().match.phase).toBe('overtime');
    expect(rules.pawnOf('a')).toBe(a);
  });

  it('a kill volume death is a suicide and decides an overtime', async () => {
    const config = { ...TEST_WORLD_RULES, timeLimit: 1 };
    const rules = new DeathmatchRules(config, { countdown: 0 });
    const map = flatMap({
      spawns: [
        { position: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 },
        { position: { x: 40, y: 0, z: 0 }, yaw: 0, pitch: 0 },
      ],
      volumes: [
        {
          kind: 'kill',
          box: { min: { x: -2, y: -1, z: -2 }, max: { x: 2, y: 3, z: 2 } },
          deathMessage: 'sumped',
        },
      ],
    });
    const w = await createWorld(worldOptions({ map, rules: config }), { rules });
    worlds.push(w);
    w.addPlayer('a', { name: 'A', isBot: false });
    w.addPlayer('b', { name: 'B', isBot: false });

    // Respawns happen within 2 s; whoever lands on the kill-volume spawn dies.
    const events = run(w, 6 * 60);
    const deaths = events.filter((e) => e.type === 'death');
    expect(deaths.length).toBeGreaterThan(0);
    expect(deaths.every((d) => d.type === 'death' && d.killer === NO_ENTITY)).toBe(true);
    const match = w.getState().match;
    expect(match.phase).toBe('ended');
    expect(match.winner).not.toBeNull();
    const loser = match.scores.find((s) => s.playerId !== match.winner);
    expect(loser?.suicides).toBeGreaterThan(0);
    expect(loser?.frags).toBeLessThan(0);
    const winnerPawn = w.pawnFor(match.winner ?? '');
    expect(lines(events, winnerPawn)).toContain('youWin');
    expect(events.filter((e) => e.type === 'score').length).toBeGreaterThan(0);
  });

  it('pawns spawn with the rules config spawn protection', async () => {
    const rules = new DeathmatchRules(DEATHMATCH_RULES);
    const w = await createWorld(worldOptions({ map: flatMap(), rules: DEATHMATCH_RULES }), {
      rules,
    });
    worlds.push(w);
    const a = w.addPlayer('a', { name: 'A', isBot: false });
    const events = run(w, 3 * 60);
    const spawn = events.find((e) => e.type === 'respawn');
    expect(spawn).toBeDefined();
    const pawn = w.getEntity(a) as PawnState;
    expect(pawn.spawnProtectedUntil - (spawn?.tick ?? 0)).toBe(
      DEATHMATCH_RULES.spawnProtection * 60,
    );
  });
});
