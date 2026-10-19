import { describe, expect, it } from 'vitest';
import { LAUNDRY_ROOM } from '../../maps/laundry-room';
import { Buttons, NULL_INPUT, type InputCommand, type PawnState } from '../../sim/types';
import { DemoWorld } from './demoWorld';
import { DummyController } from './dummyController';

function pawnOf(world: DemoWorld, id: number): PawnState {
  const e = world.getState().entities.find((x) => x.id === id);
  if (e?.kind !== 'pawn') throw new Error(`no pawn ${id}`);
  return e;
}

function finite(p: PawnState): boolean {
  return [p.position.x, p.position.y, p.position.z, p.velocity.x, p.velocity.y, p.velocity.z].every(
    Number.isFinite,
  );
}

describe('DemoWorld', () => {
  it('spawns players on the map, lands them on the ground and lists the pickups', async () => {
    const world = await DemoWorld.create({ map: LAUNDRY_ROOM, seed: 3 });
    const local = world.addPlayer('local', { name: 'You', isBot: false });
    const bot = world.addPlayer('bot:1', { name: 'Dummy', isBot: true });
    const first = world.step(new Map());
    expect(first.filter((e) => e.type === 'entitySpawned').length).toBe(
      LAUNDRY_ROOM.pickups.length,
    );
    expect(
      first.filter((e) => e.type === 'respawn').map((e) => e.type === 'respawn' && e.pawn),
    ).toEqual([local, bot]);
    for (let i = 0; i < 120; i++) world.step(new Map());
    for (const id of [local, bot]) {
      const p = pawnOf(world, id);
      expect(p.alive).toBe(true);
      expect(p.grounded).toBe(true);
      expect(finite(p)).toBe(true);
      expect(p.owned).toEqual(['assault', 'rocket', 'shock']);
      expect(p.weapon).toBe('shock');
    }
    expect(world.getState().entities.filter((e) => e.kind === 'pickup').length).toBe(
      LAUNDRY_ROOM.pickups.length,
    );
    expect(world.tick).toBe(121);
    world.physics.dispose();
  });

  it('a shock beam kills a dummy, scores a frag, and the dummy respawns', async () => {
    const world = await DemoWorld.create({ map: LAUNDRY_ROOM, seed: 3 });
    const local = world.addPlayer('local', { name: 'You', isBot: false });
    const bot = world.addPlayer('bot:1', { name: 'Dummy', isBot: true });
    for (let i = 0; i < 180; i++) world.step(new Map()); // spawn protection over
    expect(world.teleportPawn(local, { x: 0, y: 1, z: 10 }, 0)).toBe(true);
    expect(world.teleportPawn(bot, { x: 0, y: 1, z: -5 }, Math.PI)).toBe(true);
    for (let i = 0; i < 30; i++) world.step(new Map()); // settle on the floor
    const fire: InputCommand = { ...NULL_INPUT, yaw: 0, pitch: 0, buttons: Buttons.Fire };
    const events = world.step(new Map([[local, fire]]));
    const types = events.map((e) => e.type);
    expect(types).toContain('shotFired');
    expect(types).toContain('hitscan');
    expect(types).toContain('death');
    expect(pawnOf(world, bot).alive).toBe(false);
    expect(world.scoreFor('local')?.frags).toBe(1);
    expect(world.scoreFor('bot:1')?.deaths).toBe(1);
    // Auto-respawn after 2 s.
    let respawned = false;
    for (let i = 0; i < 150 && !respawned; i++) {
      respawned = world.step(new Map()).some((e) => e.type === 'respawn' && e.pawn === bot);
    }
    expect(respawned).toBe(true);
    expect(pawnOf(world, bot).alive).toBe(true);
    world.physics.dispose();
  });

  it('rockets fly, explode and knock the shooter around without NaNs', async () => {
    const world = await DemoWorld.create({ map: LAUNDRY_ROOM, seed: 5 });
    const local = world.addPlayer('local', { name: 'You', isBot: false });
    for (let i = 0; i < 180; i++) world.step(new Map());
    world.teleportPawn(local, { x: 0, y: 1, z: 10 }, 0);
    for (let i = 0; i < 30; i++) world.step(new Map());
    const select: InputCommand = { ...NULL_INPUT, weapon: 4 };
    for (let i = 0; i < 30; i++) world.step(new Map([[local, select]]));
    expect(pawnOf(world, local).weapon).toBe('rocket');
    // Fire straight down at the floor: rocket jump.
    // Fire straight down at the floor: rocket jump. The salvo leaves on release (§5), so the
    // view stays pitched down while Fire goes up.
    const down: InputCommand = { ...NULL_INPUT, pitch: -1.5 };
    const fire: InputCommand = { ...down, buttons: Buttons.Fire };
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      for (const e of world.step(new Map([[local, i === 0 ? fire : down]]))) seen.add(e.type);
      expect(finite(pawnOf(world, local))).toBe(true);
    }
    expect(seen.has('shotFired')).toBe(true);
    expect(seen.has('explosion')).toBe(true);
    expect(seen.has('damage')).toBe(true);
    const p = pawnOf(world, local);
    expect(p.alive).toBe(true);
    expect(p.health).toBeLessThan(100);
    world.physics.dispose();
  });

  it('dummies move and the whole thing stays finite for a while', async () => {
    const world = await DemoWorld.create({ map: LAUNDRY_ROOM, seed: 9 });
    const ids = ['bot:1', 'bot:2', 'bot:3'].map((p) =>
      world.addPlayer(p, { name: p, isBot: true }),
    );
    const controllers = ids.map((id, i) => new DummyController({ pawnId: id, phase: i * 2 }));
    const start = new Map<number, { x: number; z: number }>();
    for (let tick = 0; tick < 600; tick++) {
      const state = world.getState();
      const inputs = new Map(controllers.map((c) => [c.pawnId, c.produce(tick, state)]));
      world.step(inputs);
      if (tick === 60) for (const id of ids) start.set(id, { ...pawnOf(world, id).position });
    }
    let moved = 0;
    for (const id of ids) {
      const p = pawnOf(world, id);
      expect(finite(p)).toBe(true);
      const s = start.get(id)!;
      if (Math.hypot(p.position.x - s.x, p.position.z - s.z) > 1) moved++;
    }
    expect(moved).toBeGreaterThan(0);
    world.physics.dispose();
  });
});
