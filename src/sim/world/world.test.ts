/**
 * World v1 wiring tests (P29): each sim system reached through `World.step`
 * on small purpose-built maps.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  Buttons,
  NO_ENTITY,
  NULL_INPUT,
  TICK_RATE,
  type InputCommand,
  type MapDef,
  type PawnId,
  type PawnState,
  type SimEvent,
} from '../types';
import { anglesFromDirection, eyePosition } from '../weapons/core';
import { createWorld, type SimWorld } from '../world';
import { TEST_WORLD_RULES, flatMap, worldOptions } from './testing';

const worlds: SimWorld[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.dispose();
});

async function world(map: MapDef, spawnProtection = 0): Promise<SimWorld> {
  const w = await createWorld(
    worldOptions({ map, rules: { ...TEST_WORLD_RULES, spawnProtection } }),
  );
  worlds.push(w);
  return w;
}

function pawn(w: SimWorld, id: PawnId): PawnState {
  return w.getEntity(id) as PawnState;
}

function run(
  w: SimWorld,
  ticks: number,
  inputs: (tick: number) => Map<PawnId, InputCommand> = () => new Map(),
): SimEvent[] {
  const all: SimEvent[] = [];
  for (let i = 0; i < ticks; i++) all.push(...w.step(inputs(w.tick + 1)));
  return all;
}

describe('World wiring', () => {
  it('kill volumes kill on entry with their message; the pawn respawns 2 s later', async () => {
    const w = await world(
      flatMap({
        volumes: [
          {
            kind: 'kill',
            box: { min: { x: -2, y: -1, z: -2 }, max: { x: 2, y: 3, z: 2 } },
            deathMessage: 'sumped',
          },
        ],
      }),
    );
    const id = w.addPlayer('p', { name: 'P', isBot: false });
    const first = w.step(new Map());
    expect(first.map((e) => e.type)).toContain('respawn');
    expect(first).toContainEqual(
      expect.objectContaining({
        type: 'death',
        victim: id,
        damageType: 'killVolume',
        message: 'sumped',
      }),
    );
    expect(pawn(w, id).alive).toBe(false);
    expect(w.getState().match.scores[0]).toMatchObject({ deaths: 1, suicides: 1, frags: -1 });
    const later = run(w, 2 * TICK_RATE);
    const respawn = later.find((e) => e.type === 'respawn');
    expect(respawn?.tick).toBe(1 + 2 * TICK_RATE);
  });

  it('damage volumes hurt in whole points per second', async () => {
    const w = await world(
      flatMap({
        volumes: [
          {
            kind: 'damage',
            box: { min: { x: -2, y: -1, z: -2 }, max: { x: 2, y: 3, z: 2 } },
            damagePerSecond: 30,
          },
        ],
      }),
    );
    const id = w.addPlayer('p', { name: 'P', isBot: false });
    const events = run(w, TICK_RATE);
    const hurt = events.filter((e) => e.type === 'damage' && e.damageType === 'damageVolume');
    expect(hurt.length).toBeGreaterThan(0);
    expect(pawn(w, id).health).toBe(70);
  });

  it('jump pads launch the pawn and report the pad entity', async () => {
    const w = await world(
      flatMap({
        jumpPads: [
          {
            position: { x: 0, y: 0.5, z: 0 },
            size: { x: 2, y: 1, z: 2 },
            launch: { x: 0, y: 15, z: 3 },
          },
        ],
      }),
    );
    const id = w.addPlayer('p', { name: 'P', isBot: false });
    const events = run(w, 3);
    const pad = events.find((e) => e.type === 'jumpPad');
    expect(pad).toMatchObject({ pawn: id });
    const padEntity = w.getState().entities.find((e) => e.kind === 'jumpPad');
    expect(pad && 'pad' in pad && pad.pad).toBe(padEntity?.id);
    expect(pawn(w, id).velocity.y).toBeGreaterThan(10);
  });

  it('pickups are taken by touch and switch to a stronger weapon', async () => {
    const w = await world(
      flatMap({
        pickups: [
          { type: 'shieldPack', position: { x: 0, y: 0.5, z: 0 } },
          { type: 'weapon', weapon: 'shock', position: { x: 0, y: 0.5, z: 0 } },
        ],
      }),
    );
    const id = w.addPlayer('p', { name: 'P', isBot: false });
    const events = run(w, 30);
    expect(events.filter((e) => e.type === 'pickupTaken').map((e) => e.pickupType)).toEqual([
      'shieldPack',
      'weapon',
    ]);
    const s = pawn(w, id);
    expect(s.shield).toBe(50);
    expect(s.owned).toContain('shock');
    expect(s.weapon).toBe('shock');
  });

  it('long falls deal fall damage through the pipeline', async () => {
    const w = await world(
      flatMap({ spawns: [{ position: { x: 0, y: 40, z: 0 }, yaw: 0, pitch: 0 }] }),
    );
    const id = w.addPlayer('p', { name: 'P', isBot: false });
    const events = run(w, 4 * TICK_RATE);
    const fall = events.find((e) => e.type === 'damage' && e.damageType === 'fall');
    expect(fall).toMatchObject({ target: id, instigator: NO_ENTITY });
    expect(events.find((e) => e.type === 'land')).toBeDefined();
  });

  it('hitscan kills credit the killer; the victim respawns', async () => {
    const w = await world(
      flatMap({
        spawns: [
          { position: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 },
          { position: { x: 0, y: 0, z: -6 }, yaw: 0, pitch: 0 },
        ],
      }),
    );
    const a = w.addPlayer('a', { name: 'A', isBot: false });
    const b = w.addPlayer('b', { name: 'B', isBot: false });
    run(w, 30);
    const aim = (): InputCommand => {
      const from = eyePosition(pawn(w, a));
      const to = pawn(w, b).position;
      const { yaw, pitch } = anglesFromDirection({
        x: to.x - from.x,
        y: to.y - from.y,
        z: to.z - from.z,
      });
      return { ...NULL_INPUT, yaw, pitch, buttons: Buttons.Fire };
    };
    let death: SimEvent | undefined;
    for (let i = 0; i < 10 * TICK_RATE && !death; i++) {
      death = w.step(new Map([[a, aim()]])).find((e) => e.type === 'death' && e.victim === b);
    }
    expect(death).toMatchObject({ killer: a, weapon: 'assault', damageType: 'bullet' });
    const scores = w.getState().match.scores;
    expect(scores.find((s) => s.playerId === 'a')?.frags).toBe(1);
    expect(scores.find((s) => s.playerId === 'b')?.deaths).toBe(1);
    const after = run(w, 3 * TICK_RATE);
    expect(after.find((e) => e.type === 'respawn' && e.pawn === b)).toBeDefined();
  });

  it('the Fire press that respawns a pawn neither fires nor ends spawn protection', async () => {
    const w = await world(flatMap(), 2);
    const id = w.addPlayer('p', { name: 'P', isBot: false });
    const fire = new Map([[id, { ...NULL_INPUT, buttons: Buttons.Fire }]]);
    const held = run(w, 30, () => fire);
    expect(held.find((e) => e.type === 'respawn')).toBeDefined();
    expect(held.find((e) => e.type === 'shotFired')).toBeUndefined();
    expect(pawn(w, id).spawnProtectedUntil).toBeGreaterThan(w.tick);
    run(w, 1);
    const pressed = run(w, 5, () => fire);
    expect(pressed.find((e) => e.type === 'shotFired')).toBeDefined();
    expect(pawn(w, id).spawnProtectedUntil).toBeLessThanOrEqual(w.tick);
  });

  it('keeps one translocator disc per pawn until the translocator packet lands', async () => {
    const w = await world(flatMap());
    const id = w.addPlayer('p', { name: 'P', isBot: false });
    run(w, 2);
    for (let i = 0; i < 6; i++) {
      run(w, 1, () => new Map([[id, { ...NULL_INPUT, weapon: 1, buttons: Buttons.Fire }]]));
      run(w, 20, () => new Map([[id, { ...NULL_INPUT, weapon: 1 }]]));
    }
    const discs = w.getState().entities.filter((e) => e.kind === 'projectile');
    expect(discs).toHaveLength(1);
    expect(pawn(w, id).disc).toBe(discs[0]?.id);
  });

  it('sanitises non-finite input', async () => {
    const w = await world(flatMap());
    const id = w.addPlayer('p', { name: 'P', isBot: false });
    run(
      w,
      5,
      () =>
        new Map([
          [
            id,
            { ...NULL_INPUT, moveX: NaN, moveY: Infinity, yaw: NaN, pitch: -Infinity, weapon: 2.5 },
          ],
        ]),
    );
    const s = pawn(w, id);
    expect(Number.isFinite(s.position.x + s.position.y + s.position.z + s.yaw + s.pitch)).toBe(
      true,
    );
  });
});
