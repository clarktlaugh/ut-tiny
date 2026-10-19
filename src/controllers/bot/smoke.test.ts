/**
 * P21 acceptance: three bots roam LAUNDRY_ROOM for 60 s, visit at least six
 * distinct pickups between them, and none is stuck for more than 5 s.
 */
import { describe, expect, it } from 'vitest';
import { LAUNDRY_ROOM } from '../../maps/laundry-room';
import { NavMesh, bakeNavMesh } from '../../nav';
import {
  TICK_RATE,
  type EntityId,
  type InputCommand,
  type PawnId,
  type PawnState,
  type Vec3,
} from '../../sim/types';
import { createWorld } from '../../sim/world';
import { worldOptions } from '../../sim/world/testing';
import { BotController } from './botController';
import { worldSenses } from './senses';

/** A bot that moves less than this within any 5 s stretch alive counts as stuck, m. */
const STUCK_EXTENT = 1;
const STUCK_WINDOW = 5 * TICK_RATE;

function extent(points: readonly Vec3[]): number {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  return Math.max(maxX - minX, maxY - minY, maxZ - minZ);
}

describe('bot smoke run (laundry room)', () => {
  it('3 bots visit ≥ 6 distinct pickups in 60 s and none is stuck > 5 s', async () => {
    const nav = new NavMesh(bakeNavMesh(LAUNDRY_ROOM));
    const world = await createWorld(worldOptions({ seed: 4242 }));
    const senses = worldSenses(world);
    const skills = [1, 3, 5];
    const bots: BotController[] = skills.map((skill, n) => {
      const pawnId = world.addPlayer(`bot:${n}`, { name: `Bot ${n}`, isBot: true, skill });
      return new BotController({ pawnId, nav, senses, skill, seed: 100 + n, map: LAUNDRY_ROOM });
    });
    const byPawn = new Map<PawnId, BotController>(bots.map((b) => [b.pawnId, b]));

    const taken = new Map<PawnId, Set<EntityId>>();
    const trail = new Map<PawnId, { alive: boolean; position: Vec3; note: string }[]>();
    const stuck: string[] = [];
    let deaths = 0;
    let shots = 0;
    let state = world.getState();
    const t0 = performance.now();
    for (let tick = 1; tick <= 60 * TICK_RATE; tick++) {
      const inputs = new Map<PawnId, InputCommand>();
      for (const bot of bots) inputs.set(bot.pawnId, bot.produce(tick, state));
      const events = world.step(inputs);
      state = world.getState();
      for (const bot of bots) bot.observe(events, state);
      for (const e of events) {
        if (e.type === 'pickupTaken' && byPawn.has(e.pawn)) {
          const set = taken.get(e.pawn) ?? new Set<EntityId>();
          set.add(e.pickup);
          taken.set(e.pawn, set);
        }
        if (e.type === 'death') deaths++;
        if (e.type === 'shotFired') shots++;
      }
      for (const e of state.entities) {
        if (e.kind !== 'pawn' || !byPawn.has(e.id)) continue;
        const list = trail.get(e.id) ?? [];
        const bot = byPawn.get(e.id);
        const g = bot?.currentGoal;
        const note = `${g?.kind}#${g?.pickup ?? g?.enemy ?? '-'} ${bot?.follower.currentStatus} wps=${bot?.follower.waypoints.length} tgt=${JSON.stringify(bot?.follower.target)} pos=${JSON.stringify(e.position)}`;
        list.push({ alive: e.alive, position: { ...e.position }, note });
        trail.set(e.id, list);
      }
    }
    const ms = performance.now() - t0;

    for (const [pawn, list] of trail) {
      for (let start = 0; start + STUCK_WINDOW <= list.length; start += TICK_RATE) {
        const window = list.slice(start, start + STUCK_WINDOW);
        if (!window.every((s) => s.alive)) continue;
        const ext = extent(window.map((s) => s.position));
        if (ext < STUCK_EXTENT) {
          stuck.push(
            `pawn ${pawn} moved ${ext.toFixed(2)} m in ticks ${start + 1}–${start + STUCK_WINDOW}: ${window[0]?.note} … ${window[window.length - 1]?.note}`,
          );
          break;
        }
      }
    }

    const distinct = new Set<EntityId>();
    for (const set of taken.values()) for (const id of set) distinct.add(id);
    const perBot = bots.map((b) => taken.get(b.pawnId)?.size ?? 0);
    console.log(
      `bots: ${distinct.size} distinct pickups (${perBot.join('/')} per bot), ${deaths} deaths, ${shots} shots, ${ms.toFixed(0)} ms for 60 s`,
    );
    for (const pawn of byPawn.keys()) {
      const p = state.entities.find((e) => e.id === pawn) as PawnState | undefined;
      console.log(`pawn ${pawn}: goal ${byPawn.get(pawn)?.currentGoal?.kind}, alive ${p?.alive}`);
    }
    expect(stuck).toEqual([]);
    expect(distinct.size).toBeGreaterThanOrEqual(6);
    world.dispose();
  }, 180_000);
});
