/**
 * P13: projectiles (docs/DESIGN.md §5): rocket flight and splash falloff,
 * grenade bounce and fuse, direct hits, self-damage and knockback.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Buttons, TICK_RATE, type InputCommand, type PawnId, type SimEvent } from '../../types';
import { distanceToPawn } from './geometry';
import { LOB_GRAVITY, OWNER_SAFE_SECONDS } from './projectile';
import { splashFalloff } from './splash';
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
const ALT = input({ buttons: Buttons.AltFire });

/** Step projectiles from `from` until `until` (exclusive), collecting events. */
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

describe('rocket', () => {
  it('flies straight at 27 m/s and explodes on the wall', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'rocket' });

    system.tickPawn(shooter, FIRE, 0); // starts loading
    const fired = system.tickPawn(shooter, input(), 1); // release fires one
    const [rec] = system.projectilesOf(shooter.state.id);
    expect(rec).toBeDefined();
    expect(ofType(fired, 'shotFired')).toHaveLength(1);
    expect(rec!.state.velocity).toEqual({ x: 0, y: 0, z: -27 });
    expect(shooter.state.ammo.rocket).toBe(11);

    run(system, 2, 62);
    expect(rec!.state.position.z).toBeCloseTo(-0.3 - 27, 3);
    expect(rec!.state.position.y).toBeCloseTo(1.6, 6);

    const events = run(system, 62, 200);
    const [boom] = ofType(events, 'explosion');
    expect(boom).toMatchObject({ damageType: 'rocket', instigator: shooter.state.id, radius: 4.4 });
    expect(boom!.position.z).toBeCloseTo(-40 + 0.15, 1);
    expect(ofType(events, 'entityDestroyed')[0]?.id).toBe(rec!.state.id);
    expect(system.projectileStates()).toHaveLength(0);
  });

  it('splash damage falls off linearly to the edge, by capsule distance', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'rocket' });
    const near = host.addPawn({ feet: { x: 2, y: 0, z: -38 } });
    const far = host.addPawn({ feet: { x: -4, y: 0, z: -38 } });
    const outside = host.addPawn({ feet: { x: 8, y: 0, z: -38 } });

    system.tickPawn(shooter, FIRE, 0);
    system.tickPawn(shooter, input(), 1);
    const events = run(system, 2, 200);
    const [boom] = ofType(events, 'explosion');
    expect(boom).toBeDefined();

    const expected = (pawn: typeof near) =>
      Math.round(90 * splashFalloff(distanceToPawn(boom!.position, pawn.state), 4.4));
    expect(near.state.health).toBe(100 - expected(near));
    expect(far.state.health).toBe(100 - expected(far));
    expect(expected(near)).toBeGreaterThan(expected(far));
    expect(expected(far)).toBeGreaterThan(0);
    expect(outside.state.health).toBe(100);
    expect(shooter.state.health).toBe(100);

    const damage = ofType(events, 'damage');
    expect(damage.map((d) => d.target)).toEqual([near.state.id, far.state.id]);
    // Knockback points away from the blast.
    expect(near.state.velocity.x).toBeGreaterThan(0);
    expect(far.state.velocity.x).toBeLessThan(0);
  });

  it('a direct hit deals full damage plus knockback and no extra splash to the victim', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'rocket' });
    const target = host.addPawn({ feet: { x: 0, y: 0, z: -20 } });
    const bystander = host.addPawn({ feet: { x: 2.5, y: 0, z: -20 } });

    system.tickPawn(shooter, FIRE, 0);
    system.tickPawn(shooter, input(), 1);
    const events = run(system, 2, 100);

    expect(target.state.health).toBe(10);
    expect(target.state.velocity.z).toBeCloseTo(-10, 3);
    expect(bystander.state.health).toBeLessThan(100);
    expect(bystander.state.health).toBeGreaterThan(50);
    const damage = ofType(events, 'damage');
    expect(damage[0]).toMatchObject({ target: target.state.id, amount: 90 });
  });

  it('halves self splash but keeps the full momentum (rocket jump)', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'rocket', pitch: -Math.PI / 2 + 0.01 });

    system.tickPawn(shooter, FIRE, 0);
    system.tickPawn(shooter, input(), 1);
    const events = run(system, 2, 2 + Math.round(OWNER_SAFE_SECONDS * TICK_RATE) + 2);

    const [boom] = ofType(events, 'explosion');
    expect(boom).toBeDefined();
    const falloff = splashFalloff(distanceToPawn(boom!.position, shooter.state), 4.4);
    expect(shooter.state.health).toBe(100 - Math.round(90 * falloff * 0.5));
    const v = shooter.state.velocity;
    expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(10 * falloff, 3);
    expect(v.y).toBeGreaterThan(9 * falloff);
  });

  it('passes through the owner right after launch instead of hitting them directly', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'rocket', pitch: -Math.PI / 2 + 0.01 });
    system.tickPawn(shooter, FIRE, 0);
    system.tickPawn(shooter, input(), 1);
    const safeTicks = Math.round(OWNER_SAFE_SECONDS * TICK_RATE);
    const events = run(system, 2, 2 + safeTicks);
    // Straight down from the eye the sweep starts inside the shooter's own capsule;
    // the rocket must reach the floor and explode there, not detonate on the owner.
    const [boom] = ofType(events, 'explosion');
    expect(boom).toBeDefined();
    expect(boom!.position.y).toBeLessThan(0.2);
    expect(ofType(events, 'damage').every((d) => d.amount < 90)).toBe(true);
  });
});

