import { describe, expect, it } from 'vitest';
import {
  NO_ENTITY,
  TICK_RATE,
  type EntityState,
  type PawnState,
  type SimEvent,
  type Vec3,
  type WorldState,
} from '../../sim/types';
import { Perception } from './perception';
import { skillProfile } from './skill';
import type { BotSenses } from './types';

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
    owned: ['assault'],
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

function state(tick: number, entities: EntityState[]): WorldState {
  return {
    tick,
    time: tick / TICK_RATE,
    rngState: 0,
    entities,
    match: { phase: 'playing', fragLimit: 0, timeLimit: 0, elapsed: 0, scores: [], winner: null },
  };
}

/** Senses with a switchable wall; everything can be taken. */
function senses(blocked: () => boolean): BotSenses {
  return { canSee: () => !blocked(), canTake: () => true };
}

describe('perception', () => {
  const profile = skillProfile(2);
  // Yaw 0 looks down −z.
  const me = pawn(1, v(0, 0.9, 0));

  it('sees an enemy inside the cone with line of sight, not behind or beyond range', () => {
    let wall = false;
    const p = new Perception({ pawnId: 1, senses: senses(() => wall), profile, interval: 1 });
    const ahead = pawn(2, v(0, 0.9, -20));
    const behind = pawn(3, v(0, 0.9, 20));
    const far = pawn(4, v(0, 0.9, -(profile.visionRange + 5)));
    p.update(1, me, state(1, [me, ahead, behind, far]));
    expect(p.get(2)?.visible).toBe(true);
    expect(p.get(3)).toBeUndefined();
    expect(p.get(4)).toBeUndefined();
    wall = true;
    p.update(2, me, state(2, [me, ahead, behind, far]));
    expect(p.get(2)?.visible).toBe(false);
  });

  it('runs vision only on its scheduled ticks', () => {
    const p = new Perception({
      pawnId: 1,
      senses: senses(() => false),
      profile,
      interval: 6,
      phase: 0,
    });
    const ahead = pawn(2, v(0, 0.9, -20));
    p.update(1, me, state(1, [me, ahead]));
    expect(p.get(2)).toBeUndefined();
    p.update(6, me, state(6, [me, ahead]));
    expect(p.get(2)?.visible).toBe(true);
  });

  it('keeps a last-known position whose confidence decays over the memory window', () => {
    let wall = false;
    const p = new Perception({ pawnId: 1, senses: senses(() => wall), profile, interval: 1 });
    const enemy = pawn(2, v(0, 0.9, -20), { velocity: v(1, 0, 0) });
    p.update(10, me, state(10, [me, enemy]));
    wall = true;
    const moved = pawn(2, v(30, 0.9, -20));
    p.update(11, me, state(11, [me, moved]));
    const m = p.get(2)!;
    expect(m.visible).toBe(false);
    expect(m.position).toEqual(v(0, 0.9, -20));
    expect(m.velocity).toEqual(v(1, 0, 0));
    const half = 10 + (profile.memorySeconds * TICK_RATE) / 2;
    expect(p.confidence(m, half)).toBeCloseTo(0.5, 1);
    const gone = 10 + profile.memorySeconds * TICK_RATE + 1;
    p.update(gone, me, state(gone, [me, moved]));
    expect(p.get(2)).toBeUndefined();
  });

  it('forgets dead enemies and prefers a visible target over a memory', () => {
    const p = new Perception({ pawnId: 1, senses: senses(() => false), profile, interval: 1 });
    const near = pawn(2, v(0, 0.9, -10));
    const farther = pawn(3, v(0, 0.9, -30));
    p.update(1, me, state(1, [me, near, farther]));
    expect(p.target(1, me)?.pawn).toBe(2);
    const dead = pawn(2, v(0, 0.9, -10), { alive: false });
    p.update(2, me, state(2, [me, dead, farther]));
    expect(p.get(2)).toBeUndefined();
    expect(p.target(2, me)?.pawn).toBe(3);
  });

  it('hears weapon fire behind it within hearing range', () => {
    const p = new Perception({ pawnId: 1, senses: senses(() => false), profile, interval: 1 });
    const shooter = pawn(2, v(0, 0.9, 15));
    const s = state(1, [me, shooter]);
    p.update(1, me, s);
    expect(p.get(2)).toBeUndefined();
    const shot: SimEvent = {
      type: 'shotFired',
      tick: 1,
      pawn: 2,
      weapon: 'assault',
      mode: 'primary',
      origin: v(0, 2.5, 15),
      direction: v(0, 0, 1),
    };
    p.hear(1, me, [shot], s);
    const m = p.get(2)!;
    expect(m.source).toBe('sound');
    expect(m.visible).toBe(false);
    expect(m.position).toEqual(shooter.position);
    const silent = pawn(3, v(0, 0.9, profile.hearingRange + 10));
    p.hear(1, me, [{ ...shot, pawn: 3, origin: silent.position }], state(1, [me, shooter, silent]));
    expect(p.get(3)).toBeUndefined();
  });

  it('treats a new enemy projectile nearby as noise from its owner', () => {
    const p = new Perception({ pawnId: 1, senses: senses(() => false), profile, interval: 1 });
    const owner = pawn(2, v(0, 0.9, 12));
    const rocket: EntityState = {
      id: 9,
      kind: 'projectile',
      projectileType: 'rocket',
      owner: 2,
      position: v(0, 1, 8),
      velocity: v(0, 0, -30),
      orientation: { x: 0, y: 0, z: 0, w: 1 },
      health: 0,
      guided: false,
      landed: false,
      disrupted: false,
      detonateAt: 0,
    };
    p.update(1, me, state(1, [me, owner, rocket]));
    expect(p.get(2)?.source).toBe('sound');
    expect(p.get(2)?.position).toEqual(owner.position);
  });
});
