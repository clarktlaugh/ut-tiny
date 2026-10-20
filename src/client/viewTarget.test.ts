import { describe, expect, it } from 'vitest';
import {
  NO_ENTITY,
  type PawnState,
  type ProjectileState,
  type Quat,
  type WorldState,
} from '../sim/types';
import { eyePosition } from '../sim/weapons/core/geometry';
import {
  DEFAULT_VIEW_TARGET_SETTINGS,
  DefaultViewTargetResolver,
  cameraPoseFor,
  quatForward,
} from './viewTarget';
import { cameraFov, defaultPixelRatio, verticalFov, wantsTouch } from './viewport';

function pawn(over: Partial<PawnState> = {}): PawnState {
  return {
    id: 1,
    kind: 'pawn',
    playerId: 'local',
    position: { x: 1, y: 2, z: 3 },
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    alive: true,
    health: 100,
    shield: 0,
    grounded: true,
    crouching: false,
    weapon: 'assault',
    pendingWeapon: null,
    owned: ['assault'],
    ammo: {},
    spawnProtectedUntil: 0,
    respawnAt: 0,
    guiding: NO_ENTITY,
    disc: NO_ENTITY,
    viewingDisc: false,
    zoom: 1,
    udamageUntil: 0,
    ...over,
  };
}

function projectile(over: Partial<ProjectileState> = {}): ProjectileState {
  return {
    id: 9,
    kind: 'projectile',
    projectileType: 'disc',
    owner: 1,
    position: { x: 10, y: 1, z: 0 },
    velocity: { x: 0, y: 0, z: -10 },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    health: 0,
    guided: false,
    landed: false,
    disrupted: false,
    detonateAt: 0,
    ...over,
  };
}

function state(...entities: WorldState['entities']): WorldState {
  return {
    tick: 0,
    time: 0,
    rngState: 0,
    entities,
    match: { phase: 'playing', scores: [], timeLeft: 0, winner: null } as never,
  };
}

const resolver = new DefaultViewTargetResolver();
const settings = DEFAULT_VIEW_TARGET_SETTINGS;
const look = { yaw: 0.4, pitch: -0.1 };

describe('DefaultViewTargetResolver', () => {
  it('looks through the pawn eyes, with the view model while alive', () => {
    const t = resolver.resolve(state(pawn()), 1, settings);
    expect(t).toMatchObject({ kind: 'pawn', entityId: 1, orientation: 'eye', showViewModel: true });
    expect(resolver.resolve(state(pawn({ zoom: 4 })), 1, settings).overlay).toBe('zoom');
    expect(resolver.resolve(state(pawn({ alive: false })), 1, settings).showViewModel).toBe(false);
  });

  it('is a spectator without a local pawn', () => {
    expect(resolver.resolve(state(), 1, settings).kind).toBe('spectator');
  });

  it('follows the guided warhead', () => {
    const warhead = projectile({ id: 7, projectileType: 'redeemer', guided: true });
    const t = resolver.resolve(state(pawn({ guiding: 7 }), warhead), 1, settings);
    expect(t).toMatchObject({ kind: 'warhead', orientation: 'nose', overlay: 'redeemerCam' });
    expect(t.showViewModel).toBe(false);
  });

  it('follows the disc while the disc camera is held', () => {
    const p = pawn({ disc: 9, viewingDisc: true });
    const flying = resolver.resolve(state(p, projectile()), 1, settings);
    expect(flying).toMatchObject({ kind: 'disc', orientation: 'velocity', mouseLook: false });
    expect(flying.listener).toBe('body');
    const landed = resolver.resolve(state(p, projectile({ landed: true })), 1, settings);
    expect(landed).toMatchObject({ orientation: 'freeLook', mouseLook: true });
    const disrupted = resolver.resolve(state(p, projectile({ disrupted: true })), 1, settings);
    expect(disrupted.overlay).toBe('static');
    // Disc gone: back to the eyes.
    expect(resolver.resolve(state(p), 1, settings).kind).toBe('pawn');
  });
});

