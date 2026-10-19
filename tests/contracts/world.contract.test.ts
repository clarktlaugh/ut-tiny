/**
 * Behavioral contract for `World` (docs/DESIGN.md §8.1). The `World.step`,
 * participant and state guarantees are implemented by P29 (`src/sim/world.ts`);
 * the snapshot codec is still to come.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scriptedInput, worldOptions } from '../../src/sim/world/testing';
import { createWorld, type SimWorld } from '../../src/sim/world';
import {
  Buttons,
  NO_ENTITY,
  NULL_INPUT,
  TICK_DT,
  type EntityId,
  type InputCommand,
  type PawnId,
  type PawnState,
  type SimEvent,
  type WorldOptions,
} from '../../src/sim/types';

const worlds: SimWorld[] = [];

async function makeWorld(options: WorldOptions = worldOptions()): Promise<SimWorld> {
  const world = await createWorld(options);
  worlds.push(world);
  return world;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const w of worlds.splice(0)) w.dispose();
});

async function fourPawnWorld(): Promise<{ world: SimWorld; pawns: PawnId[] }> {
  const world = await makeWorld();
  const pawns = [0, 1, 2, 3].map((n) =>
    world.addPlayer(`bot:${n}`, { name: `B${n}`, isBot: true }),
  );
  return { world, pawns };
}

function scripted(pawns: readonly PawnId[], tick: number): Map<PawnId, InputCommand> {
  return new Map(pawns.map((id, n) => [id, scriptedInput(n, tick)]));
}

/** Entity ids an event is about (non-zero). */
function idsOf(e: SimEvent): EntityId[] {
  const ids: number[] = [];
  switch (e.type) {
    case 'entitySpawned':
    case 'entityDestroyed':
    case 'projectileDestroyed':
      ids.push(e.id);
      break;
    case 'shotFired':
    case 'footstep':
    case 'jump':
    case 'dodge':
    case 'land':
    case 'respawn':
    case 'weaponSwitched':
      ids.push(e.pawn);
      break;
    case 'hitscan':
      ids.push(e.pawn, e.hitPawn);
      break;
    case 'damage':
      ids.push(e.target, e.instigator);
      break;
    case 'death':
      ids.push(e.victim, e.killer);
      break;
    case 'explosion':
      ids.push(e.instigator);
      break;
    case 'pickupTaken':
      ids.push(e.pawn, e.pickup);
      break;
    case 'pickupRespawned':
      ids.push(e.pickup);
      break;
    case 'jumpPad':
      ids.push(e.pawn, e.pad);
      break;
    case 'teleport':
      ids.push(e.pawn, e.telefragged);
      break;
    case 'discDisrupted':
      ids.push(e.disc, e.byPawn);
      break;
    case 'guidanceStarted':
    case 'guidanceEnded':
      ids.push(e.pawn, e.projectile);
      break;
    case 'announcer':
      ids.push(e.toPawn);
      break;
    case 'score':
    case 'matchPhase':
      break;
  }
  return ids.filter((id) => id !== NO_ENTITY);
}

