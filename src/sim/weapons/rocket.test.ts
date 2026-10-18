/**
 * P14: Rocket Launcher (docs/DESIGN.md §5): 27 m/s rockets for 90, hold to load
 * three, primary fans them horizontally, alt spirals them tightly, tapping alt
 * while loading primary switches the load to bouncing 2.5 s grenades.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WEAPONS } from '../../data/weapons';
import { Buttons, TICK_RATE, type InputCommand, type PawnId, type SimEvent } from '../types';
import { anglesFromDirection, loadTicks, rateTicks, WeaponSystem } from './core';
import { dot } from './core/math';
import { TestHost, input } from './core/testing';
import { GRENADE_FUSE, GRENADE_MODE_KEY, ROCKET_MODULE, SPIRAL_ANGLE } from './rocket';

const hosts: TestHost[] = [];

async function setup() {
  const host = await TestHost.create();
  hosts.push(host);
  return { host, system: new WeaponSystem(host, [ROCKET_MODULE]) };
}

afterEach(() => {
  while (hosts.length) hosts.pop()?.physics.dispose();
});

function ofType<T extends SimEvent['type']>(events: SimEvent[], type: T) {
  return events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);
}

const NONE = input();
const FIRE = input({ buttons: Buttons.Fire });
const ALT = input({ buttons: Buttons.AltFire });
const BOTH = input({ buttons: Buttons.Fire | Buttons.AltFire });

function run(
  system: WeaponSystem,
  from: number,
  until: number,
  inputs = new Map<PawnId, InputCommand>(),
) {
  const events: SimEvent[] = [];
  for (let t = from; t < until; t++) events.push(...system.step(t, inputs));
  return events;
}

/** Hold `cmd` from tick `from` until the weapon has loaded `count`, then release. */
function loadAndRelease(
  system: WeaponSystem,
  rec: Parameters<WeaponSystem['tickPawn']>[0],
  cmd: InputCommand,
  count: number,
  from = 0,
): { events: SimEvent[]; releaseTick: number } {
  const step = loadTicks(WEAPONS.rocket.primary);
  const holdUntil = from + (count - 1) * step + 1;
  for (let t = from; t < holdUntil; t++) system.tickPawn(rec, cmd, t);
  return { events: system.tickPawn(rec, NONE, holdUntil), releaseTick: holdUntil };
}

describe('rocket launcher primary', () => {
  it('a tap fires one 27 m/s rocket that deals 90 on a direct hit', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'rocket' });
    const target = host.addPawn({ feet: { x: 0, y: 0, z: -15 } });

    const { events: fired } = loadAndRelease(system, shooter, FIRE, 1);
    expect(ofType(fired, 'shotFired')).toHaveLength(1);
    const [rec] = system.projectilesOf(shooter.state.id);
    expect(rec!.state.velocity).toEqual({ x: 0, y: 0, z: -27 });
    expect(rec!.state.projectileType).toBe('rocket');
    expect(shooter.state.ammo.rocket).toBe(11);

    const events = run(system, 2, 60);
    expect(ofType(events, 'damage')[0]).toMatchObject({
      target: target.state.id,
      amount: 90,
      damageType: 'rocket',
    });
    expect(target.state.health).toBe(10);
  });

  it('loads one rocket per load time up to three, paying ammo as each loads', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'rocket' });
    const step = loadTicks(WEAPONS.rocket.primary);

    system.tickPawn(shooter, FIRE, 0);
    expect(system.stateFor(shooter.state.id).loading?.count).toBe(1);
    for (let t = 1; t <= step; t++) system.tickPawn(shooter, FIRE, t);
    expect(system.stateFor(shooter.state.id).loading?.count).toBe(2);
    for (let t = step + 1; t <= 4 * step; t++) system.tickPawn(shooter, FIRE, t);
    expect(system.stateFor(shooter.state.id).loading?.count).toBe(3);
    expect(shooter.state.ammo.rocket).toBe(9);

    const fired = system.tickPawn(shooter, NONE, 4 * step + 1);
    expect(ofType(fired, 'shotFired')).toHaveLength(3);
  });

  it('a load of three leaves as a level horizontal fan', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'rocket', yaw: 0.4, pitch: 0.1 });

    const { events } = loadAndRelease(system, shooter, FIRE, 3);
    const shots = ofType(events, 'shotFired');
    expect(shots).toHaveLength(3);
    const angles = shots.map((s) => anglesFromDirection(s.direction));
    const step = WEAPONS.rocket.primary.spread!;
    // Fan in yaw, centered on the aim; pitch only drifts by the tiny cone curvature.
    expect(angles[1]!.yaw).toBeCloseTo(0.4, 6);
    const left = angles[0]!.yaw - angles[1]!.yaw;
    const right = angles[2]!.yaw - angles[1]!.yaw;
    expect(Math.abs(left)).toBeCloseTo(step / Math.cos(0.1), 3);
    expect(right).toBeCloseTo(-left, 6);
    for (const a of angles) expect(a.pitch).toBeCloseTo(0.1, 2);

    const rockets = system.projectilesOf(shooter.state.id);
    expect(rockets).toHaveLength(3);
    for (const r of rockets)
      expect(Math.hypot(r.state.velocity.x, r.state.velocity.y, r.state.velocity.z)).toBeCloseTo(
        27,
        6,
      );
  });

  it('waits the rate after a salvo before loading again', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'rocket' });
    const { releaseTick } = loadAndRelease(system, shooter, FIRE, 1);
    const ready = releaseTick + rateTicks(WEAPONS.rocket.primary);
    for (let t = releaseTick + 1; t < ready; t++) {
      system.tickPawn(shooter, FIRE, t);
      expect(system.stateFor(shooter.state.id).loading).toBeNull();
    }
    system.tickPawn(shooter, FIRE, ready);
    expect(system.stateFor(shooter.state.id).loading?.count).toBe(1);
  });
});

