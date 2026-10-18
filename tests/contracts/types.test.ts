import { describe, expect, it } from 'vitest';
import {
  Buttons,
  DODGE_BUTTONS,
  NULL_INPUT,
  NO_ENTITY,
  PAWN_STATS,
  TICK_DT,
  TICK_RATE,
  WeaponIds,
} from '../../src/sim/types';
import type { InputCommand, MapDef, SimEvent, WeaponDef, WorldState } from '../../src/sim/types';

describe('constants', () => {
  it('ticks at 60 Hz', () => {
    expect(TICK_RATE).toBe(60);
    expect(TICK_DT * TICK_RATE).toBeCloseTo(1, 12);
  });

  it('button bits are distinct powers of two', () => {
    const bits = Object.values(Buttons);
    for (const b of bits) expect(b & (b - 1)).toBe(0);
    expect(new Set(bits).size).toBe(bits.length);
    expect(DODGE_BUTTONS).toBe(
      Buttons.DodgeForward | Buttons.DodgeBack | Buttons.DodgeLeft | Buttons.DodgeRight,
    );
  });

  it('null input does nothing and is frozen', () => {
    expect(NULL_INPUT.buttons).toBe(0);
    expect(NULL_INPUT.weapon).toBe(0);
    expect(NULL_INPUT.moveX).toBe(0);
    expect(NULL_INPUT.moveY).toBe(0);
    expect(Object.isFrozen(NULL_INPUT)).toBe(true);
  });

  it('has eight weapons in UT slot order and a reserved null entity id', () => {
    expect(WeaponIds).toHaveLength(8);
    expect(WeaponIds[0]).toBe('teleporter');
    expect(WeaponIds[7]).toBe('redeemer');
    expect(NO_ENTITY).toBe(0);
  });

  it('pawn stats match DESIGN §6', () => {
    expect(PAWN_STATS.health).toBe(100);
    expect(PAWN_STATS.healthMax).toBe(199);
    expect(PAWN_STATS.shieldMax).toBe(150);
    expect(PAWN_STATS.selfDamageScale).toBe(0.5);
  });
});

describe('type shapes compile', () => {
  it('accepts literal values of the contract types', () => {
    const cmd: InputCommand = { ...NULL_INPUT, seq: 1, buttons: Buttons.Fire | Buttons.Jump };
    const weapon: WeaponDef = {
      id: 'rocket',
      slot: 4,
      primary: {
        behavior: 'projectile',
        rate: 0.9,
        ammoPerShot: 1,
        damage: 90,
        projectileSpeed: 27,
        splashRadius: 4.4,
        momentum: 1,
        loadMax: 3,
        loadTime: 0.95,
      },
      alt: { behavior: 'projectile', rate: 0.9, ammoPerShot: 1, damage: 90, loadMax: 3 },
      ammo: { start: 12, max: 30, perPickup: 9 },
      switchTime: 0.3,
      weaponStay: true,
      priority: 7,
    };
    const map: MapDef = {
      name: 'test',
      scale: 40,
      brushes: [],
      props: [],
      spawns: [{ position: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 }],
      pickups: [],
      jumpPads: [],
      volumes: [],
      lights: [],
      navLinks: [],
      cameras: [],
      ambience: { loops: [], reverb: 'room' },
    };
    const event: SimEvent = { type: 'matchPhase', tick: 0, phase: 'warmup' };
    const state: WorldState = {
      tick: 0,
      time: 0,
      rngState: 0,
      entities: [],
      match: {
        phase: 'warmup',
        fragLimit: 20,
        timeLimit: 600,
        elapsed: 0,
        scores: [],
        winner: null,
      },
    };
    expect(cmd.buttons & Buttons.Fire).toBeTruthy();
    expect(weapon.slot).toBe(4);
    expect(map.spawns).toHaveLength(1);
    expect(event.type).toBe('matchPhase');
    expect(state.match.phase).toBe('warmup');
  });
});