describe('World.step', () => {
  it('advances tick by exactly one and time by TICK_DT per call', async () => {
    const { world, pawns } = await fourPawnWorld();
    expect(world.tick).toBe(0);
    expect(world.getState().time).toBe(0);
    for (let i = 1; i <= 120; i++) {
      world.step(scripted(pawns, i));
      expect(world.tick).toBe(i);
      expect(world.getState().tick).toBe(i);
      expect(world.getState().time).toBeCloseTo(i * TICK_DT, 9);
    }
  });

  it('treats pawns missing from the input map as receiving NULL_INPUT', async () => {
    const a = await fourPawnWorld();
    const b = await fourPawnWorld();
    for (let tick = 1; tick <= 300; tick++) {
      // Pawn 3 sends nothing in world A and NULL_INPUT in world B.
      const inputsA = scripted(a.pawns.slice(0, 3), tick);
      const inputsB = scripted(b.pawns.slice(0, 3), tick);
      inputsB.set(b.pawns[3] as PawnId, { ...NULL_INPUT });
      expect(a.world.step(inputsA)).toEqual(b.world.step(inputsB));
      expect(a.world.getState()).toEqual(b.world.getState());
    }
  });

  it('is deterministic: same options and inputs produce identical states and events', async () => {
    const a = await fourPawnWorld();
    const b = await fourPawnWorld();
    let events = 0;
    for (let tick = 1; tick <= 600; tick++) {
      const ea = a.world.step(scripted(a.pawns, tick));
      const eb = b.world.step(scripted(b.pawns, tick));
      expect(JSON.stringify(eb)).toBe(JSON.stringify(ea));
      expect(JSON.stringify(b.world.getState())).toBe(JSON.stringify(a.world.getState()));
      events += ea.length;
    }
    expect(events).toBeGreaterThan(100);
    // A different seed diverges (spawn noise and spread use the RNG).
    const c = await makeWorld(worldOptions({ seed: 99 }));
    const cPawns = [0, 1, 2, 3].map((n) => c.addPlayer(`bot:${n}`, { name: `B${n}`, isBot: true }));
    for (let tick = 1; tick <= 600; tick++) c.step(scripted(cPawns, tick));
    expect(JSON.stringify(c.getState().entities)).not.toBe(
      JSON.stringify(a.world.getState().entities),
    );
  });

  it('never reads Date.now, performance.now or Math.random (lint rule + runtime guard)', async () => {
    const { world, pawns } = await fourPawnWorld();
    const offenders: string[] = [];
    // Rapier's WASM bindings time their own pipeline stages with performance.now
    // for profiling counters; nothing in the results depends on them.
    const fromRapier = (stack: string | undefined) => stack?.includes('rapier_wasm3d') ?? false;
    const guard =
      <T>(name: string, real: () => T) =>
      (): T => {
        const stack = new Error().stack;
        if (!fromRapier(stack)) offenders.push(`${name}\n${stack ?? ''}`);
        return real();
      };
    const realDate = Date.now.bind(Date);
    const realPerf = performance.now.bind(performance);
    const realRandom = Math.random.bind(Math);
    vi.spyOn(Date, 'now').mockImplementation(guard('Date.now', realDate));
    vi.spyOn(performance, 'now').mockImplementation(guard('performance.now', realPerf));
    vi.spyOn(Math, 'random').mockImplementation(guard('Math.random', realRandom));
    for (let tick = 1; tick <= 600; tick++) world.step(scripted(pawns, tick));
    expect(offenders).toEqual([]);
  });

  it('returns events in the order they occurred within the tick', async () => {
    const { world, pawns } = await fourPawnWorld();
    for (let tick = 1; tick <= 900; tick++) {
      const events = world.step(scripted(pawns, tick));
      for (const e of events) expect(e.tick).toBe(tick);
      const index = (pred: (e: SimEvent) => boolean) => events.findIndex(pred);
      for (const [i, e] of events.entries()) {
        // A pawn respawns before it does anything else that tick.
        if (e.type === 'shotFired' || e.type === 'jump' || e.type === 'footstep') {
          const r = index((x) => x.type === 'respawn' && x.pawn === e.pawn);
          if (r !== -1) expect(r).toBeLessThan(i);
        }
        // A death follows the hit that caused it.
        if (e.type === 'death' && e.damageType !== 'killVolume') {
          const d = index((x) => x.type === 'damage' && x.target === e.victim);
          expect(d).toBeGreaterThanOrEqual(0);
          expect(d).toBeLessThan(i);
        }
      }
    }
  });

  it('emits entitySpawned before any other event about that entity', async () => {
    const { world, pawns } = await fourPawnWorld();
    const spawned = new Set<EntityId>();
    for (let tick = 1; tick <= 1200; tick++) {
      for (const e of world.step(scripted(pawns, tick))) {
        if (e.type === 'entitySpawned') {
          expect(spawned.has(e.id)).toBe(false);
          spawned.add(e.id);
          continue;
        }
        for (const id of idsOf(e)) expect(spawned.has(id), `${e.type} ${id}`).toBe(true);
      }
    }
    // Every entity in the state was announced.
    for (const e of world.getState().entities) expect(spawned.has(e.id)).toBe(true);
  });

  it('emits entityDestroyed as the last event about that entity', async () => {
    const { world, pawns } = await fourPawnWorld();
    const destroyed = new Set<EntityId>();
    let count = 0;
    for (let tick = 1; tick <= 1200; tick++) {
      if (tick === 900) world.removePlayer('bot:2');
      for (const e of world.step(scripted(pawns, tick))) {
        for (const id of idsOf(e)) expect(destroyed.has(id), `${e.type} ${id}`).toBe(false);
        if (e.type === 'entityDestroyed') {
          destroyed.add(e.id);
          count++;
        }
      }
    }
    expect(count).toBeGreaterThan(0);
    expect(destroyed.has(pawns[2] as PawnId)).toBe(true);
  });
});

