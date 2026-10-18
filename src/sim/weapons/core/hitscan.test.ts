/**
 * P13: hitscan behavior (docs/DESIGN.md §5).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Buttons, NO_ENTITY, type SimEvent } from '../../types';
import { HITSCAN_RANGE } from './hitscan';
import { TestHost, input } from './testing';
import { WeaponSystem } from './weaponSystem';

const hosts: TestHost[] = [];

async function setup() {
  const host = await TestHost.create();
  hosts.push(host);
  return { host, system: new WeaponSystem(host) };
}

afterEach(() => {
  while (hosts.length) hosts.pop()?.physics.dispose();
});

function ofType<T extends SimEvent['type']>(events: SimEvent[], type: T) {
  return events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);
}

const FIRE = input({ buttons: Buttons.Fire });

describe('hitscan', () => {
  it('hits a pawn 30 m away for the assault rifle damage and reports the trace', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'assault' });
    const target = host.addPawn({ feet: { x: 0, y: 0, z: -30 } });

    const events = system.tickPawn(shooter, FIRE, 10);

    expect(target.state.health).toBe(93);
    const [shot] = ofType(events, 'shotFired');
    expect(shot).toMatchObject({ pawn: shooter.state.id, weapon: 'assault', mode: 'primary' });
    expect(shot?.origin).toEqual({ x: 0, y: 1.6, z: 0 });
    const [trace] = ofType(events, 'hitscan');
    expect(trace?.hitPawn).toBe(target.state.id);
    expect(trace?.headshot).toBe(false);
    // The eye-height ray meets the top hemisphere of the capsule (center y 0.9, segment ±0.5).
    expect(trace?.to.z).toBeCloseTo(-30 + Math.sqrt(0.4 ** 2 - 0.2 ** 2), 3);
    expect(ofType(events, 'damage')[0]).toMatchObject({ amount: 7, damageType: 'bullet' });
    expect(shooter.state.ammo.assault).toBe(99);
  });

  it('stops at a wall in front of the target', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'assault' });
    const target = host.addPawn({ feet: { x: 0, y: 0, z: -50 } });

    const events = system.tickPawn(shooter, FIRE, 10);

    expect(target.state.health).toBe(100);
    const [trace] = ofType(events, 'hitscan');
    expect(trace?.hitPawn).toBe(NO_ENTITY);
    expect(trace?.to.z).toBeCloseTo(-40, 3);
  });

  it('misses beyond the trace range', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'sniper', feet: { x: 0, y: 0, z: 90 }, pitch: 0.2 });
    const events = system.tickPawn(shooter, FIRE, 10);
    const [trace] = ofType(events, 'hitscan');
    expect(trace?.hitPawn).toBe(NO_ENTITY);
    const len = Math.hypot(trace!.to.x - 0, trace!.to.y - 1.6, trace!.to.z - 90);
    expect(len).toBeCloseTo(HITSCAN_RANGE, 3);
  });

  it('sniper: body shot 70, headshot 140', async () => {
    const { host, system } = await setup();
    const body = host.addPawn({ weapon: 'sniper', pitch: -Math.atan2(0.8, 30) });
    const target = host.addPawn({ feet: { x: 0, y: 0, z: -30 } });

    let events = system.tickPawn(body, FIRE, 10);
    expect(ofType(events, 'hitscan')[0]?.headshot).toBe(false);
    expect(target.state.health).toBe(30);

    const head = host.addPawn({ weapon: 'sniper', feet: { x: 1, y: 0, z: 0 } });
    host.movePawn(head.state.id, { x: 1, y: 0.9, z: 0 });
    head.state.yaw = Math.atan2(1, 30); // aim at x = 0, z = −30
    target.state.health = 199;
    events = system.tickPawn(head, FIRE, 20);
    expect(ofType(events, 'hitscan')[0]?.headshot).toBe(true);
    expect(target.state.health).toBe(59);
  });

  it('shoots down a warhead in flight and fizzles instead of detonating', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'sniper' });
    const launcher = host.addPawn({
      weapon: 'redeemer',
      feet: { x: 0, y: 0, z: -40 + 2 },
      yaw: Math.PI,
    });
    launcher.state.yaw = Math.PI; // faces +Z, toward the shooter
    const warhead = system.spawnProjectile(
      {
        owner: launcher.state.id,
        weapon: 'redeemer',
        mode: 'primary',
        def: host.weapons.redeemer.primary,
        projectileType: 'redeemer',
        motion: 'straight',
        position: { x: 0, y: 1.6, z: -20 },
        velocity: { x: 0, y: 0, z: 20 },
        hitRadius: 0.6,
      },
      5,
      [],
    );
    expect(warhead.state.health).toBe(50);

    const events = system.tickPawn(shooter, FIRE, 10);
    expect(ofType(events, 'hitscan')[0]?.hitPawn).toBe(NO_ENTITY);
    expect(ofType(events, 'projectileDestroyed')[0]).toMatchObject({
      id: warhead.state.id,
      byPawn: shooter.state.id,
    });
    const [boom] = ofType(events, 'explosion');
    expect(boom?.radius).toBe(4);
    expect(system.projectile(warhead.state.id)).toBeUndefined();
    expect(launcher.state.health).toBe(100);
  });

  it('an enemy hit disrupts a disc; the owner cannot', async () => {
    const { host, system } = await setup();
    const owner = host.addPawn({ weapon: 'assault' });
    const enemy = host.addPawn({
      weapon: 'assault',
      feet: { x: 3, y: 0, z: 0 },
      yaw: Math.atan2(3, 20),
    });
    const disc = system.spawnProjectile(
      {
        owner: owner.state.id,
        weapon: 'teleporter',
        mode: 'primary',
        def: host.weapons.teleporter.primary,
        projectileType: 'disc',
        motion: 'lob',
        position: { x: 0, y: 1.6, z: -20 },
        velocity: { x: 0, y: 0, z: 0 },
        hitRadius: 0.4,
      },
      0,
      [],
    );
    owner.state.disc = disc.state.id;

    system.tickPawn(owner, FIRE, 10);
    expect(disc.state.disrupted).toBe(false);

    const events = system.tickPawn(enemy, FIRE, 11);
    expect(disc.state.disrupted).toBe(true);
    expect(ofType(events, 'discDisrupted')[0]).toMatchObject({
      disc: disc.state.id,
      byPawn: enemy.state.id,
    });
  });
});
