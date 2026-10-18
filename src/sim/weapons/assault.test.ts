/**
 * P14: Assault Rifle (docs/DESIGN.md §5): 7-damage bullets at 10/s with
 * growing spread; grenades lobbed for 60 in 3.5 m, 2.5 s fuse, 25 bullets each.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { GRENADE_BULLET_COST, WEAPONS } from '../../data/weapons';
import { Buttons, TICK_RATE, type InputCommand, type PawnId, type SimEvent } from '../types';
import { WeaponSystem } from './core';
import { dot } from './core/math';
import { TestHost, input } from './core/testing';
import { ASSAULT_MODULE } from './assault';

const hosts: TestHost[] = [];

async function setup() {
  const host = await TestHost.create();
  hosts.push(host);
  return { host, system: new WeaponSystem(host, [ASSAULT_MODULE]) };
}

afterEach(() => {
  while (hosts.length) hosts.pop()?.physics.dispose();
});

function ofType<T extends SimEvent['type']>(events: SimEvent[], type: T) {
  return events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);
}

const FIRE = input({ buttons: Buttons.Fire });
const ALT = input({ buttons: Buttons.AltFire });

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

describe('assault rifle primary', () => {
  it('fires 10 bullets per second while held, one bullet of ammo each', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'assault' });

    const shots: number[] = [];
    for (let t = 0; t < TICK_RATE; t++) {
      if (ofType(system.tickPawn(shooter, FIRE, t), 'shotFired').length) shots.push(t);
    }
    expect(shots).toEqual([0, 6, 12, 18, 24, 30, 36, 42, 48, 54]);
    expect(shooter.state.ammo.assault).toBe(WEAPONS.assault.ammo!.start - 10);
  });

  it('deals 7 damage per bullet', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'assault' });
    const target = host.addPawn({ feet: { x: 0, y: 0, z: -10 } });

    // Tap: the first shot after a pause is exact.
    for (let i = 0; i < 3; i++) {
      const t = i * TICK_RATE;
      const events = system.tickPawn(shooter, FIRE, t);
      system.tickPawn(shooter, input(), t + 1);
      expect(ofType(events, 'damage')[0]).toMatchObject({ amount: 7, damageType: 'bullet' });
    }
    expect(target.state.health).toBe(100 - 21);
  });

  it('first shot is exact; spread grows under sustained fire and recovers after a pause', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'assault' });
    const aim = { x: 0, y: 0, z: -1 };
    const maxSpread = WEAPONS.assault.primary.spread!;

    const deviations: number[] = [];
    for (let t = 0; t < 60; t++) {
      for (const shot of ofType(system.tickPawn(shooter, FIRE, t), 'shotFired')) {
        deviations.push(Math.acos(Math.min(1, dot(shot.direction, aim))));
      }
    }
    expect(deviations[0]).toBe(0);
    for (const d of deviations) expect(d).toBeLessThanOrEqual(maxSpread + 1e-9);
    // Once the heat is up, shots use most of the cone.
    expect(Math.max(...deviations.slice(4))).toBeGreaterThan(maxSpread / 2);

    // Release for a second: the next shot is exact again.
    for (let t = 60; t < 120; t++) system.tickPawn(shooter, input(), t);
    const [next] = ofType(system.tickPawn(shooter, FIRE, 120), 'shotFired');
    expect(next?.direction).toEqual(aim);
  });

  it('switches away when the bullets run out', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'assault' });
    shooter.state.ammo.assault = 1;
    const events = system.tickPawn(shooter, FIRE, 0);
    expect(ofType(events, 'shotFired')).toHaveLength(1);
    expect(shooter.state.ammo.assault).toBe(0);
    expect(shooter.state.pendingWeapon).not.toBe('assault');
  });
});

describe('assault rifle grenade', () => {
  it('costs 25 bullets, fires every 0.6 s, and needs a full grenade of ammo', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'assault' });

    const shots: number[] = [];
    for (let t = 0; t < 2 * TICK_RATE; t++) {
      if (ofType(system.tickPawn(shooter, ALT, t), 'shotFired').length) shots.push(t);
    }
    expect(shots).toEqual([0, 36, 72, 108]);
    expect(shooter.state.ammo.assault).toBe(100 - 4 * GRENADE_BULLET_COST);

    const other = host.addPawn({ weapon: 'assault' });
    other.state.ammo.assault = GRENADE_BULLET_COST - 1;
    expect(ofType(system.tickPawn(other, ALT, 0), 'shotFired')).toHaveLength(0);
    expect(other.state.ammo.assault).toBe(GRENADE_BULLET_COST - 1);
  });

  it('is lobbed, bounces and detonates after 2.5 s for 60 in 3.5 m', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'assault', pitch: 0.3 });
    system.tickPawn(shooter, ALT, 0);
    const [rec] = system.projectilesOf(shooter.state.id);
    expect(rec).toMatchObject({ motion: 'lob' });
    expect(rec!.state.projectileType).toBe('grenade');
    const fuse = Math.round(2.5 * TICK_RATE);
    expect(rec!.state.detonateAt).toBe(fuse);

    const early = run(system, 1, fuse);
    expect(ofType(early, 'explosion')).toHaveLength(0);
    expect(rec!.bounces).toBeGreaterThan(0);

    // Stand someone right where it is about to go off.
    const at = rec!.state.position;
    const victim = host.addPawn({ feet: { x: at.x + 1, y: 0, z: at.z } });
    const events = run(system, fuse, fuse + 1);
    const [boom] = ofType(events, 'explosion');
    expect(boom).toMatchObject({ damageType: 'grenade', radius: 3.5 });
    expect(victim.state.health).toBeLessThan(100);
    expect(victim.state.health).toBeGreaterThan(40);
  });

  it('detonates on contact with a pawn for the full 60', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'assault' });
    const target = host.addPawn({ feet: { x: 0, y: 0, z: -6 } });
    system.tickPawn(shooter, ALT, 0);
    const events = run(system, 1, 60);
    expect(ofType(events, 'explosion')).toHaveLength(1);
    expect(ofType(events, 'damage')[0]).toMatchObject({
      target: target.state.id,
      amount: 60,
      damageType: 'grenade',
    });
    expect(target.state.health).toBe(40);
  });
});