describe('rocket launcher alt', () => {
  it('a load of three leaves as a tight spiral around the aim', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'rocket' });
    const aim = { x: 0, y: 0, z: -1 };

    const { events } = loadAndRelease(system, shooter, ALT, 3);
    const shots = ofType(events, 'shotFired');
    expect(shots).toHaveLength(3);
    expect(shots.every((s) => s.mode === 'alt')).toBe(true);
    for (const s of shots) {
      expect(Math.acos(Math.min(1, dot(s.direction, aim)))).toBeCloseTo(SPIRAL_ANGLE, 6);
    }
    // First on top, the others below and either side: not a horizontal fan.
    const [a, b, c] = shots.map((s) => s.direction);
    expect(a!.y).toBeGreaterThan(0);
    expect(b!.y).toBeLessThan(0);
    expect(c!.y).toBeLessThan(0);
    expect(Math.sign(b!.x)).toBe(-Math.sign(c!.x));
    // Much tighter than the primary fan.
    expect(SPIRAL_ANGLE).toBeLessThan(WEAPONS.rocket.primary.spread!);
    expect(system.projectilesOf(shooter.state.id).every((r) => r.motion === 'straight')).toBe(true);
  });
});

describe('rocket launcher grenade mode', () => {
  it('tapping alt while loading primary fires the load as bouncing grenades with a 2.5 s fuse', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'rocket', pitch: 0.2 });
    const step = loadTicks(WEAPONS.rocket.primary);

    system.tickPawn(shooter, FIRE, 0);
    system.tickPawn(shooter, BOTH, 1); // tap alt
    expect(system.stateFor(shooter.state.id).custom[GRENADE_MODE_KEY]).toBe(1);
    for (let t = 2; t <= 2 * step; t++) system.tickPawn(shooter, FIRE, t);
    const release = 2 * step + 1;
    const fired = system.tickPawn(shooter, NONE, release);
    expect(ofType(fired, 'shotFired')).toHaveLength(3);

    const grenades = system.projectilesOf(shooter.state.id);
    expect(grenades).toHaveLength(3);
    const fuse = Math.round(GRENADE_FUSE * TICK_RATE);
    for (const g of grenades) {
      expect(g.motion).toBe('lob');
      expect(g.state.detonateAt).toBe(release + fuse);
    }

    const early = run(system, release + 1, release + fuse);
    expect(ofType(early, 'explosion')).toHaveLength(0);
    expect(grenades.every((g) => g.bounces > 0)).toBe(true);
    const events = run(system, release + fuse, release + fuse + 1);
    const booms = ofType(events, 'explosion');
    expect(booms).toHaveLength(3);
    for (const b of booms) expect(b).toMatchObject({ damageType: 'rocket', radius: 4.4 });

    // The next load starts as rockets again.
    const later = release + rateTicks(WEAPONS.rocket.primary);
    system.tickPawn(shooter, FIRE, later);
    expect(system.stateFor(shooter.state.id).custom[GRENADE_MODE_KEY]).toBe(0);
    system.tickPawn(shooter, NONE, later + 1);
    const [next] = system.projectilesOf(shooter.state.id);
    expect(next!.motion).toBe('straight');
  });

  it('a second alt tap toggles back to rockets', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'rocket' });
    system.tickPawn(shooter, FIRE, 0);
    system.tickPawn(shooter, BOTH, 1);
    system.tickPawn(shooter, FIRE, 2);
    system.tickPawn(shooter, BOTH, 3);
    expect(system.stateFor(shooter.state.id).custom[GRENADE_MODE_KEY]).toBe(0);
    system.tickPawn(shooter, NONE, 4);
    const [rec] = system.projectilesOf(shooter.state.id);
    expect(rec!.motion).toBe('straight');
  });

  it('a grenade-mode rocket detonates on contact with a pawn for 90', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'rocket' });
    const target = host.addPawn({ feet: { x: 0, y: 0, z: -6 } });
    system.tickPawn(shooter, FIRE, 0);
    system.tickPawn(shooter, BOTH, 1);
    system.tickPawn(shooter, NONE, 2);
    const events = run(system, 3, 60);
    expect(ofType(events, 'explosion')).toHaveLength(1);
    expect(ofType(events, 'damage')[0]).toMatchObject({ target: target.state.id, amount: 90 });
  });
});
