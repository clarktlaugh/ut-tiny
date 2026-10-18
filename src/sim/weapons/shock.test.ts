/**
 * P14: Super Shock Rifle (docs/DESIGN.md §5): instagib beam, 0.75 s rate, no ammo.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WEAPONS } from '../../data/weapons';
import { Buttons, PAWN_STATS, TICK_RATE, type InputCommand, type SimEvent } from '../types';
import { rateTicks, WeaponSystem } from './core';
import { TestHost, input } from './core/testing';
import { SHOCK_MODULE } from './shock';

const hosts: TestHost[] = [];

async function setup() {
  const host = await TestHost.create();
  hosts.push(host);
  return { host, system: new WeaponSystem(host, [SHOCK_MODULE]) };
}

afterEach(() => {
  while (hosts.length) hosts.pop()?.physics.dispose();
});

function ofType<T extends SimEvent['type']>(events: SimEvent[], type: T) {
  return events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);
}

const FIRE = input({ buttons: Buttons.Fire });
const ALT = input({ buttons: Buttons.AltFire });

describe('super shock rifle', () => {
  it('kills a pawn at full overheal and shield in one shot', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'shock' });
    const target = host.addPawn({ feet: { x: 0, y: 0, z: -30 } });
    target.state.health = PAWN_STATS.healthMax;
    target.state.shield = PAWN_STATS.shieldMax;

    const events = system.tickPawn(shooter, FIRE, 10);

    expect(target.state.alive).toBe(false);
    const [beam] = ofType(events, 'hitscan');
    expect(beam).toMatchObject({
      pawn: shooter.state.id,
      weapon: 'shock',
      hitPawn: target.state.id,
    });
    expect(ofType(events, 'death')[0]).toMatchObject({
      victim: target.state.id,
      killer: shooter.state.id,
      weapon: 'shock',
    });
  });

  it('alt fire is the same instagib beam', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'shock' });
    const target = host.addPawn({ feet: { x: 0, y: 0, z: -20 } });

    const events = system.tickPawn(shooter, ALT, 10);

    expect(ofType(events, 'shotFired')[0]).toMatchObject({ weapon: 'shock', mode: 'alt' });
    expect(ofType(events, 'hitscan')[0]?.hitPawn).toBe(target.state.id);
    expect(target.state.alive).toBe(false);
  });

  it('fires every 0.75 s, shared by both buttons, and never uses ammo', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'shock' });
    const period = rateTicks(WEAPONS.shock.primary);
    expect(period).toBe(0.75 * TICK_RATE);

    const shots: number[] = [];
    for (let t = 0; t < 3 * TICK_RATE; t++) {
      // Alternate the held button every tick: the cooldown is shared.
      const cmd: InputCommand = t % 2 === 0 ? FIRE : ALT;
      if (ofType(system.tickPawn(shooter, cmd, t), 'shotFired').length) shots.push(t);
    }
    expect(shots).toEqual([0, 45, 90, 135]);
    expect(shooter.state.ammo.shock).toBeUndefined();
    expect(shooter.state.weapon).toBe('shock');
  });

  it('beam stops at a wall; spawn protection still saves the target', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'shock' });
    const hidden = host.addPawn({ feet: { x: 0, y: 0, z: -50 } });
    const protectedPawn = host.addPawn({ feet: { x: 30, y: 0, z: 0 } });
    protectedPawn.state.spawnProtectedUntil = 1000;

    system.tickPawn(shooter, FIRE, 10);
    expect(hidden.state.alive).toBe(true);

    shooter.state.yaw = -Math.PI / 2; // face +x
    system.tickPawn(shooter, FIRE, 100);
    expect(protectedPawn.state.alive).toBe(true);
    expect(protectedPawn.state.health).toBe(100);
  });
});
