/**
 * P13: the weapon data table (docs/DESIGN.md §5).
 */
import { describe, expect, it } from 'vitest';
import { GRENADE_BULLET_COST, WEAPONS } from '../../../data/weapons';
import { TICK_RATE, WeaponIds } from '../../types';
import { rateTicks } from './fireControl';

describe('weapon table', () => {
  it('has one row per weapon id in slot order', () => {
    WeaponIds.forEach((id, i) => {
      expect(WEAPONS[id].id).toBe(id);
      expect(WEAPONS[id].slot).toBe(i + 1);
    });
  });

  it('matches the §5 ammo column', () => {
    expect(WEAPONS.teleporter.ammo).toBeNull();
    expect(WEAPONS.shock.ammo).toBeNull();
    expect(WEAPONS.shockScoped.ammo).toBeNull();
    expect(WEAPONS.assault.ammo).toMatchObject({ start: 100, max: 200 });
    expect(WEAPONS.mines.ammo).toMatchObject({ start: 8, max: 16 });
    expect(WEAPONS.rocket.ammo).toMatchObject({ start: 12, max: 30 });
    expect(WEAPONS.sniper.ammo).toMatchObject({ start: 20, max: 40 });
    expect(WEAPONS.redeemer.ammo).toMatchObject({ start: 1, max: 1 });
  });

  it('prices assault grenades so 100 / 200 bullets are 4 / 8 grenades', () => {
    expect(WEAPONS.assault.alt.ammoPerShot).toBe(GRENADE_BULLET_COST);
    expect(100 / GRENADE_BULLET_COST).toBe(4);
    expect(200 / GRENADE_BULLET_COST).toBe(8);
  });

  it('matches the §5 damage, speed and rate numbers', () => {
    expect(WEAPONS.assault.primary).toMatchObject({ behavior: 'hitscan', damage: 7, rate: 0.1 });
    expect(rateTicks(WEAPONS.assault.primary)).toBe(TICK_RATE / 10);
    expect(WEAPONS.assault.alt).toMatchObject({
      behavior: 'lob',
      damage: 60,
      splashRadius: 3.5,
      fuse: 2.5,
    });
    expect(WEAPONS.mines.primary).toMatchObject({
      behavior: 'lob',
      damage: 80,
      splashRadius: 5,
      maxDeployed: 4,
    });
    expect(WEAPONS.rocket.primary).toMatchObject({
      behavior: 'projectile',
      damage: 90,
      projectileSpeed: 27,
      splashRadius: 4.4,
      loadMax: 3,
    });
    expect(WEAPONS.sniper.primary).toMatchObject({ damage: 70, headshotMultiplier: 2, rate: 1.33 });
    expect(WEAPONS.shock.primary).toMatchObject({ behavior: 'hitscan', damage: 1000, rate: 0.75 });
    expect(WEAPONS.shock.alt).toEqual(WEAPONS.shock.primary);
    expect(WEAPONS.sniper.alt.zoom).toEqual({ min: 2, max: 8 });
    expect(WEAPONS.shockScoped.alt.zoom).toEqual({ min: 2, max: 6 });
    expect(WEAPONS.redeemer.primary).toMatchObject({
      damage: 250,
      projectileSpeed: 20,
      splashRadius: 50,
      projectileHealth: 50,
    });
  });

  it('only the Redeemer skips weapon stay, respawning after 60 s', () => {
    for (const id of WeaponIds) expect(WEAPONS[id].weaponStay).toBe(id !== 'redeemer');
    expect(WEAPONS.redeemer.respawnSeconds).toBe(60);
  });

  it('uses the common 0.3 s switch time and strictly increasing priorities by strength', () => {
    for (const id of WeaponIds) expect(WEAPONS[id].switchTime).toBe(0.3);
    expect(WEAPONS.rocket.priority).toBeGreaterThan(WEAPONS.assault.priority);
    expect(WEAPONS.shock.priority).toBeGreaterThan(WEAPONS.rocket.priority);
    expect(WEAPONS.redeemer.priority).toBeGreaterThan(WEAPONS.shock.priority);
  });
});
