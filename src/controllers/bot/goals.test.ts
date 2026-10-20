import { describe, expect, it } from 'vitest';
import { WEAPONS } from '../../data/weapons';
import {
  NO_ENTITY,
  TICK_RATE,
  type EntityState,
  type PawnState,
  type PickupState,
  type Vec3,
  type WorldState,
} from '../../sim/types';
import { chooseGoal, pickupValue, ratePickups, scoreGoals, type GoalContext } from './goals';
import type { EnemyMemory } from './perception';
import { skillProfile } from './skill';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

function pawn(id: number, position: Vec3, extra: Partial<PawnState> = {}): PawnState {
  return {
    id,
    kind: 'pawn',
    playerId: `p${id}`,
    alive: true,
    health: 100,
    shield: 0,
    position,
    velocity: v(0, 0, 0),
    yaw: 0,
    pitch: 0,
    grounded: true,
    crouching: false,
    weapon: 'assault',
    pendingWeapon: null,
    owned: ['teleporter', 'assault'],
    ammo: { assault: 100 },
    spawnProtectedUntil: 0,
    respawnAt: 0,
    guiding: NO_ENTITY,
    disc: NO_ENTITY,
    viewingDisc: false,
    zoom: 1,
    udamageUntil: 0,
    ...extra,
  };
}

function pickup(
  id: number,
  type: PickupState['type'],
  position: Vec3,
  extra: Partial<PickupState> = {},
): PickupState {
  return {
    id,
    kind: 'pickup',
    placementIndex: id,
    type,
    position,
    available: true,
    respawnAt: 0,
    takenBy: [],
    ...extra,
  };
}

function ctx(
  self: PawnState,
  entities: EntityState[],
  extra: Partial<GoalContext> = {},
): GoalContext {
  const state: WorldState = {
    tick: 600,
    time: 10,
    rngState: 0,
    entities: [self, ...entities],
    match: { phase: 'playing', fragLimit: 0, timeLimit: 0, elapsed: 10, scores: [], winner: null },
  };
  return {
    tick: 600,
    self,
    state,
    senses: {
      canSee: () => true,
      canTake: (p, pk) => {
        if (!pk.available) return false;
        if (pk.type === 'healthPack') return p.health < 100;
        if (pk.type === 'weapon' && pk.weapon) return !p.owned.includes(pk.weapon);
        return true;
      },
    },
    weapons: WEAPONS,
    profile: skillProfile(2),
    target: null,
    targetConfidence: 0,
    visited: new Map(),
    isBlacklisted: () => false,
    ...extra,
  };
}

describe('pickup valuation', () => {
  const me = pawn(1, v(0, 0.9, 0));

  it('values health by deficit and a better weapon by its priority', () => {
    expect(pickupValue(me, pickup(2, 'healthPack', v(5, 1, 0)), WEAPONS)).toBe(0);
    expect(
      pickupValue({ ...me, health: 40 }, pickup(2, 'healthPack', v(5, 1, 0)), WEAPONS),
    ).toBeCloseTo(0.6);
    const rocket = pickup(3, 'weapon', v(5, 1, 0), { weapon: 'rocket' });
    const shock = pickup(4, 'weapon', v(5, 1, 0), { weapon: 'shock' });
    expect(pickupValue(me, shock, WEAPONS)).toBeGreaterThan(pickupValue(me, rocket, WEAPONS));
    expect(
      pickupValue({ ...me, owned: ['assault', 'rocket'] }, rocket, WEAPONS),
    ).toBeLessThanOrEqual(0.3);
  });

  it('discounts far and recently visited pickups and skips what cannot be taken', () => {
    const near = pickup(2, 'shieldPack', v(5, 1, 0));
    const far = pickup(3, 'shieldPack', v(60, 1, 0));
    const full = pickup(4, 'healthPack', v(2, 1, 0));
    const c = ctx(me, [near, far, full]);
    const rated = ratePickups(c);
    expect(rated.map((o) => o.pickup.id)).toEqual([2, 3]);
    const visited = ratePickups({ ...c, visited: new Map([[2, 600 - TICK_RATE]]) });
    expect(visited[0]!.pickup.id).toBe(3);
  });

  it('plans around a respawn timer only with pickup timing skill', () => {
    const soon = pickup(2, 'shieldPack', v(5, 1, 0), { available: false, respawnAt: 600 + 60 });
    expect(ratePickups(ctx(me, [soon]))).toHaveLength(0);
    expect(ratePickups(ctx(me, [soon], { profile: skillProfile(5) }))).toHaveLength(1);
  });

  it('skips unreachable pickups when a reachability test is given', () => {
    const p = pickup(2, 'shieldPack', v(5, 1, 0));
    expect(ratePickups(ctx(me, [p], { canReach: () => false }))).toHaveLength(0);
  });
});

