/**
 * P18: pickups (docs/DESIGN.md §6): vial cap and decay, packs and shields,
 * UDamage, ammo, weapon stay once per life, respawn timers.
 */
import { describe, expect, it } from 'vitest';
import { PICKUPS, PICKUP_FX } from '../data/pickups';
import { WEAPONS } from '../data/weapons';
import { LAUNDRY_ROOM } from '../maps/laundry-room';
import { createPawnRecord, damagePawn, respawnPawn, tickPawn, type PawnRecord } from './pawn';
import {
  PickupSystem,
  respawnSecondsFor,
  secondsToTicks,
  touches,
  type PickupUpdate,
} from './pickups';
import {
  NULL_INPUT,
  TICK_RATE,
  type PickupPlacement,
  type PickupState,
  type PickupType,
  type RulesConfig,
  type Vec3,
  type WeaponId,
} from './types';

const RULES: RulesConfig = {
  fragLimit: 20,
  timeLimit: 600,
  weaponStay: true,
  spawnProtection: 2,
  respawnDelay: 1,
  udamageEnabled: true,
};

const AT: Vec3 = { x: 0, y: 1, z: 0 };
const AWAY: Vec3 = { x: 100, y: 1, z: 100 };

function place(type: PickupType, weapon?: WeaponId, position: Vec3 = AT): PickupPlacement {
  const p: PickupPlacement = { type, position: { ...position } };
  if (weapon) p.weapon = weapon;
  return p;
}

function setup(placements: PickupPlacement[], rules: Partial<RulesConfig> = {}) {
  let next = 100;
  const system = new PickupSystem({
    map: { pickups: placements },
    rules: { ...RULES, ...rules },
    weapons: WEAPONS,
    allocateId: () => next++,
  });
  return system;
}

/** A live pawn standing on `AT` (capsule center 0.9 m above the floor). */
function livePawn(id = 1, tick = 0): PawnRecord {
  const rec = createPawnRecord(id, `p${id}`, tick);
  respawnPawn(
    rec,
    { position: { x: 0, y: 0.9, z: 0 }, yaw: 0, pitch: 0 },
    {
      tick,
      rules: RULES,
      weapons: WEAPONS,
    },
  );
  return rec;
}

function moveTo(rec: PawnRecord, pos: Vec3): void {
  rec.state.position = { ...pos };
}

function kill(rec: PawnRecord, tick: number): void {
  damagePawn(
    rec,
    { amount: 1, damageType: 'suicide', instigator: rec.state.id, weapon: null },
    { tick, rules: RULES },
  );
}

const takenTypes = (out: PickupUpdate) =>
  out.events.filter((e) => e.type === 'pickupTaken').map((e) => e.pickupType);

/** Run `update` at `tick` and the pawn's life rules, like the world would. */
function step(system: PickupSystem, tick: number, pawns: PawnRecord[]): PickupUpdate {
  for (const p of pawns) tickPawn(p, NULL_INPUT, { tick, rules: RULES, weapons: WEAPONS });
  return system.update(tick, pawns);
}

