/**
 * P13: fire control and the weapon system (docs/DESIGN.md §5, §5.1):
 * rate of fire, ammo and empty switching, loading salvos, spread heat,
 * weapon modules, guided projectiles, pawn lifecycle.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  Buttons,
  NO_ENTITY,
  TICK_RATE,
  type InputCommand,
  type PawnId,
  type SimEvent,
} from '../../types';
import { HEAT_PER_SHOT, rateTicks } from './fireControl';
import type { WeaponModule } from './host';
import { anglesFromDirection, directionFromAngles } from './math';
import { GUIDE_YAW_RATE } from './projectile';
import { TestHost, input } from './testing';
import { WeaponSystem } from './weaponSystem';

const hosts: TestHost[] = [];

async function setup(modules: WeaponModule[] = []) {
  const host = await TestHost.create();
  hosts.push(host);
  return { host, system: new WeaponSystem(host, modules) };
}

afterEach(() => {
  while (hosts.length) hosts.pop()?.physics.dispose();
});

function ofType<T extends SimEvent['type']>(events: SimEvent[], type: T) {
  return events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);
}

const FIRE = input({ buttons: Buttons.Fire });
const ALT = input({ buttons: Buttons.AltFire });

describe('rate and ammo', () => {
  it('fires the assault rifle every 6 ticks while held, not faster', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'assault' });
    const shotTicks: number[] = [];
    for (let t = 0; t < 30; t++) {
      if (ofType(system.tickPawn(shooter, FIRE, t), 'shotFired').length) shotTicks.push(t);
    }
    expect(shotTicks).toEqual([0, 6, 12, 18, 24]);
    expect(shooter.state.ammo.assault).toBe(95);
  });

  it('primary wins when both buttons are held, and the cooldown is shared', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'assault' });
    const both = input({ buttons: Buttons.Fire | Buttons.AltFire });
    expect(ofType(system.tickPawn(shooter, both, 0), 'shotFired')[0]?.mode).toBe('primary');
    expect(ofType(system.tickPawn(shooter, ALT, 1), 'shotFired')).toHaveLength(0);
    expect(ofType(system.tickPawn(shooter, ALT, 6), 'shotFired')[0]?.mode).toBe('alt');
  });

  it('does not fire without ammo and switches to the best weapon when a shot empties it', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'sniper' });
    shooter.state.ammo.sniper = 1;
    const events = system.tickPawn(shooter, FIRE, 0);
    expect(ofType(events, 'shotFired')).toHaveLength(1);
    expect(shooter.state.ammo.sniper).toBe(0);
    expect(shooter.state.pendingWeapon).toBe('assault');

    shooter.state.pendingWeapon = null;
    shooter.state.weapon = 'sniper';
    const again = system.tickPawn(shooter, FIRE, rateTicks(host.weapons.sniper.primary) + 1);
    expect(ofType(again, 'shotFired')).toHaveLength(0);
  });

  it('does not fire while dead or mid-switch', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'assault' });
    shooter.state.pendingWeapon = 'teleporter';
    expect(ofType(system.tickPawn(shooter, FIRE, 0), 'shotFired')).toHaveLength(0);
    shooter.state.pendingWeapon = null;
    shooter.state.alive = false;
    expect(ofType(system.tickPawn(shooter, FIRE, 1), 'shotFired')).toHaveLength(0);
  });

  it('infinite-ammo weapons fire for free', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'shock' });
    expect(ofType(system.tickPawn(shooter, FIRE, 0), 'shotFired')).toHaveLength(1);
    expect(shooter.state.ammo.shock).toBeUndefined();
    expect(ofType(system.tickPawn(shooter, FIRE, 45), 'shotFired')).toHaveLength(1);
  });
});

describe('spread heat', () => {
  it('first shot is exact, sustained fire opens the cone, a pause closes it', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'assault' });
    const aim = directionFromAngles(0, 0);
    const angleOf = (e: SimEvent) =>
      e.type === 'shotFired'
        ? Math.acos(e.direction.x * aim.x + e.direction.y * aim.y + e.direction.z * aim.z)
        : NaN;

    const first = ofType(system.tickPawn(shooter, FIRE, 0), 'shotFired')[0]!;
    expect(angleOf(first)).toBeCloseTo(0, 9);
    expect(system.stateFor(shooter.state.id).heat).toBeCloseTo(HEAT_PER_SHOT, 6);

    let maxAngle = 0;
    for (let t = 1; t < 60; t++) {
      for (const e of ofType(system.tickPawn(shooter, FIRE, t), 'shotFired')) {
        maxAngle = Math.max(maxAngle, angleOf(e));
      }
    }
    expect(maxAngle).toBeGreaterThan(0);
    expect(maxAngle).toBeLessThanOrEqual(0.05 + 1e-9);

    for (let t = 60; t < 120; t++) system.tickPawn(shooter, input(), t);
    expect(system.stateFor(shooter.state.id).heat).toBe(0);
    const rested = ofType(system.tickPawn(shooter, FIRE, 120), 'shotFired')[0]!;
    expect(angleOf(rested)).toBeCloseTo(0, 9);
  });
});

describe('loading (rocket launcher)', () => {
  it('loads up to three while held and fires a horizontal fan on release', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'rocket' });
    const loadTicks = Math.round(0.95 * TICK_RATE);

    system.tickPawn(shooter, FIRE, 0);
    expect(system.stateFor(shooter.state.id).loading).toMatchObject({ mode: 'primary', count: 1 });
    expect(shooter.state.ammo.rocket).toBe(11);
    for (let t = 1; t < loadTicks * 3; t++) system.tickPawn(shooter, FIRE, t);
    expect(system.stateFor(shooter.state.id).loading?.count).toBe(3);
    expect(shooter.state.ammo.rocket).toBe(9);

    const t = loadTicks * 3;
    const events = system.tickPawn(shooter, input(), t);
    const shots = ofType(events, 'shotFired');
    expect(shots).toHaveLength(3);
    const yaws = shots.map((s) => anglesFromDirection(s.direction).yaw);
    expect(yaws[1]).toBeCloseTo(0, 9);
    expect(yaws[0]! - yaws[1]!).toBeCloseTo(0.06, 6);
    expect(yaws[1]! - yaws[2]!).toBeCloseTo(0.06, 6);
    expect(shots.every((s) => Math.abs(s.direction.y) < 1e-9)).toBe(true);
    expect(system.projectilesOf(shooter.state.id)).toHaveLength(3);
    expect(system.stateFor(shooter.state.id).loading).toBeNull();
    expect(system.stateFor(shooter.state.id).nextFireTick).toBe(
      t + rateTicks(host.weapons.rocket.primary),
    );
  });

  it('a tap fires one rocket; a pending switch releases what is loaded', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'rocket' });
    system.tickPawn(shooter, FIRE, 0);
    expect(ofType(system.tickPawn(shooter, input(), 1), 'shotFired')).toHaveLength(1);

    const t0 = 200;
    system.tickPawn(shooter, FIRE, t0);
    shooter.state.pendingWeapon = 'assault';
    const events = system.tickPawn(shooter, FIRE, t0 + 1);
    expect(ofType(events, 'shotFired')).toHaveLength(1);
    expect(system.stateFor(shooter.state.id).loading).toBeNull();
  });

  it('stops loading when the ammo runs out', async () => {
    const { host, system } = await setup();
    const shooter = host.addPawn({ weapon: 'rocket' });
    shooter.state.ammo.rocket = 2;
    for (let t = 0; t < 200; t++) system.tickPawn(shooter, FIRE, t);
    expect(system.stateFor(shooter.state.id).loading?.count).toBe(2);
    expect(shooter.state.ammo.rocket).toBe(0);
    expect(ofType(system.tickPawn(shooter, input(), 200), 'shotFired')).toHaveLength(2);
  });
});

describe('weapon modules', () => {
  it('action modes do nothing without a module and run the module hook with one', async () => {
    const calls: string[] = [];
    const module: WeaponModule = {
      id: 'sniper',
      fire: {
        alt: (ctx) => {
          calls.push(`alt@${ctx.tick}`);
          ctx.shooter.zoom = 4;
        },
      },
      update: (ctx) => {
        if (ctx.pressed.alt) calls.push(`pressed@${ctx.tick}`);
        ctx.state.custom.ticks = (ctx.state.custom.ticks ?? 0) + 1;
      },
    };
    const bare = await setup();
    const plain = bare.host.addPawn({ weapon: 'sniper' });
    expect(bare.system.tickPawn(plain, ALT, 0)).toEqual([]);
    expect(plain.state.zoom).toBe(1);

    const { host, system } = await setup([module]);
    const shooter = host.addPawn({ weapon: 'sniper' });
    system.tickPawn(shooter, ALT, 0);
    system.tickPawn(shooter, ALT, 1);
    expect(shooter.state.zoom).toBe(4);
    expect(calls).toEqual(['pressed@0', 'alt@0', 'alt@1']);
    expect(system.stateFor(shooter.state.id).custom.ticks).toBe(2);
    expect(shooter.state.ammo.sniper).toBe(20);
  });

  it('a module can replace a generic behavior and shape the salvo', async () => {
    const module: WeaponModule = {
      id: 'rocket',
      fire: {
        alt: (ctx) =>
          ctx.events.push({
            type: 'footstep',
            tick: ctx.tick,
            pawn: ctx.shooter.id,
            position: ctx.origin,
          }),
      },
      salvoDirection: (ctx) => directionFromAngles(0, (ctx.index + 1) * 0.1),
    };
    const { host, system } = await setup([module]);
    const shooter = host.addPawn({ weapon: 'rocket' });
    for (let t = 0; t < 200; t++) system.tickPawn(shooter, ALT, t);
    const events = system.tickPawn(shooter, input(), 200);
    expect(ofType(events, 'footstep')).toHaveLength(3);
    const pitches = ofType(events, 'shotFired').map((s) => anglesFromDirection(s.direction).pitch);
    expect(pitches.map((p) => Math.round(p * 10))).toEqual([1, 2, 3]);
    expect(system.projectilesOf(shooter.state.id)).toHaveLength(0);
  });

  it('onImpact and onProjectileRemoved hooks see every projectile of the weapon', async () => {
    const removed: string[] = [];
    const module: WeaponModule = {
      id: 'assault',
      onImpact: () => 'destroy',
      onProjectileRemoved: (rec, reason) => removed.push(`${rec.state.projectileType}:${reason}`),
    };
    const { host, system } = await setup([module]);
    const shooter = host.addPawn({ weapon: 'assault', pitch: -0.5 });
    system.tickPawn(shooter, ALT, 0);
    const events: SimEvent[] = [];
    for (let t = 1; t < 60; t++) events.push(...system.step(t, new Map()));
    expect(removed).toEqual(['grenade:destroyed']);
    expect(ofType(events, 'explosion')).toHaveLength(0);
    expect(ofType(events, 'entityDestroyed')).toHaveLength(1);
  });
});

describe('guided projectile (§5.1)', () => {
  function launchGuided(host: TestHost, system: WeaponSystem, owner: PawnId, events: SimEvent[]) {
    return system.spawnProjectile(
      {
        owner,
        weapon: 'redeemer',
        mode: 'alt',
        def: host.weapons.redeemer.alt,
        projectileType: 'redeemer',
        motion: 'straight',
        position: { x: 0, y: 30, z: 0 },
        velocity: { x: 0, y: 0, z: -20 },
        guided: true,
      },
      0,
      events,
    );
  }

  it('starts guidance, turns toward the owner view within the rate limit, and Fire detonates', async () => {
    const { host, system } = await setup();
    const owner = host.addPawn({ weapon: 'redeemer' });
    const spawnEvents: SimEvent[] = [];
    const warhead = launchGuided(host, system, owner.state.id, spawnEvents);
    expect(owner.state.guiding).toBe(warhead.state.id);
    expect(ofType(spawnEvents, 'guidanceStarted')).toHaveLength(1);

    const inputs = new Map<PawnId, InputCommand>([[owner.state.id, input({ yaw: 1.0 })]]);
    system.step(1, inputs);
    const after1 = anglesFromDirection(warhead.state.velocity);
    expect(after1.yaw).toBeCloseTo(GUIDE_YAW_RATE / TICK_RATE, 9);
    for (let t = 2; t < 70; t++) system.step(t, inputs);
    expect(anglesFromDirection(warhead.state.velocity).yaw).toBeCloseTo(1.0, 6);
    expect(Math.hypot(warhead.state.velocity.x, warhead.state.velocity.z)).toBeCloseTo(20, 6);

    // Nothing fires while guiding; a Fire press detonates the warhead.
    const events = system.tickPawn(owner, FIRE, 70);
    expect(ofType(events, 'shotFired')).toHaveLength(0);
    expect(ofType(events, 'explosion')[0]).toMatchObject({ damageType: 'redeemer', radius: 50 });
    expect(ofType(events, 'guidanceEnded')).toHaveLength(1);
    expect(owner.state.guiding).toBe(NO_ENTITY);
    expect(system.projectileStates()).toHaveLength(0);
  });

  it('detonates in place when the owner dies', async () => {
    const { host, system } = await setup();
    const owner = host.addPawn({ weapon: 'redeemer' });
    const warhead = launchGuided(host, system, owner.state.id, []);
    owner.state.alive = false;
    const events = system.onPawnDied(owner.state.id, 5);
    expect(ofType(events, 'explosion')[0]?.position).toEqual(warhead.state.position);
    expect(system.projectileStates()).toHaveLength(0);
  });

  it('removeOwner drops every projectile of a leaving player without exploding', async () => {
    const { host, system } = await setup();
    const owner = host.addPawn({ weapon: 'rocket' });
    for (let t = 0; t < 200; t++) system.tickPawn(owner, FIRE, t);
    system.tickPawn(owner, input(), 200);
    expect(system.projectileStates()).toHaveLength(3);
    const events = system.removeOwner(owner.state.id, 201);
    expect(ofType(events, 'entityDestroyed')).toHaveLength(3);
    expect(ofType(events, 'explosion')).toHaveLength(0);
    expect(system.projectileStates()).toHaveLength(0);
  });
});