describe('goal selection', () => {
  const me = pawn(1, v(0, 0.9, 0));
  const memory = (visible: boolean): EnemyMemory => ({
    pawn: 2,
    position: v(0, 0.9, -15),
    velocity: v(0, 0, 0),
    tick: 600,
    visible,
    sightedAt: 500,
    source: 'sight',
  });

  it('heads for the best pickup when nothing else matters', () => {
    const g = chooseGoal(ctx(me, [pickup(2, 'shieldPack', v(5, 1, 0))]), null);
    expect(['roam', 'getShield']).toContain(g?.kind);
    expect(g?.pickup).toBe(2);
    const vial = pickup(3, 'healthVial', v(5, 1, 0));
    const roam = chooseGoal(ctx({ ...me, shield: 150 }, [vial]), null);
    expect(roam?.kind).toBe('roam');
    expect(roam?.pickup).toBe(3);
  });

  it('wants health when hurt and a weapon when it only has the spawn loadout', () => {
    const hurt = { ...me, health: 10 };
    const pack = pickup(2, 'healthPack', v(10, 1, 0));
    const shock = pickup(3, 'weapon', v(10, 1, 0), { weapon: 'shock' });
    expect(chooseGoal(ctx(hurt, [pack, shock]), null)?.kind).toBe('getHealth');
    expect(chooseGoal(ctx(me, [pack, shock]), null)?.kind).toBe('getWeapon');
  });

  it('attacks a visible enemy, hunts a remembered one, retreats when hurt and weaker', () => {
    const enemy = pawn(2, v(0, 0.9, -15), {
      shield: 150,
      owned: ['assault', 'shock'],
      ammo: { shock: 20 },
    });
    const pack = pickup(3, 'healthPack', v(10, 1, 0));
    const attack = chooseGoal(
      ctx(me, [enemy, pack], { target: memory(true), targetConfidence: 1 }),
      null,
    );
    expect(attack?.kind).toBe('attack');
    const hunt = chooseGoal(
      ctx(me, [enemy, pack], { target: memory(false), targetConfidence: 0.8 }),
      null,
    );
    expect(hunt?.kind).toBe('hunt');
    const hurt = { ...me, health: 25 };
    const retreat = chooseGoal(
      ctx(hurt, [enemy, pack], { target: memory(true), targetConfidence: 1 }),
      null,
    );
    expect(retreat?.kind).toBe('retreat');
    expect(retreat?.pickup).toBe(3);
  });

  it('camps the Redeemer only at Adept and above', () => {
    const redeemer = pickup(2, 'weapon', v(10, 1, 0), {
      weapon: 'redeemer',
      available: false,
      respawnAt: 600 + 5 * TICK_RATE,
    });
    const kinds = (skill: number): string[] =>
      scoreGoals(ctx(me, [redeemer], { profile: skillProfile(skill) })).map((g) => g.kind);
    expect(kinds(2)).not.toContain('campRedeemer');
    expect(kinds(4)).toContain('campRedeemer');
  });

  it('keeps the current goal unless another clearly beats it', () => {
    const a = pickup(2, 'shieldPack', v(8, 1, 0));
    const b = pickup(3, 'shieldPack', v(9, 1, 0));
    const c = ctx(me, [a, b]);
    const first = chooseGoal(c, null);
    expect(first?.pickup).toBe(2);
    const current = { ...first!, pickup: 3, position: b.position };
    expect(chooseGoal(c, current)?.pickup).toBe(3);
    expect(chooseGoal(c, current, 0)?.pickup).toBe(2);
  });

  it('respects zero weights', () => {
    const enemy = pawn(2, v(0, 0.9, -15));
    const g = chooseGoal(
      ctx(me, [enemy], { target: memory(true), targetConfidence: 1, weights: { attack: 0 } }),
      null,
    );
    expect(g?.kind).not.toBe('attack');
  });
});