describe('pickup data (§6)', () => {
  it('matches the §6 table', () => {
    expect(PICKUPS.healthVial).toMatchObject({ amount: 5, cap: 199, respawnSeconds: 27 });
    expect(PICKUPS.healthPack).toMatchObject({ amount: 25, cap: 100, respawnSeconds: 20 });
    expect(PICKUPS.shieldPack).toMatchObject({ amount: 50, cap: 150, respawnSeconds: 30 });
    expect(PICKUPS.superShield).toMatchObject({ amount: 100, cap: 150, respawnSeconds: 60 });
    expect(PICKUPS.ammo.respawnSeconds).toBe(30);
    expect(PICKUPS.udamage).toMatchObject({ amount: 30, respawnSeconds: 90 });
    for (const [type, def] of Object.entries(PICKUPS)) expect(def.type).toBe(type);
  });

  it('has FX keys for every pickup type', () => {
    for (const type of Object.keys(PICKUPS)) {
      expect(PICKUP_FX[type as PickupType].takeSound).toMatch(/^pickup\//);
    }
  });
});

describe('health vials: cap 199 and decay', () => {
  it('raises health by 5 up to 199, then stops being taken', () => {
    const sys = setup([place('healthVial')]);
    const pawn = livePawn();
    pawn.state.health = 197;
    const out = sys.update(0, [pawn]);
    expect(takenTypes(out)).toEqual(['healthVial']);
    expect(out.taken[0]?.gained).toBe(2);
    expect(pawn.state.health).toBe(199);

    // Respawned, but the pawn is at the cap: not taken, stays available.
    const respawn = secondsToTicks(27);
    const later = sys.update(respawn, [pawn]);
    expect(later.events).toEqual([
      { type: 'pickupRespawned', tick: respawn, pickup: 100, pickupType: 'healthVial' },
    ]);
    expect(pawn.state.health).toBe(199);
    expect(sys.states()[0]?.available).toBe(true);
  });

  it('stacks vials past 100 and decays back toward 100 at 1/s', () => {
    const placements = Array.from({ length: 21 }, (_, i) =>
      place('healthVial', undefined, { x: i * 0.01, y: 1, z: 0 }),
    );
    const sys = setup(placements);
    const pawn = livePawn();
    expect(pawn.state.health).toBe(100);
    sys.update(1, [pawn]);
    expect(pawn.state.health).toBe(199); // 20 vials to the cap; the 21st is left
    expect(sys.states().filter((p) => p.available)).toHaveLength(1);

    moveTo(pawn, AWAY);
    for (let t = 2; t <= 10 * TICK_RATE; t++) step(sys, t, [pawn]);
    expect(pawn.state.health).toBe(189);
    for (let t = 10 * TICK_RATE + 1; t <= 200 * TICK_RATE; t++) step(sys, t, [pawn]);
    expect(pawn.state.health).toBe(100);
  });

  it('health packs only heal to 100 and leave overheal alone', () => {
    const sys = setup([place('healthPack')]);
    const pawn = livePawn();
    pawn.state.health = 90;
    sys.update(0, [pawn]);
    expect(pawn.state.health).toBe(100);

    const sys2 = setup([place('healthPack')]);
    const over = livePawn();
    over.state.health = 150;
    expect(takenTypes(sys2.update(0, [over]))).toEqual([]);
    expect(over.state.health).toBe(150);
  });
});

describe('shields and UDamage', () => {
  it('shield pack +50 and super shield +100, capped at 150', () => {
    const sys = setup([place('shieldPack'), place('superShield')]);
    const pawn = livePawn();
    pawn.state.shield = 20;
    const out = sys.update(0, [pawn]);
    expect(takenTypes(out)).toEqual(['shieldPack', 'superShield']);
    expect(out.taken.map((t) => t.gained)).toEqual([50, 80]);
    expect(pawn.state.shield).toBe(150);
  });

  it('a full shield leaves the pack on the floor', () => {
    const sys = setup([place('superShield')]);
    const pawn = livePawn();
    pawn.state.shield = 150;
    expect(sys.update(0, [pawn]).events).toEqual([]);
    expect(sys.states()[0]?.available).toBe(true);
  });

  it('UDamage gives 30 s and extends when stacked', () => {
    const sys = setup([place('udamage')]);
    const pawn = livePawn();
    sys.update(60, [pawn]);
    expect(pawn.state.udamageUntil).toBe(60 + 30 * TICK_RATE);
    sys.update(60 + 90 * TICK_RATE, [pawn]);
    // Expired by then, so the new 30 s start from the pickup tick.
    expect(pawn.state.udamageUntil).toBe(60 + 120 * TICK_RATE);
  });

  it('UDamage pickups are not created when the rule is off', () => {
    const sys = setup([place('udamage'), place('shieldPack')], { udamageEnabled: false });
    expect(sys.states().map((p) => p.type)).toEqual(['shieldPack']);
    expect(sys.states()[0]?.placementIndex).toBe(1);
  });
});

describe('ammo', () => {
  it('adds AmmoDef.perPickup up to max, also for weapons not owned', () => {
    const sys = setup([place('ammo', 'rocket'), place('ammo', 'assault')]);
    const pawn = livePawn();
    pawn.state.ammo.assault = 180;
    const out = sys.update(0, [pawn]);
    expect(out.taken.map((t) => [t.weapon, t.gained])).toEqual([
      ['rocket', 9],
      ['assault', 20],
    ]);
    expect(pawn.state.ammo.rocket).toBe(9);
    expect(pawn.state.owned).not.toContain('rocket');
    expect(pawn.state.ammo.assault).toBe(200);
  });

  it('is left when that ammo is full', () => {
    const sys = setup([place('ammo', 'assault')]);
    const pawn = livePawn();
    pawn.state.ammo.assault = 200;
    expect(sys.update(0, [pawn]).events).toEqual([]);
  });
});

describe('weapon stay: once per life', () => {
  it('gives the weapon and its start ammo, stays, and is taken once per life', () => {
    const sys = setup([place('weapon', 'rocket')]);
    const pawn = livePawn();
    const first = sys.update(0, [pawn]);
    expect(takenTypes(first)).toEqual(['weapon']);
    expect(pawn.state.owned).toContain('rocket');
    expect(pawn.state.ammo.rocket).toBe(12);
    expect(pawn.state.pendingWeapon).toBe('rocket'); // auto-switch to the stronger weapon
    const pickup = sys.states()[0] as PickupState;
    expect(pickup.available).toBe(true);
    expect(pickup.takenBy).toEqual([1]);

    // Spend some rockets: still not taken again this life.
    pawn.state.ammo.rocket = 2;
    for (let t = 1; t < 120; t++) expect(sys.update(t, [pawn]).events).toEqual([]);
    expect(pawn.state.ammo.rocket).toBe(2);

    // Die and respawn: may take it again.
    kill(pawn, 120);
    sys.update(121, [pawn]);
    expect(pickup.takenBy).toEqual([]);
    respawnPawn(
      pawn,
      { position: { x: 0, y: 0.9, z: 0 }, yaw: 0, pitch: 0 },
      {
        tick: 300,
        rules: RULES,
        weapons: WEAPONS,
      },
    );
    expect(takenTypes(sys.update(300, [pawn]))).toEqual(['weapon']);
    expect(pawn.state.ammo.rocket).toBe(12);
  });

  it('onPawnDied clears the record even if update never saw the pawn dead', () => {
    const sys = setup([place('weapon', 'sniper')]);
    const pawn = livePawn();
    sys.update(0, [pawn]);
    sys.onPawnDied(1);
    expect(sys.states()[0]?.takenBy).toEqual([]);
    expect(takenTypes(sys.update(1, [pawn]))).toEqual(['weapon']);
  });

  it('every pawn can take the same staying weapon', () => {
    const sys = setup([place('weapon', 'shock')]);
    const a = livePawn(1);
    const b = livePawn(2);
    const out = sys.update(0, [b, a]);
    expect(out.taken.map((t) => t.pawn)).toEqual([1, 2]);
    expect(sys.states()[0]?.takenBy).toEqual([1, 2]);
  });

  it('weapon stay off: weapons disappear for 30 s', () => {
    const sys = setup([place('weapon', 'rocket')], { weaponStay: false });
    const a = livePawn(1);
    const b = livePawn(2);
    const out = sys.update(0, [a, b]);
    expect(out.taken.map((t) => t.pawn)).toEqual([1]);
    const p = sys.states()[0] as PickupState;
    expect(p.available).toBe(false);
    expect(p.respawnAt).toBe(30 * TICK_RATE);
    expect(p.takenBy).toEqual([]);
  });
});

describe('respawn times', () => {
  const cases: [PickupPlacement, number | null][] = [
    [place('healthVial'), 27],
    [place('healthPack'), 20],
    [place('shieldPack'), 30],
    [place('superShield'), 60],
    [place('ammo', 'rocket'), 30],
    [place('udamage'), 90],
    [place('weapon', 'rocket'), null],
    [place('weapon', 'redeemer'), 60],
  ];

  it.each(cases)('%o returns after %s s', (placement, seconds) => {
    expect(respawnSecondsFor(placement, { rules: RULES, weapons: WEAPONS, pickups: PICKUPS })).toBe(
      seconds,
    );
  });

  it.each(cases.filter(([, s]) => s !== null))(
    '%o is gone until exactly %s s later',
    (placement, seconds) => {
      const sys = setup([placement]);
      const pawn = livePawn();
      pawn.state.health = 50;
      const start = 10;
      expect(sys.update(start, [pawn]).taken).toHaveLength(1);
      const p = sys.states()[0] as PickupState;
      expect(p.available).toBe(false);

      // Nobody can take it while it is away.
      const other = livePawn(2);
      other.state.health = 1;
      const back = start + secondsToTicks(seconds as number);
      for (let t = start + 1; t < back; t++) {
        expect(sys.update(t, [other]).events).toEqual([]);
      }
      moveTo(other, AWAY);
      expect(sys.update(back, [other]).events).toEqual([
        { type: 'pickupRespawned', tick: back, pickup: p.id, pickupType: placement.type },
      ]);
      expect(p.available).toBe(true);
    },
  );

  it('the Redeemer is taken once, then gone for 60 s even for a pawn without one', () => {
    const sys = setup([place('weapon', 'redeemer')]);
    const a = livePawn(1);
    const b = livePawn(2);
    const out = sys.update(0, [a, b]);
    expect(out.taken.map((t) => t.pawn)).toEqual([1]);
    expect(a.state.ammo.redeemer).toBe(1);
    expect(b.state.owned).not.toContain('redeemer');
  });

  it('a respawned pickup can be taken on the tick it returns', () => {
    const sys = setup([place('healthPack')]);
    const pawn = livePawn();
    pawn.state.health = 10;
    sys.update(0, [pawn]);
    pawn.state.health = 10;
    const out = sys.update(20 * TICK_RATE, [pawn]);
    expect(out.events.map((e) => e.type)).toEqual(['pickupRespawned', 'pickupTaken']);
    expect(pawn.state.health).toBe(35);
  });
});

describe('touching and ordering', () => {
  it('needs the capsule to overlap the trigger', () => {
    const sys = setup([place('healthPack')]);
    const pickup = sys.states()[0] as PickupState;
    const pawn = livePawn();
    expect(touches(pawn.state, pickup)).toBe(true);
    moveTo(pawn, { x: 0.99, y: 0.9, z: 0 });
    expect(touches(pawn.state, pickup)).toBe(true);
    moveTo(pawn, { x: 1.01, y: 0.9, z: 0 });
    expect(touches(pawn.state, pickup)).toBe(false);
    moveTo(pawn, { x: 0, y: 3.95, z: 0 }); // feet 3.05 m up: well above the pickup
    expect(touches(pawn.state, pickup)).toBe(false);
  });

  it('dead pawns take nothing; the lowest pawn id wins a tie', () => {
    const sys = setup([place('healthPack')]);
    const a = livePawn(3);
    const b = livePawn(2);
    a.state.health = 50;
    b.state.health = 50;
    kill(b, 0);
    expect(sys.update(1, [a, b]).taken.map((t) => t.pawn)).toEqual([3]);

    const sys2 = setup([place('healthPack')]);
    const c = livePawn(5);
    const d = livePawn(4);
    c.state.health = 50;
    d.state.health = 50;
    expect(sys2.update(1, [c, d]).taken.map((t) => t.pawn)).toEqual([4]);
  });

  it('builds one entity per laundry-room placement with spawn events', () => {
    let id = 1;
    const sys = new PickupSystem({
      map: LAUNDRY_ROOM,
      rules: RULES,
      weapons: WEAPONS,
      allocateId: () => id++,
    });
    expect(sys.states()).toHaveLength(LAUNDRY_ROOM.pickups.length);
    expect(sys.spawnEvents(0)).toHaveLength(LAUNDRY_ROOM.pickups.length);
    expect(sys.get(1)?.placementIndex).toBe(0);
    expect(sys.states().every((p) => p.available)).toBe(true);
  });

  it('rejects weapon and ammo placements without a weapon', () => {
    expect(() => setup([place('ammo')])).toThrow(/needs a weapon/);
  });
});
