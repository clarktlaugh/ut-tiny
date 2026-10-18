import { describe, expect, it } from 'vitest';
import {
  NO_ENTITY,
  WeaponIds,
  type EntityId,
  type PickupType,
  type SimEvent,
  type Vec3,
} from '../sim/types';
import {
  cuesForEvent,
  cuesForEvents,
  FIRE_SOUNDS,
  LAND_HARD_SPEED,
  LAND_SILENT_SPEED,
  PICKUP_SOUNDS,
  type CueContext,
} from './eventSounds';
import { SOUND_IDS, soundDef } from './sounds';

const LOCAL = 1;
const OTHER = 2;
const PICKUP = 50;
const PROJ = 60;
const v = (x: number, y = 0, z = 0): Vec3 => ({ x, y, z });

const positions = new Map<EntityId, Vec3>([
  [LOCAL, v(0)],
  [OTHER, v(10)],
  [PICKUP, v(20)],
  [PROJ, v(30)],
]);
const ctx: CueContext = { localPawn: LOCAL, positionOf: (id) => positions.get(id) };

const shot = (pawn: number, weapon: (typeof WeaponIds)[number], mode: 'primary' | 'alt') =>
  ({
    type: 'shotFired',
    tick: 5,
    pawn,
    weapon,
    mode,
    origin: v(1, 2, 3),
    direction: v(0, 0, -1),
  }) satisfies SimEvent;

