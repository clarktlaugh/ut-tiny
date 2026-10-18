/**
 * P12: damage pipeline, pawn life cycle and inventory (docs/DESIGN.md §5, §6).
 */
import { describe, expect, it } from 'vitest';
import {
  applyDamage,
  fallDamageInfo,
  killVolumeInfo,
  suicideInfo,
  type DamageContext,
} from './damage';
import {
  addAmmo,
  bestWeapon,
  canFire,
  consumeAmmo,
  createInventoryState,
  cycleWeapon,
  giveWeapon,
  hasAmmo,
  requestSwitch,
  resetInventory,
  switchIfEmpty,
  tickInventory,
  type WeaponTable,
} from './inventory';
import {
  AUTO_RESPAWN_SECONDS,
  createPawnRecord,
  damagePawn,
  respawnPawn,
  tickPawn,
  wantsRespawn,
  type PawnContext,
  type PawnRecord,
} from './pawn';
import {
  Buttons,
  NO_ENTITY,
  NULL_INPUT,
  TICK_RATE,
  WeaponIds,
  type FireModeDef,
  type InputCommand,
  type Pose,
  type RulesConfig,
  type WeaponDef,
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

const mode = (ammoPerShot: number): FireModeDef => ({
  behavior: 'hitscan',
  rate: 0.1,
  ammoPerShot,
  damage: 10,
});

/** Minimal weapon table; P13 supplies the real one. Priority rises with slot. */
const WEAPONS: WeaponTable = Object.fromEntries(
  WeaponIds.map((id, i): [WeaponId, WeaponDef] => {
    const infinite = id === 'teleporter' || id === 'shock' || id === 'shockScoped';
    return [
      id,
      {
        id,
        slot: (i + 1) as WeaponDef['slot'],
        primary: mode(infinite ? 0 : 1),
        alt: mode(infinite ? 0 : 1),
        ammo: infinite ? null : { start: 10, max: 30, perPickup: 10 },
        switchTime: 0.3,
        weaponStay: id !== 'redeemer',
        priority: i + 1,
      },
    ];
  }),
) as WeaponTable;

const POSE: Pose = { position: { x: 1, y: 2, z: 3 }, yaw: 0.5, pitch: 0 };

function input(overrides: Partial<InputCommand> = {}): InputCommand {
  return { ...NULL_INPUT, ...overrides };
}

function ctx(tick: number): PawnContext {
  return { tick, rules: RULES, weapons: WEAPONS };
}

function dctx(tick: number, instigator?: PawnRecord): DamageContext {
  return instigator
    ? { tick, rules: RULES, instigatorPawn: instigator.state }
    : { tick, rules: RULES };
}

/** A living pawn with spawn protection already expired. */
function livePawn(id = 1, tick = 0): PawnRecord {
  const rec = createPawnRecord(id, `p${id}`, tick);
  respawnPawn(rec, POSE, ctx(tick));
  rec.state.spawnProtectedUntil = 0;
  return rec;
}

describe('damage pipeline', () => {
  it('shield absorbs damage before health', () => {
    const rec = livePawn();
    rec.state.shield = 50;
    const r = applyDamage(
      rec.state,
      { amount: 30, damageType: 'bullet', instigator: 2, weapon: 'assault' },
      dctx(10),
    );
    expect(r.shieldAbsorbed).toBe(30);
    expect(r.healthLost).toBe(0);
    expect(rec.state.shield).toBe(20);
    expect(rec.state.health).toBe(100);

    const r2 = applyDamage(
      rec.state,
      { amount: 50, damageType: 'bullet', instigator: 2, weapon: 'assault' },
      dctx(11),
    );
    expect(r2.shieldAbsorbed).toBe(20);
    expect(r2.healthLost).toBe(30);
    expect(rec.state.shield).toBe(0);
    expect(rec.state.health).toBe(70);
  });

  it('own splash damage is scaled by 0.5; direct and enemy splash are not', () => {
    const rec = livePawn(1);
    const self = applyDamage(
      rec.state,
      { amount: 80, damageType: 'rocket', instigator: 1, weapon: 'rocket' },
      dctx(1),
    );
    expect(self.amount).toBe(40);
    expect(rec.state.health).toBe(60);

    const enemy = applyDamage(
      rec.state,
      { amount: 30, damageType: 'rocket', instigator: 2, weapon: 'rocket' },
      dctx(2),
    );
    expect(enemy.amount).toBe(30);

    const ownHitscan = applyDamage(
      rec.state,
      { amount: 10, damageType: 'bullet', instigator: 1, weapon: 'assault' },
      dctx(3),
    );
    expect(ownHitscan.amount).toBe(10);
    expect(rec.state.health).toBe(20);
  });

  it('every damage event carries a momentum vector; self splash keeps full momentum', () => {
    const rec = livePawn(1);
    const momentum = { x: 0, y: 12, z: -3 };
    const r = applyDamage(
      rec.state,
      { amount: 60, damageType: 'rocket', instigator: 1, weapon: 'rocket', momentum },
      dctx(5),
    );
    expect(r.velocityChange).toEqual(momentum);
    const ev = r.events[0];
    expect(ev?.type).toBe('damage');
    if (ev?.type === 'damage') {
      expect(ev.momentum).toEqual(momentum);
      expect(ev.amount).toBe(30);
      expect(ev.target).toBe(1);
      expect(ev.instigator).toBe(1);
    }
    const plain = applyDamage(
      rec.state,
      { amount: 5, damageType: 'bullet', instigator: 2, weapon: 'assault' },
      dctx(6),
    );
    expect(plain.events[0]).toMatchObject({ type: 'damage', momentum: { x: 0, y: 0, z: 0 } });
  });

  it('UDamage on the instigator doubles damage', () => {
    const shooter = livePawn(2);
    shooter.state.udamageUntil = 100;
    const target = livePawn(1);
    const r = applyDamage(
      target.state,
      { amount: 20, damageType: 'bullet', instigator: 2, weapon: 'assault' },
      dctx(50, shooter),
    );
    expect(r.amount).toBe(40);
    const late = applyDamage(
      target.state,
      { amount: 20, damageType: 'bullet', instigator: 2, weapon: 'assault' },
      dctx(100, shooter),
    );
    expect(late.amount).toBe(20);
  });

  it('death emits a death event with killer, damageType and weapon after the damage event', () => {
    const rec = livePawn(1);
    const r = damagePawn(
      rec,
      { amount: 150, damageType: 'sniper', instigator: 7, weapon: 'sniper' },
      dctx(30),
    );
    expect(r.killed).toBe(true);
    expect(r.events.map((e) => e.type)).toEqual(['damage', 'death']);
    expect(r.events[1]).toEqual({
      type: 'death',
      tick: 30,
      victim: 1,
      killer: 7,
      damageType: 'sniper',
      weapon: 'sniper',
    });
    expect(rec.state.alive).toBe(false);
    expect(rec.state.health).toBe(0);
    expect(rec.state.respawnAt).toBe(30 + RULES.respawnDelay * TICK_RATE);
  });

  it('a dead pawn takes no further damage', () => {
    const rec = livePawn(1);
    damagePawn(rec, { amount: 500, damageType: 'shock', instigator: 2, weapon: 'shock' }, dctx(1));
    const r = damagePawn(
      rec,
      { amount: 10, damageType: 'bullet', instigator: 2, weapon: 'assault' },
      dctx(2),
    );
    expect(r.applied).toBe(false);
    expect(r.events).toEqual([]);
  });

  it('super shock one-shots a 199 health + 150 shield pawn', () => {
    const rec = livePawn(1);
    rec.state.health = 199;
    rec.state.shield = 150;
    const r = applyDamage(
      rec.state,
      { amount: 1000, damageType: 'shock', instigator: 2, weapon: 'shock' },
      dctx(1),
    );
    expect(r.killed).toBe(true);
  });

  it('environmental deaths have no killer; kill volumes carry their message', () => {
    const fall = livePawn(1);
    const r = applyDamage(fall.state, fallDamageInfo(120), dctx(1));
    expect(r.events[1]).toMatchObject({ type: 'death', killer: NO_ENTITY, damageType: 'fall' });

    const vol = livePawn(2);
    vol.state.shield = 150;
    const v = applyDamage(vol.state, killVolumeInfo('flushed'), dctx(1));
    expect(v.killed).toBe(true);
    expect(v.events[1]).toMatchObject({
      type: 'death',
      killer: NO_ENTITY,
      damageType: 'killVolume',
      message: 'flushed',
    });
  });

  it('suicide kills through shield and names the victim as killer', () => {
    const rec = livePawn(3);
    rec.state.shield = 100;
    const r = applyDamage(rec.state, suicideInfo(3), dctx(1));
    expect(r.killed).toBe(true);
    expect(r.events[1]).toMatchObject({ victim: 3, killer: 3, damageType: 'suicide' });
  });

  it('spawn protection blocks damage until it expires or the pawn fires', () => {
    const rec = createPawnRecord(1, 'p1');
    respawnPawn(rec, POSE, ctx(0));
    const hit = { amount: 50, damageType: 'bullet', instigator: 2, weapon: 'assault' } as const;
    expect(applyDamage(rec.state, hit, dctx(10)).applied).toBe(false);
    expect(rec.state.health).toBe(100);
    // Expires after RulesConfig.spawnProtection (2 s).
    expect(applyDamage(rec.state, hit, dctx(2 * TICK_RATE)).applied).toBe(true);

    const rec2 = createPawnRecord(2, 'p2');
    respawnPawn(rec2, POSE, ctx(0));
    tickPawn(rec2, input({ buttons: Buttons.Fire }), ctx(5));
    expect(applyDamage(rec2.state, hit, dctx(6)).applied).toBe(true);

    // Telefrags go through spawn protection.
    const rec3 = createPawnRecord(3, 'p3');
    respawnPawn(rec3, POSE, ctx(0));
    const tf = applyDamage(
      rec3.state,
      { amount: 0, damageType: 'telefrag', instigator: 2, weapon: 'teleporter' },
      dctx(1),
    );
    expect(tf.killed).toBe(true);
  });
});

describe('pawn life cycle', () => {
  it('a new pawn is dead and respawns on the first tick', () => {
    const rec = createPawnRecord(1, 'local');
    expect(rec.state.alive).toBe(false);
    expect(wantsRespawn(rec, input(), 0)).toBe(true);
  });

  it('respawn gives 100 health, 0 shield, the loadout and a respawn event', () => {
    const rec = createPawnRecord(1, 'local');
    const events = respawnPawn(rec, POSE, ctx(42));
    expect(events).toEqual([{ type: 'respawn', tick: 42, pawn: 1, pose: POSE }]);
    expect(rec.state).toMatchObject({
      alive: true,
      health: 100,
      shield: 0,
      position: POSE.position,
      yaw: POSE.yaw,
      owned: ['teleporter', 'assault'],
      weapon: 'assault',
      pendingWeapon: null,
      spawnProtectedUntil: 42 + 2 * TICK_RATE,
    });
    expect(rec.state.ammo.assault).toBe(10);
  });

  it('respawn requires respawnDelay to pass and Fire to be pressed, or 2 s to elapse', () => {
    const rec = livePawn(1);
    damagePawn(
      rec,
      { amount: 999, damageType: 'shock', instigator: 2, weapon: 'shock' },
      dctx(100),
    );
    // Fire held from the moment of death does not count as a press.
    expect(wantsRespawn(rec, input({ buttons: Buttons.Fire }), 101)).toBe(false);
    expect(wantsRespawn(rec, input(), 102)).toBe(false);
    // Pressed before respawnDelay: too early.
    expect(wantsRespawn(rec, input({ buttons: Buttons.Fire }), 130)).toBe(false);
    expect(wantsRespawn(rec, input(), 131)).toBe(false);
    // Pressed after respawnDelay (1 s): respawn.
    expect(wantsRespawn(rec, input({ buttons: Buttons.Fire }), 100 + TICK_RATE)).toBe(true);

    const idle = livePawn(2);
    damagePawn(idle, { amount: 999, damageType: 'shock', instigator: 1, weapon: 'shock' }, dctx(0));
    const auto = AUTO_RESPAWN_SECONDS * TICK_RATE;
    expect(wantsRespawn(idle, input(), auto - 1)).toBe(false);
    expect(wantsRespawn(idle, input(), auto)).toBe(true);
  });

  it('health above 100 decays at 1 per second down to 100', () => {
    const rec = livePawn(1);
    rec.state.health = 103;
    for (let t = 1; t <= 10 * TICK_RATE; t++) tickPawn(rec, input(), ctx(t));
    expect(rec.state.health).toBe(100);

    rec.state.health = 150;
    for (let t = 1; t <= 5 * TICK_RATE; t++) tickPawn(rec, input(), ctx(t));
    expect(rec.state.health).toBe(145);
  });
});

describe('inventory', () => {
  it('switching weapons takes 0.3 s and emits weaponSwitched when complete', () => {
    const rec = livePawn(1);
    const s = rec.state;
    expect(s.weapon).toBe('assault');
    let events = tickPawn(rec, input({ weapon: 1 }), ctx(100));
    expect(events).toEqual([]);
    expect(s.pendingWeapon).toBe('teleporter');
    expect(canFire(s)).toBe(false);

    const switchTicks = Math.round(0.3 * TICK_RATE);
    for (let t = 101; t < 100 + switchTicks; t++) {
      expect(tickPawn(rec, input(), ctx(t))).toEqual([]);
      expect(s.weapon).toBe('assault');
    }
    events = tickPawn(rec, input(), ctx(100 + switchTicks));
    expect(events).toEqual([
      { type: 'weaponSwitched', tick: 100 + switchTicks, pawn: 1, weapon: 'teleporter' },
    ]);
    expect(s.weapon).toBe('teleporter');
    expect(s.pendingWeapon).toBeNull();
    expect(canFire(s)).toBe(true);
  });

  it('weapon slot request for an unowned weapon is ignored', () => {
    const rec = livePawn(1);
    expect(tickPawn(rec, input({ weapon: 4 }), ctx(1))).toEqual([]);
    expect(rec.state.pendingWeapon).toBeNull();
    expect(rec.state.weapon).toBe('assault');
  });

  it('requesting the held weapon mid-switch cancels the switch', () => {
    const rec = livePawn(1);
    tickPawn(rec, input({ weapon: 1 }), ctx(1));
    expect(rec.state.pendingWeapon).toBe('teleporter');
    tickPawn(rec, input({ weapon: 2 }), ctx(2));
    expect(rec.state.pendingWeapon).toBeNull();
    expect(rec.state.weapon).toBe('assault');
    for (let t = 3; t < 40; t++) expect(tickPawn(rec, input(), ctx(t))).toEqual([]);
  });

  it('cannot switch while guiding a Redeemer', () => {
    const rec = livePawn(1);
    rec.state.guiding = 99;
    tickPawn(rec, input({ weapon: 1 }), ctx(1));
    expect(rec.state.pendingWeapon).toBeNull();
  });

  it('next/prev weapon cycles owned weapons with ammo in slot order', () => {
    const rec = livePawn(1);
    const inv = rec.inventory;
    giveWeapon(rec.state, inv, 'sniper', 0, WEAPONS, false);
    giveWeapon(rec.state, inv, 'rocket', 0, WEAPONS, false);
    rec.state.ammo.rocket = 0;
    expect(cycleWeapon(rec.state, 1, WEAPONS)).toBe('sniper');
    expect(cycleWeapon(rec.state, -1, WEAPONS)).toBe('teleporter');
    tickPawn(rec, input({ buttons: Buttons.NextWeapon }), ctx(1));
    expect(rec.state.pendingWeapon).toBe('sniper');
    // Next again cycles from the pending weapon and wraps.
    tickPawn(rec, input({ buttons: Buttons.NextWeapon }), ctx(2));
    expect(rec.state.pendingWeapon).toBe('teleporter');
  });

  it('auto-switch on pickup only when the new weapon has higher priority', () => {
    const rec = livePawn(1);
    const inv = rec.inventory;
    expect(giveWeapon(rec.state, inv, 'rocket', 1, WEAPONS)).toEqual([]);
    expect(rec.state.pendingWeapon).toBe('rocket');
    for (let t = 2; t <= 19; t++) tickPawn(rec, input(), ctx(t));
    expect(rec.state.weapon).toBe('rocket');

    giveWeapon(rec.state, inv, 'mines', 20, WEAPONS);
    expect(rec.state.pendingWeapon).toBeNull();
    expect(rec.state.owned).toContain('mines');

    // Toggle off.
    giveWeapon(rec.state, inv, 'redeemer', 21, WEAPONS, false);
    expect(rec.state.pendingWeapon).toBeNull();
  });

  it('ammo never exceeds AmmoDef.max', () => {
    const rec = livePawn(1);
    const s = rec.state;
    expect(addAmmo(s, 'assault', 15, WEAPONS)).toBe(15);
    expect(s.ammo.assault).toBe(25);
    expect(addAmmo(s, 'assault', 15, WEAPONS)).toBe(5);
    expect(s.ammo.assault).toBe(30);
    expect(addAmmo(s, 'teleporter', 5, WEAPONS)).toBe(0);
    // Ammo collected before the weapon adds to its starting ammo, capped.
    addAmmo(s, 'rocket', 25, WEAPONS);
    giveWeapon(s, rec.inventory, 'rocket', 1, WEAPONS, false);
    expect(s.ammo.rocket).toBe(30);
    // Picking up an owned weapon tops up to at least the starting ammo.
    s.ammo.rocket = 3;
    giveWeapon(s, rec.inventory, 'rocket', 2, WEAPONS, false);
    expect(s.ammo.rocket).toBe(10);
  });

  it('consumeAmmo spends ammo and refuses when short; empty weapon switches to the best', () => {
    const rec = livePawn(1);
    const s = rec.state;
    s.ammo.assault = 1;
    expect(consumeAmmo(s, 'assault', 2, WEAPONS)).toBe(false);
    expect(consumeAmmo(s, 'assault', 1, WEAPONS)).toBe(true);
    expect(s.ammo.assault).toBe(0);
    expect(hasAmmo(s, 'assault', WEAPONS)).toBe(false);
    expect(consumeAmmo(s, 'teleporter', 1, WEAPONS)).toBe(true);
    expect(bestWeapon(s, WEAPONS)).toBe('teleporter');
    switchIfEmpty(s, rec.inventory, 5, WEAPONS);
    expect(s.pendingWeapon).toBe('teleporter');
  });

  it('dead pawns ignore inventory input; death clears a pending switch', () => {
    const rec = livePawn(1);
    tickPawn(rec, input({ weapon: 1 }), ctx(1));
    damagePawn(rec, { amount: 999, damageType: 'shock', instigator: 2, weapon: 'shock' }, dctx(2));
    expect(rec.state.pendingWeapon).toBeNull();
    expect(tickInventory(rec.state, rec.inventory, input({ weapon: 2 }), 3, WEAPONS)).toEqual([]);
    expect(requestSwitch(rec.state, rec.inventory, 'assault', 3, WEAPONS)).toEqual([]);
  });

  it('resetInventory equips the best loadout weapon without a switch delay', () => {
    const rec = livePawn(1);
    const inv = createInventoryState();
    resetInventory(rec.state, inv, ['teleporter', 'shock', 'assault'], WEAPONS);
    expect(rec.state.weapon).toBe('shock');
    expect(rec.state.owned).toEqual(['teleporter', 'shock', 'assault']);
    expect(rec.state.ammo).toEqual({ assault: 10 });
  });
});