describe('cameraPoseFor', () => {
  it('puts the camera at the eyes with the player look angles', () => {
    const p = pawn();
    const s = state(p);
    const target = resolver.resolve(s, 1, settings);
    const pose = cameraPoseFor({ target, state: s, position: undefined, look, previous: null })!;
    expect(pose.position).toEqual(eyePosition(p));
    expect(pose.yaw).toBe(look.yaw);
    expect(pose.pitch).toBe(look.pitch);
    const lerped = cameraPoseFor({
      target,
      state: s,
      position: { x: 5, y: 2, z: 3 },
      look,
      previous: null,
    })!;
    expect(lerped.position.x).toBe(5);
  });

  it('keeps the last pose while dead (death cam)', () => {
    const s = state(pawn({ alive: false }));
    const target = resolver.resolve(s, 1, settings);
    const previous = { position: { x: 1, y: 1, z: 1 }, yaw: 1, pitch: 0 };
    expect(cameraPoseFor({ target, state: s, position: undefined, look, previous })).toBe(previous);
    expect(cameraPoseFor({ target, state: s, position: undefined, look, previous: null })).toBe(
      null,
    );
  });

  it('looks along the disc velocity, keeping the last direction when slow', () => {
    const p = pawn({ disc: 9, viewingDisc: true });
    const s = state(p, projectile({ velocity: { x: -10, y: 0, z: 0 } }));
    const target = resolver.resolve(s, 1, settings);
    const pose = cameraPoseFor({ target, state: s, position: undefined, look, previous: null })!;
    expect(pose.position).toEqual({ x: 10, y: 1, z: 0 });
    expect(pose.yaw).toBeCloseTo(Math.PI / 2);
    const slow = state(p, projectile({ velocity: { x: 0, y: 0, z: 0.1 } }));
    const kept = cameraPoseFor({
      target: resolver.resolve(slow, 1, settings),
      state: slow,
      position: undefined,
      look,
      previous: pose,
    })!;
    expect(kept.yaw).toBeCloseTo(Math.PI / 2);
  });

  it('looks along the warhead nose', () => {
    const half = Math.PI / 4; // 90° about +Y: nose turns from −Z to −X.
    const q: Quat = { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
    const f = quatForward(q);
    expect(f.x).toBeCloseTo(-1);
    expect(f.z).toBeCloseTo(0);
    const s = state(
      pawn({ guiding: 7 }),
      projectile({ id: 7, projectileType: 'redeemer', orientation: q }),
    );
    const target = resolver.resolve(s, 1, settings);
    const pose = cameraPoseFor({ target, state: s, position: undefined, look, previous: null })!;
    expect(pose.yaw).toBeCloseTo(Math.PI / 2);
    expect(pose.pitch).toBeCloseTo(0);
  });
});

describe('viewport helpers', () => {
  it('converts horizontal FOV to vertical and caps portrait', () => {
    expect(verticalFov(90, 1)).toBeCloseTo(90);
    expect(cameraFov(100, 16 / 9)).toBeLessThan(100);
    expect(cameraFov(100, 0.45)).toBe(110);
    expect(cameraFov(100, Number.NaN)).toBeCloseTo(verticalFov(100, 16 / 9));
  });

  it('caps the pixel ratio and applies render scale', () => {
    expect(defaultPixelRatio(3, 1)).toBe(2);
    expect(defaultPixelRatio(1, 0.75)).toBe(0.75);
    expect(defaultPixelRatio(Number.NaN, 0)).toBe(1);
    expect(defaultPixelRatio(1, 0.1)).toBe(0.25);
  });

  it('chooses touch from the pointer with a query override', () => {
    expect(wantsTouch(true, '')).toBe(true);
    expect(wantsTouch(false, '')).toBe(false);
    expect(wantsTouch(false, '?touch=1')).toBe(true);
    expect(wantsTouch(true, '?touch=0')).toBe(false);
  });
});
