/**
 * P29 acceptance: a 60 s headless run on LAUNDRY_ROOM with four scripted
 * pawns (move, jump, dodge, fire) throws nothing and produces no NaNs.
 */
import { describe, expect, it } from 'vitest';
import { TICK_RATE, type InputCommand, type PawnId, type SimEvent } from '../types';
import { createWorld } from '../world';
import { scriptedInput, worldOptions } from './testing';

/** Paths of every non-finite number inside `value`. */
function nonFinite(value: unknown, path = '$', out: string[] = []): string[] {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) out.push(`${path}=${value}`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => nonFinite(v, `${path}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) nonFinite(v, `${path}.${k}`, out);
  }
  return out;
}

describe('headless laundry room run', () => {
  it('runs 60 s with 4 scripted pawns without exceptions or NaNs', async () => {
    const world = await createWorld(worldOptions());
    const pawns: PawnId[] = [0, 1, 2, 3].map((n) =>
      world.addPlayer(`bot:${n}`, { name: `Bot ${n}`, isBot: true, skill: n }),
    );
    const counts = new Map<SimEvent['type'], number>();
    for (let tick = 1; tick <= 60 * TICK_RATE; tick++) {
      const inputs = new Map<PawnId, InputCommand>();
      pawns.forEach((id, n) => inputs.set(id, scriptedInput(n, tick)));
      const events = world.step(inputs);
      for (const e of events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
      const bad = nonFinite(world.getState());
      if (bad.length) throw new Error(`tick ${tick}: ${bad.slice(0, 5).join(', ')}`);
      expect(nonFinite(events)).toEqual([]);
    }
    expect(world.tick).toBe(3600);
    // The script exercised the systems it is meant to.
    for (const type of ['respawn', 'jump', 'dodge', 'shotFired', 'land', 'footstep'] as const) {
      expect(counts.get(type) ?? 0, type).toBeGreaterThan(0);
    }
    world.dispose();
  }, 120_000);
});