describe('World participants', () => {
  it('addPlayer creates a dead pawn and returns its id; pawnFor finds it', async () => {
    const world = await makeWorld();
    expect(world.pawnFor('local')).toBe(NO_ENTITY);
    const id = world.addPlayer('local', { name: 'You', isBot: false });
    expect(id).not.toBe(NO_ENTITY);
    expect(world.pawnFor('local')).toBe(id);
    expect(world.addPlayer('local', { name: 'You', isBot: false })).toBe(id);
    const pawn = world.getEntity(id) as PawnState;
    expect(pawn.kind).toBe('pawn');
    expect(pawn.playerId).toBe('local');
    expect(pawn.alive).toBe(false);
    // It respawns per the rules: a fresh pawn may respawn at once.
    const events = world.step(new Map());
    expect(events.find((e) => e.type === 'entitySpawned' && e.id === id)).toBeDefined();
    expect(events.find((e) => e.type === 'respawn' && e.pawn === id)).toBeDefined();
    expect((world.getEntity(id) as PawnState).alive).toBe(true);
  });

  // `PawnState` has no skill field (contract gap reported on issue #52), so the
  // world keeps the joining profile and serves it from `profileFor`.
  it('addPlayer with isBot=true carries the skill level onto the pawn state', async () => {
    const world = await makeWorld();
    const id = world.addPlayer('bot:1', { name: 'Bot', isBot: true, skill: 5 });
    expect(world.profileFor('bot:1')).toEqual({ name: 'Bot', isBot: true, skill: 5 });
    expect(world.playerFor(id)).toBe('bot:1');
    expect(world.getState().match.scores).toContainEqual(
      expect.objectContaining({ playerId: 'bot:1', name: 'Bot', isBot: true }),
    );
  });

  it('removePlayer destroys the pawn and every projectile, mine and disc it owns', async () => {
    const world = await makeWorld();
    const id = world.addPlayer('p', { name: 'P', isBot: false });
    const other = world.addPlayer('q', { name: 'Q', isBot: false });
    world.step(new Map());
    // Throw a disc (slot 1), then lob assault grenades (slot 2 alt).
    const owned = (): EntityId[] =>
      world
        .getState()
        .entities.filter((e) => e.kind === 'projectile' && e.owner === id)
        .map((e) => e.id);
    for (let t = 0; t < 60; t++) {
      const buttons = t < 30 ? (t % 2 ? Buttons.Fire : 0) : Buttons.AltFire;
      world.step(new Map([[id, { ...NULL_INPUT, weapon: t < 30 ? 1 : 2, pitch: 0.3, buttons }]]));
    }
    const before = owned();
    expect(before.length).toBeGreaterThan(0);
    expect(
      world
        .getState()
        .entities.some(
          (e) => e.kind === 'projectile' && 'projectileType' in e && e.projectileType === 'disc',
        ),
    ).toBe(true);

    world.removePlayer('p');
    expect(world.pawnFor('p')).toBe(NO_ENTITY);
    expect(world.getEntity(id)).toBeUndefined();
    expect(owned()).toEqual([]);
    const events = world.step(new Map());
    const destroyed = events.filter((e) => e.type === 'entityDestroyed').map((e) => e.id);
    for (const p of before) expect(destroyed).toContain(p);
    expect(destroyed[destroyed.length - 1]).toBe(id);
    expect(world.getEntity(other)).toBeDefined();
  });

  it('entity ids are never reused within a match', async () => {
    const world = await makeWorld();
    const seen = new Set<EntityId>();
    const note = (id: EntityId) => {
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    };
    for (const e of world.getState().entities) note(e.id);
    for (let round = 0; round < 5; round++) {
      const pawns = [0, 1].map((n) => {
        const id = world.addPlayer(`p${n}`, { name: `P${n}`, isBot: false });
        note(id);
        return id;
      });
      for (let tick = 1; tick <= 200; tick++) {
        for (const e of world.step(scripted(pawns, world.tick + 1))) {
          if (e.type === 'entitySpawned' && e.kind !== 'pawn' && world.tick > 1) note(e.id);
        }
      }
      world.removePlayer('p0');
      world.removePlayer('p1');
    }
  });
});

describe('World state', () => {
  it('getState().rngState equals the internal Rng state', async () => {
    const { world, pawns } = await fourPawnWorld();
    const initial = world.getState().rngState;
    expect(initial).toBe(world.rng.getState());
    for (let tick = 1; tick <= 120; tick++) {
      world.step(scripted(pawns, tick));
      expect(world.getState().rngState).toBe(world.rng.getState());
    }
    expect(world.getState().rngState).not.toBe(initial);
  });

  it('getState() reflects the last completed tick, not a partial one', async () => {
    const { world, pawns } = await fourPawnWorld();
    for (let tick = 1; tick <= 60; tick++) world.step(scripted(pawns, tick));
    const held = world.getState();
    const copy = structuredClone(held);
    for (let tick = 61; tick <= 120; tick++) {
      world.step(scripted(pawns, tick));
      // A snapshot already handed out never changes under its reader.
      expect(held).toEqual(copy);
    }
    const now = world.getState();
    expect(now.tick).toBe(world.tick);
    expect(now).not.toBe(held);
    // getEntity reads the same snapshot.
    for (const e of now.entities) expect(world.getEntity(e.id)).toEqual(e);
  });
});

describe('SnapshotCodec', () => {
  it.todo('decode(encode(state)) equals state up to position quantisation (1 cm)');
  it.todo('quaternions round-trip within 0.001 per component');
  it.todo('encodes 8 pawns and 50 projectiles in under 4 KB');
});