describe('event → sound mapping', () => {
  it('maps every weapon and mode to a fire sound in the catalog', () => {
    for (const w of WeaponIds) {
      for (const mode of ['primary', 'alt'] as const) {
        expect(SOUND_IDS).toContain(FIRE_SOUNDS[w][mode]);
        const [c] = cuesForEvent(shot(OTHER, w, mode), ctx);
        expect(c?.sound).toBe(FIRE_SOUNDS[w][mode]);
      }
    }
  });

  it("plays the local pawn's own shots non-positionally and others' at the muzzle", () => {
    const [own] = cuesForEvent(shot(LOCAL, 'rocket', 'primary'), ctx);
    expect(own).toMatchObject({ sound: 'rocketFire', bus: 'local' });
    expect(own?.position).toBeUndefined();

    const [theirs] = cuesForEvent(shot(OTHER, 'shock', 'alt'), ctx);
    expect(theirs).toMatchObject({ sound: 'shockAlt', bus: 'world', position: v(1, 2, 3) });
  });

  it('treats everyone as remote when there is no local pawn', () => {
    const [c] = cuesForEvent(shot(LOCAL, 'assault', 'primary'), {
      ...ctx,
      localPawn: NO_ENTITY,
    });
    expect(c?.bus).toBe('world');
  });

  it('plays hitscan impacts where the trace ends', () => {
    const cues = cuesForEvent(
      {
        type: 'hitscan',
        tick: 1,
        pawn: OTHER,
        weapon: 'shock',
        from: v(0),
        to: v(7, 1, 2),
        hitPawn: NO_ENTITY,
        headshot: false,
      },
      ctx,
    );
    expect(cues).toEqual([
      expect.objectContaining({ sound: 'impactShock', bus: 'world', position: v(7, 1, 2) }),
    ]);
  });

  it('chooses explosion sounds by damage type and scales by radius', () => {
    const boom = (damageType: 'rocket' | 'shock' | 'redeemer' | 'grenade', radius: number) =>
      cuesForEvent(
        { type: 'explosion', tick: 1, position: v(4), radius, damageType, instigator: OTHER },
        ctx,
      )[0];
    expect(boom('rocket', 6)).toMatchObject({ sound: 'explosion', volume: 1, position: v(4) });
    expect(boom('grenade', 3)?.volume).toBeCloseTo(0.5);
    expect(boom('shock', 8)?.sound).toBe('shockCombo');
    expect(boom('redeemer', 40)?.sound).toBe('redeemerBlast');
  });

  it('gives one hit confirmation per batch when the local pawn damages someone', () => {
    const dmg = (target: number, instigator: number): SimEvent => ({
      type: 'damage',
      tick: 3,
      target,
      instigator,
      amount: 20,
      damageType: 'rocket',
      momentum: v(0),
    });
    const cues = cuesForEvents([dmg(OTHER, LOCAL), dmg(OTHER, LOCAL), dmg(LOCAL, LOCAL)], ctx);
    expect(cues.filter((c) => c.sound === 'hitConfirm')).toHaveLength(1);
    expect(cues.find((c) => c.sound === 'hitConfirm')?.bus).toBe('ui');
    // Pain: the victim's at their position, the local pawn's own on the local bus.
    expect(cues.filter((c) => c.sound === 'hurt' && c.bus === 'world')).toHaveLength(2);
    expect(cues.filter((c) => c.sound === 'hurt' && c.bus === 'local')).toHaveLength(1);

    expect(cuesForEvents([dmg(LOCAL, OTHER)], ctx).map((c) => c.sound)).toEqual(['hurt']);
  });

  it('maps every pickup type, local on the local bus and remote at the pickup', () => {
    for (const t of Object.keys(PICKUP_SOUNDS) as PickupType[]) {
      const ev = (pawn: number): SimEvent => ({
        type: 'pickupTaken',
        tick: 1,
        pawn,
        pickup: PICKUP,
        pickupType: t,
      });
      expect(cuesForEvent(ev(LOCAL), ctx)[0]).toMatchObject({
        sound: PICKUP_SOUNDS[t],
        bus: 'local',
      });
      expect(cuesForEvent(ev(OTHER), ctx)[0]).toMatchObject({
        sound: PICKUP_SOUNDS[t],
        bus: 'world',
        position: v(20),
      });
    }
    expect(
      cuesForEvent(
        { type: 'pickupRespawned', tick: 1, pickup: PICKUP, pickupType: 'healthPack' },
        ctx,
      )[0],
    ).toMatchObject({ sound: 'pickupRespawn', position: v(20) });
  });

  it('maps footsteps, jumps, dodges and landings', () => {
    const step = (pawn: number) =>
      cuesForEvent({ type: 'footstep', tick: 1, pawn, position: v(9, 0, 9) }, ctx)[0];
    expect(step(OTHER)).toMatchObject({ sound: 'footstep', bus: 'world', position: v(9, 0, 9) });
    expect(step(LOCAL)).toMatchObject({ sound: 'footstep', bus: 'local', volume: 0.5 });

    const jump = (double: boolean) =>
      cuesForEvent({ type: 'jump', tick: 1, pawn: OTHER, double }, ctx)[0];
    expect(jump(false)).toMatchObject({ sound: 'jump', position: v(10) });
    expect(jump(true)?.sound).toBe('doubleJump');
    expect(cuesForEvent({ type: 'dodge', tick: 1, pawn: OTHER, wall: true }, ctx)[0]?.sound).toBe(
      'dodge',
    );

    const land = (impactSpeed: number) =>
      cuesForEvent({ type: 'land', tick: 1, pawn: OTHER, impactSpeed }, ctx);
    expect(land(LAND_SILENT_SPEED - 0.1)).toEqual([]);
    expect(land(10)[0]).toMatchObject({ sound: 'land', volume: 10 / LAND_HARD_SPEED });
    expect(land(LAND_HARD_SPEED)[0]?.sound).toBe('landHard');
  });

  it('maps respawn, death, jump pads, teleports and weapon switches', () => {
    expect(
      cuesForEvent(
        { type: 'respawn', tick: 1, pawn: OTHER, pose: { position: v(5), yaw: 0, pitch: 0 } },
        ctx,
      )[0],
    ).toMatchObject({ sound: 'respawn', position: v(5) });
    expect(
      cuesForEvent(
        {
          type: 'death',
          tick: 1,
          victim: OTHER,
          killer: LOCAL,
          damageType: 'rocket',
          weapon: 'rocket',
        },
        ctx,
      )[0],
    ).toMatchObject({ sound: 'death', position: v(10) });
    // Unknown pad position falls back to the pawn.
    expect(cuesForEvent({ type: 'jumpPad', tick: 1, pawn: OTHER, pad: 999 }, ctx)[0]).toMatchObject(
      { sound: 'jumpPad', position: v(10) },
    );

    const tp = (pawn: number): SimEvent => ({
      type: 'teleport',
      tick: 1,
      pawn,
      from: v(1),
      to: v(2),
      telefragged: NO_ENTITY,
    });
    expect(cuesForEvent(tp(OTHER), ctx).map((c) => [c.sound, c.position])).toEqual([
      ['teleportOut', v(1)],
      ['teleportIn', v(2)],
    ]);
    expect(cuesForEvent(tp(LOCAL), ctx)).toEqual([
      expect.objectContaining({ sound: 'teleportIn', bus: 'local' }),
    ]);

    const sw = (pawn: number): SimEvent => ({
      type: 'weaponSwitched',
      tick: 1,
      pawn,
      weapon: 'shock',
    });
    expect(cuesForEvent(sw(LOCAL), ctx)[0]).toMatchObject({ sound: 'weaponSwitch', bus: 'local' });
    expect(cuesForEvent(sw(OTHER), ctx)).toEqual([]);
  });

  it('places shot-down projectiles at their last known position and drops unplaceable world cues', () => {
    expect(
      cuesForEvent({ type: 'projectileDestroyed', tick: 1, id: PROJ, byPawn: OTHER }, ctx)[0],
    ).toMatchObject({ sound: 'projectileShotDown', position: v(30) });
    expect(
      cuesForEvent({ type: 'projectileDestroyed', tick: 1, id: 12345, byPawn: OTHER }, ctx),
    ).toEqual([]);
    expect(cuesForEvent({ type: 'jump', tick: 1, pawn: 777, double: false }, ctx)).toEqual([]);
  });

  it('plays announcer lines addressed to everyone or to the local pawn only', () => {
    const line = (toPawn: number): SimEvent => ({
      type: 'announcer',
      tick: 1,
      line: 'firstBlood',
      toPawn,
    });
    expect(cuesForEvent(line(NO_ENTITY), ctx)[0]).toMatchObject({
      sound: 'announcer.firstBlood',
      bus: 'announcer',
      rate: 1,
    });
    expect(cuesForEvent(line(LOCAL), ctx)).toHaveLength(1);
    expect(cuesForEvent(line(OTHER), ctx)).toEqual([]);
  });

  it('is silent for bookkeeping events', () => {
    const silent: SimEvent[] = [
      { type: 'entitySpawned', tick: 1, id: 3, kind: 'projectile' },
      { type: 'entityDestroyed', tick: 1, id: 3, kind: 'projectile' },
      { type: 'score', tick: 1, playerId: 'local', frags: 1, deaths: 0 },
      { type: 'matchPhase', tick: 1, phase: 'playing' },
      { type: 'guidanceStarted', tick: 1, pawn: LOCAL, projectile: 3 },
    ];
    expect(cuesForEvents(silent, ctx)).toEqual([]);
  });

  it('keeps world cues positioned and others not, with deterministic rate jitter in range', () => {
    const events: SimEvent[] = [
      shot(OTHER, 'assault', 'primary'),
      shot(LOCAL, 'assault', 'primary'),
      { type: 'footstep', tick: 9, pawn: OTHER, position: v(3) },
    ];
    const a = cuesForEvents(events, ctx);
    const b = cuesForEvents(events, ctx);
    expect(a).toEqual(b);
    for (const c of a) {
      expect(c.bus === 'world').toBe(c.position !== undefined);
      const j = soundDef(c.sound).rateJitter;
      expect(c.rate).toBeGreaterThanOrEqual(1 - j);
      expect(c.rate).toBeLessThanOrEqual(1 + j);
    }
  });

  it('copies positions so later mutation of event data does not move a cue', () => {
    const origin = v(1);
    const ev: SimEvent = { ...shot(OTHER, 'rocket', 'primary'), origin };
    const [c] = cuesForEvent(ev, ctx);
    origin.x = 99;
    expect(c?.position).toEqual(v(1));
  });
});