describe('grenade', () => {
  it('arcs under gravity, bounces off the floor and detonates when the fuse runs out', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'assault' });

    const fired = system.tickPawn(shooter, ALT, 0);
    expect(ofType(fired, 'shotFired')[0]).toMatchObject({ mode: 'alt' });
    expect(shooter.state.ammo.assault).toBe(75);
    const [rec] = system.projectilesOf(shooter.state.id);
    expect(rec!.state.projectileType).toBe('grenade');
    expect(rec!.state.detonateAt).toBe(Math.round(2.5 * TICK_RATE));

    run(system, 1, 11);
    expect(rec!.state.velocity.y).toBeCloseTo(-LOB_GRAVITY * 10 * (1 / TICK_RATE), 6);
    expect(rec!.state.position.y).toBeLessThan(1.6);
    expect(rec!.bounces).toBe(0);

    let t = 11;
    while (rec!.bounces === 0 && t < 120) run(system, t, ++t);
    expect(rec!.bounces).toBe(1);
    expect(rec!.state.velocity.y).toBeGreaterThan(0);
    expect(rec!.state.velocity.z).toBeLessThan(0);
    expect(Math.abs(rec!.state.velocity.z)).toBeLessThan(22);
    expect(rec!.state.position.y).toBeGreaterThan(0.15 - 1e-6);

    const before = run(system, t, rec!.state.detonateAt);
    expect(ofType(before, 'explosion')).toHaveLength(0);
    const events = run(system, rec!.state.detonateAt, rec!.state.detonateAt + 1);
    const [boom] = ofType(events, 'explosion');
    expect(boom).toMatchObject({ damageType: 'grenade', radius: 3.5 });
    expect(boom!.position.y).toBeLessThan(2);
    expect(system.projectileStates()).toHaveLength(0);
  });

  it('comes to rest on the floor after a few bounces', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'assault', pitch: -0.9 });
    system.tickPawn(shooter, ALT, 0);
    const [rec] = system.projectilesOf(shooter.state.id);
    let t = 1;
    while (!rec!.state.landed && t < rec!.state.detonateAt) run(system, t, ++t);
    expect(rec!.state.landed).toBe(true);
    expect(rec!.bounces).toBeGreaterThan(1);
    expect(rec!.state.velocity).toEqual({ x: 0, y: 0, z: 0 });
    const y = rec!.state.position.y;
    run(system, t, t + 10);
    expect(rec!.state.position.y).toBe(y);
  });

  it('detonates on contact with a pawn', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'assault' });
    const target = host.addPawn({ feet: { x: 0, y: 0, z: -5 } });
    system.tickPawn(shooter, ALT, 0);
    const events = run(system, 1, 40);
    const [boom] = ofType(events, 'explosion');
    expect(boom).toBeDefined();
    expect(boom!.position.z).toBeGreaterThan(-5);
    expect(target.state.health).toBe(40);
    expect(ofType(events, 'damage')).toHaveLength(1);
    expect(system.projectileStates()).toHaveLength(0);
  });
});
