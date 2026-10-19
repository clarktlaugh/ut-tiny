import { describe, expect, it } from 'vitest';
import { Mesh, MeshStandardMaterial, PerspectiveCamera, BoxGeometry } from 'three';
import type {
  EntityState,
  PawnState,
  ProjectileState,
  SimEvent,
  Vec3,
  WorldState,
} from '../../sim/types';
import { TICK_DT } from '../../sim/types';
import { BEAM_LINGER } from '../../sim/weapons/shock';
import { ATLAS_CELLS, ATLAS_PX, Frame, buildAtlasPixels, cellAlpha, frameUv } from './atlas';
import { BeamPool } from './beams';
import { DECAL_FADE, DecalPool } from './decals';
import { FX_GRAVITY, ParticleLayer } from './particles';
import { FxSystem, DEFAULT_CAPACITIES } from './fxSystem';
import { GibPool } from './gibs';
import { RingPool, SlotPool } from './pool';
import { flatFloorProbe, raycastProbe } from './surface';
import { createAtlasTexture } from './atlas';
import { FX_CAMERAS, FX_SHOTS, LOOP_TICKS, MOMENTS, eventsAt, stateAt } from './timeline';
import { LAUNDRY_SKETCH } from '../scene/fixtures/laundrySketch';

const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };
const FWD: Vec3 = { x: 0, y: 0, z: -1 };

function pawn(id: number, overrides: Partial<PawnState> = {}): PawnState {
  return {
    id,
    kind: 'pawn',
    playerId: `p${id}`,
    position: { x: 0, y: 0.9, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    alive: true,
    health: 100,
    shield: 0,
    grounded: true,
    crouching: false,
    weapon: null,
    pendingWeapon: null,
    owned: [],
    ammo: {},
    spawnProtectedUntil: 0,
    respawnAt: 0,
    guiding: 0,
    disc: 0,
    viewingDisc: false,
    zoom: 1,
    udamageUntil: 0,
    ...overrides,
  };
}

function rocket(id: number, position: Vec3): ProjectileState {
  return {
    id,
    kind: 'projectile',
    projectileType: 'rocket',
    owner: 1,
    position,
    velocity: { x: 0, y: 0, z: -27 },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    health: 0,
    guided: false,
    landed: false,
    disrupted: false,
    detonateAt: 0,
  };
}

function state(tick: number, entities: EntityState[]): WorldState {
  return {
    tick,
    time: tick * TICK_DT,
    rngState: 0,
    entities,
    match: { phase: 'playing', fragLimit: 0, timeLimit: 0, elapsed: 0, scores: [], winner: null },
  };
}

const camera = new PerspectiveCamera();
camera.position.set(0, 2, 10);

/** One burst of everything the system reacts to. */
function burst(tick: number): SimEvent[] {
  return [
    {
      type: 'shotFired',
      tick,
      pawn: 1,
      weapon: 'assault',
      mode: 'primary',
      origin: { x: 0, y: 1.6, z: 0 },
      direction: FWD,
    },
    {
      type: 'hitscan',
      tick,
      pawn: 1,
      weapon: 'assault',
      from: { x: 0, y: 1.6, z: 0 },
      to: { x: 0, y: 1.6, z: -30 },
      hitPawn: 0,
      headshot: false,
    },
    {
      type: 'shotFired',
      tick,
      pawn: 1,
      weapon: 'shock',
      mode: 'primary',
      origin: { x: 0, y: 1.6, z: 0 },
      direction: FWD,
    },
    {
      type: 'hitscan',
      tick,
      pawn: 1,
      weapon: 'shock',
      from: { x: 0, y: 1.6, z: 0 },
      to: { x: 5, y: 1.6, z: -40 },
      hitPawn: 0,
      headshot: false,
    },
    {
      type: 'explosion',
      tick,
      position: { x: 3, y: 1, z: -20 },
      radius: 4.4,
      damageType: 'rocket',
      instigator: 1,
    },
    {
      type: 'explosion',
      tick,
      position: { x: 0, y: 5, z: -20 },
      radius: 50,
      damageType: 'redeemer',
      instigator: 1,
    },
    {
      type: 'damage',
      tick,
      target: 2,
      instigator: 1,
      amount: 40,
      damageType: 'rocket',
      momentum: { x: 0, y: 0, z: -5 },
    },
    { type: 'death', tick, victim: 2, killer: 1, damageType: 'rocket', weapon: 'rocket' },
    {
      type: 'teleport',
      tick,
      pawn: 1,
      from: { x: 0, y: 1, z: 0 },
      to: { x: 10, y: 1, z: 0 },
      telefragged: 0,
    },
    { type: 'land', tick, pawn: 1, impactSpeed: 15 },
    { type: 'jumpPad', tick, pawn: 1, pad: 7 },
    { type: 'pickupTaken', tick, pawn: 1, pickup: 9, pickupType: 'healthPack' },
  ];
}

const burstState = (tick: number): WorldState =>
  state(tick, [
    pawn(1),
    pawn(2, { position: { x: 4, y: 0.9, z: -6 } }),
    {
      id: 9,
      kind: 'pickup',
      position: { x: 2, y: 1, z: 2 },
      placementIndex: 0,
      type: 'healthPack',
      available: true,
      respawnAt: 0,
      takenBy: [],
    },
  ]);

describe('pools', () => {
  it('SlotPool hands out every slot once, then recycles the oldest', () => {
    const pool = new SlotPool(3);
    const a = pool.acquire();
    const b = pool.acquire();
    const c = pool.acquire();
    expect(new Set([a, b, c]).size).toBe(3);
    expect(pool.size).toBe(3);
    const d = pool.acquire();
    expect(d).toBe(a);
    expect(pool.recycled).toBe(1);
    expect(pool.size).toBe(3);
    expect(pool.oldest()).toBe(b);
    pool.release(b);
    expect(pool.size).toBe(2);
    expect(pool.isLive(b)).toBe(false);
    pool.release(b); // double release is a no-op
    expect(pool.size).toBe(2);
    expect(pool.acquire()).toBe(b); // the freed slot is reused first
    expect(pool.acquire()).toBe(c); // then the oldest live one is recycled
    expect(pool.recycled).toBe(2);
    pool.clear();
    expect(pool.size).toBe(0);
    expect(() => new SlotPool(0)).toThrow(RangeError);
  });

  it('RingPool wraps around', () => {
    const ring = new RingPool(2);
    expect([ring.next(), ring.next(), ring.next()]).toEqual([0, 1, 0]);
    expect(ring.size).toBe(2);
  });
});

describe('atlas', () => {
  it('builds a square RGBA sheet with opaque glow centers and empty cell corners', () => {
    const px = buildAtlasPixels();
    expect(px.length).toBe(ATLAS_PX * ATLAS_PX * 4);
    expect(cellAlpha(Frame.Glow, 0.5, 0.5)).toBeGreaterThan(0.95);
    expect(cellAlpha(Frame.Glow, 0.02, 0.02)).toBe(0);
    expect(cellAlpha(Frame.Ring, 0.5, 0.5)).toBe(0);
    expect(cellAlpha(Frame.Ring, 0.5 + 0.39, 0.5)).toBeGreaterThan(0.9);
    expect(cellAlpha(Frame.Hole, 0.5, 0.5)).toBe(1);
    expect(cellAlpha(Frame.Smoke, 0.5, 0.5)).toBeGreaterThan(0.4);
    const [u0, v0, u1, v1] = frameUv(Frame.Glow);
    expect(u0).toBeGreaterThan(0);
    expect(u1).toBeLessThan(1 / ATLAS_CELLS);
    expect(v0).toBeGreaterThan(1 - 1 / ATLAS_CELLS);
    expect(v1).toBeLessThan(1);
  });
});

describe('ParticleLayer', () => {
  it('integrates gravity and drag, ramps size and color, and dies on time', () => {
    const layer = new ParticleLayer('additive', createAtlasTexture(), 8);
    layer.emit({
      position: { x: 0, y: 10, z: 0 },
      velocity: { x: 1, y: 0, z: 0 },
      life: 1,
      size0: 1,
      size1: 3,
      color0: 0xff0000,
      color1: 0x0000ff,
      alpha0: 1,
      alpha1: 0,
      frame: Frame.Spark,
      rotation: 0,
      spin: 1,
      gravity: 1,
      drag: 0,
    });
    layer.update(0.5);
    const p = layer.positionAt(0, { x: 0, y: 0, z: 0 });
    expect(p.x).toBeCloseTo(0.5);
    expect(p.y).toBeCloseTo(10 - FX_GRAVITY * 0.5 * 0.5);
    const [, color, size, , rot] = layer.buffers() as Float32Array[];
    expect(color![0]).toBeCloseTo(0.5);
    expect(color![2]).toBeCloseTo(0.5);
    expect(color![3]).toBeCloseTo(0.5);
    expect(size![0]).toBeCloseTo(2);
    expect(rot![0]).toBeCloseTo(0.5);
    expect(layer.mesh.geometry.instanceCount).toBe(1);
    layer.update(0.6);
    expect(layer.size).toBe(0);
    expect(layer.mesh.geometry.instanceCount).toBe(0);
    layer.dispose();
  });

  it('keeps live particles dense at the front after deaths', () => {
    const layer = new ParticleLayer('alpha', createAtlasTexture(), 4);
    const spawn = (life: number, x: number): void =>
      layer.emit({
        position: { x, y: 0, z: 0 },
        velocity: ORIGIN,
        life,
        size0: 1,
        size1: 1,
        color0: 0xffffff,
        color1: 0xffffff,
        alpha0: 1,
        alpha1: 1,
        frame: 0,
        rotation: 0,
        spin: 0,
        gravity: 0,
        drag: 0,
      });
    spawn(0.1, 1);
    spawn(5, 2);
    spawn(0.1, 3);
    spawn(5, 4);
    layer.update(0.2);
    expect(layer.size).toBe(2);
    const pos = layer.buffers()[0] as Float32Array;
    const xs = [pos[0]!, pos[3]!].sort();
    expect(xs).toEqual([2, 4]);
    layer.dispose();
  });
});

describe('BeamPool', () => {
  it('tracers travel along the ray and die on arrival; lingering beams fade over their life', () => {
    const beams = new BeamPool(4);
    beams.emit({
      kind: 'tracer',
      from: ORIGIN,
      to: { x: 0, y: 0, z: -100 },
      width: 0.2,
      color: 0xffffff,
      coreColor: 0xffffff,
      life: 1,
      speed: 400,
      segment: 4,
    });
    beams.emit({
      kind: 'linger',
      from: ORIGIN,
      to: { x: 0, y: 0, z: -100 },
      width: 1,
      color: 0xffffff,
      coreColor: 0xffffff,
      life: BEAM_LINGER,
      speed: 1,
      segment: 1,
    });
    beams.update(0.1, { x: 5, y: 0, z: 0 });
    expect(beams.size).toBe(2);
    const spans = [beams.spanAt(0), beams.spanAt(1)];
    const tracer = spans.find((s) => s[1] < 100)!;
    expect(tracer[1]).toBeCloseTo(40);
    expect(tracer[0]).toBeCloseTo(36);
    const [pos] = beams.buffers() as Float32Array[];
    // Strips are offset sideways from the ray, never degenerate.
    expect(Math.abs(pos![0]!) + Math.abs(pos![1]!)).toBeGreaterThan(0.05);
    beams.update(0.2, { x: 5, y: 0, z: 0 });
    expect(beams.size).toBe(1); // the tracer arrived at 0.26 s
    beams.update(0.1, { x: 5, y: 0, z: 0 });
    expect(beams.size).toBe(0); // the beam lingered 0.3 s
    expect(beams.mesh.geometry.drawRange.count).toBe(0);
    beams.dispose();
  });
});

describe('DecalPool', () => {
  it('places quads on the surface, overwrites the oldest and fades at the end of life', () => {
    const decals = new DecalPool(createAtlasTexture(), 2);
    const place = (x: number): void =>
      decals.place({
        position: { x, y: 0, z: 0 },
        normal: { x: 0, y: 1, z: 0 },
        size: 1,
        frame: Frame.Hole,
        color: 0,
        alpha: 1,
        rotation: 0.3,
        life: 10,
      });
    place(1);
    place(2);
    const c = decals.centerAt(0, { x: 0, y: 0, z: 0 });
    expect(c.x).toBeCloseTo(1);
    expect(c.y).toBeGreaterThan(0); // lifted off the surface
    place(3);
    expect(decals.size).toBe(2);
    expect(decals.centerAt(0, { x: 0, y: 0, z: 0 }).x).toBeCloseTo(3);
    decals.update(10 * (1 - DECAL_FADE) + 10 * DECAL_FADE * 0.5);
    expect(decals.alphaAt(0)).toBeCloseTo(0.5, 1);
    decals.update(10);
    expect(decals.alphaAt(0)).toBe(0);
    decals.dispose();
  });
});

describe('GibPool', () => {
  it('chunks fall under gravity and come to rest on their floor', () => {
    const gibs = new GibPool(4);
    gibs.emit({
      position: { x: 0, y: 5, z: 0 },
      velocity: { x: 2, y: 0, z: 0 },
      spin: { x: 1, y: 2, z: 3 },
      size: 1,
      color: 0xff0000,
      life: 10,
      floorY: 0,
    });
    const p = { x: 0, y: 0, z: 0 };
    gibs.update(0.5);
    gibs.positionAt(0, p);
    expect(p.y).toBeCloseTo(5 - FX_GRAVITY * 0.5 * 0.5, 1);
    expect(p.x).toBeCloseTo(1);
    for (let i = 0; i < 200; i++) gibs.update(1 / 60);
    gibs.positionAt(0, p);
    expect(p.y).toBeGreaterThanOrEqual(0);
    expect(p.y).toBeLessThan(0.3);
    gibs.update(10);
    expect(gibs.size).toBe(0);
    gibs.dispose();
  });
});

describe('surface probes', () => {
  it('flat floor and raycast probes return the hit point and normal', () => {
    const floor = flatFloorProbe(1);
    const hit = floor({ x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, 10)!;
    expect(hit.point.y).toBe(1);
    expect(hit.normal.y).toBe(1);
    expect(floor({ x: 0, y: 5, z: 0 }, { x: 0, y: 1, z: 0 }, 10)).toBeNull();
    expect(floor({ x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, 2)).toBeNull();

    const wall = new Mesh(new BoxGeometry(10, 10, 1), new MeshStandardMaterial());
    wall.position.set(0, 0, -10);
    wall.updateMatrixWorld(true);
    const probe = raycastProbe([wall]);
    const h = probe({ x: 0, y: 0, z: 0 }, FWD, 50)!;
    expect(h.point.z).toBeCloseTo(-9.5);
    expect(h.normal.z).toBeCloseTo(1);
    expect(probe({ x: 0, y: 0, z: 0 }, FWD, 5)).toBeNull();
  });
});

describe('FxSystem', () => {
  it('spawns something for every weapon and world event', () => {
    const fx = new FxSystem({ seed: 1, surface: flatFloorProbe(0) });
    fx.update(0, camera, burstState(0));
    fx.handleEvents(burst(0), burstState(0));
    const s = fx.stats();
    expect(s.light).toBeGreaterThan(50);
    expect(s.matter).toBeGreaterThan(20);
    expect(s.beams).toBe(2); // one tracer, one lingering beam
    expect(s.flashes).toBeGreaterThan(0);
    expect(s.flashes).toBeLessThanOrEqual(DEFAULT_CAPACITIES.flashes);
    expect(s.decals).toBeGreaterThan(0); // scorch marks on the floor
    expect(s.gibs).toBe(10);
    expect(fx.screenFlash.intensity).toBeGreaterThan(0.5); // the camera was 25 m from the nuke
    fx.update(1.5, camera, burstState(1));
    expect(fx.screenFlash.intensity).toBe(0);
    fx.dispose();
  });

  it('lingering shock beam lasts BEAM_LINGER and no longer', () => {
    const fx = new FxSystem({ seed: 1 });
    fx.handleEvents([burst(0)[3]!]);
    const ticks = Math.round(BEAM_LINGER / TICK_DT);
    for (let i = 0; i < ticks - 1; i++) fx.update(TICK_DT, camera);
    expect(fx.beams.size).toBe(1);
    fx.update(TICK_DT * 1.01, camera);
    expect(fx.beams.size).toBe(0);
    fx.dispose();
  });

  it('bullet holes land on the surface the shot hit', () => {
    const wall = new Mesh(new BoxGeometry(20, 20, 1), new MeshStandardMaterial());
    wall.position.set(0, 0, -10.5);
    wall.updateMatrixWorld(true);
    const fx = new FxSystem({ seed: 1, surface: raycastProbe([wall]) });
    fx.handleEvents([
      {
        type: 'hitscan',
        tick: 0,
        pawn: 1,
        weapon: 'assault',
        from: { x: 0, y: 0, z: 0 },
        to: { x: 0, y: 0, z: -10 },
        hitPawn: 0,
        headshot: false,
      },
    ]);
    expect(fx.decals.size).toBe(1);
    const c = fx.decals.centerAt(0, { x: 0, y: 0, z: 0 });
    expect(c.z).toBeCloseTo(-10 + 0.03, 3);
    fx.dispose();
  });

  it('emits trails along projectile paths and forgets destroyed projectiles', () => {
    const fx = new FxSystem({ seed: 1 });
    fx.update(TICK_DT, camera, state(0, [rocket(5, { x: 0, y: 2, z: 0 })]));
    const before = fx.stats();
    fx.update(TICK_DT, camera, state(1, [rocket(5, { x: 0, y: 2, z: -5 })]));
    const after = fx.stats();
    expect(after.matter - before.matter).toBe(9); // 5 m at 0.6 m spacing: 0, 0.6, …, 4.8
    expect(after.light).toBeGreaterThan(0); // head glow
    fx.handleEvents([{ type: 'entityDestroyed', tick: 2, id: 5, kind: 'projectile' }]);
    fx.update(TICK_DT, camera, state(2, []));
    expect(fx.stats().matter).toBe(9);
    fx.dispose();
  });

  it('is deterministic for a seed: same events, same buffers', () => {
    const run = (): Float32Array => {
      const fx = new FxSystem({ seed: 42, surface: flatFloorProbe(0) });
      for (let tick = 0; tick < 30; tick++) {
        fx.handleEvents(tick % 10 === 0 ? burst(tick) : [], burstState(tick));
        fx.update(TICK_DT, camera, burstState(tick));
      }
      const copy = new Float32Array(fx.light.buffers()[0] as Float32Array);
      fx.dispose();
      return copy;
    };
    expect(run()).toEqual(run());
  });

  it('never allocates after warm-up: pools, buffers and scene objects are fixed', () => {
    const fx = new FxSystem({ seed: 7, surface: flatFloorProbe(0) });
    const buffers = [
      ...fx.light.buffers(),
      ...fx.matter.buffers(),
      ...fx.beams.buffers(),
      ...fx.decals.buffers(),
      fx.gibs.mesh.instanceMatrix.array,
      fx.gibs.mesh.instanceColor!.array,
    ];
    const lights = [0, 1, 2, 3].map((i) => fx.flashes.root.children[i]);
    const sizes = buffers.map((b) => b.byteLength);
    // Warm up: three bursts and a second of updates.
    for (let tick = 0; tick < 60; tick++) {
      fx.handleEvents(tick % 20 === 0 ? burst(tick) : [], burstState(tick));
      fx.update(TICK_DT, camera, burstState(tick));
    }
    const warm = fx.stats();
    const cap = fx.capacities;
    // Hammer it: far more than any pool can hold.
    for (let tick = 60; tick < 360; tick++) {
      fx.handleEvents(tick % 3 === 0 ? burst(tick) : [], burstState(tick));
      fx.update(TICK_DT, camera, burstState(tick));
      const s = fx.stats();
      expect(s.light).toBeLessThanOrEqual(cap.light);
      expect(s.matter).toBeLessThanOrEqual(cap.matter);
      expect(s.beams).toBeLessThanOrEqual(cap.beams);
      expect(s.flashes).toBeLessThanOrEqual(cap.flashes);
      expect(s.decals).toBeLessThanOrEqual(cap.decals);
      expect(s.gibs).toBeLessThanOrEqual(cap.gibs);
    }
    const hot = fx.stats();
    expect(hot.allocations).toBe(warm.allocations);
    expect(hot.children).toBe(warm.children);
    expect(hot.recycled).toBeGreaterThan(0); // the pools really did overflow
    // The very same typed arrays and lights are still in use.
    const buffersNow = [
      ...fx.light.buffers(),
      ...fx.matter.buffers(),
      ...fx.beams.buffers(),
      ...fx.decals.buffers(),
      fx.gibs.mesh.instanceMatrix.array,
      fx.gibs.mesh.instanceColor!.array,
    ];
    buffersNow.forEach((b, i) => {
      expect(b).toBe(buffers[i]);
      expect(b.byteLength).toBe(sizes[i]);
    });
    [0, 1, 2, 3].forEach((i) => expect(fx.flashes.root.children[i]).toBe(lights[i]));
    expect(fx.light.mesh.geometry.instanceCount).toBe(hot.light);
    fx.dispose();
  });

  it('clear and dispose leave nothing live; updates after dispose are no-ops', () => {
    const fx = new FxSystem({ seed: 1 });
    fx.handleEvents(burst(0), burstState(0));
    fx.clear();
    const s = fx.stats();
    expect([s.light, s.matter, s.beams, s.flashes, s.decals, s.gibs]).toEqual([0, 0, 0, 0, 0, 0]);
    fx.dispose();
    fx.dispose();
    fx.handleEvents(burst(1), burstState(1));
    fx.update(TICK_DT, camera);
    expect(fx.stats().light).toBe(0);
  });
});

describe('demo timeline', () => {
  it('is a pure function of the tick and fires every weapon', () => {
    const seen = new Set<string>();
    for (let tick = 0; tick < LOOP_TICKS; tick++) {
      expect(eventsAt(tick)).toEqual(eventsAt(tick + LOOP_TICKS));
      for (const e of eventsAt(tick)) {
        seen.add(e.type);
        if (e.type === 'shotFired') seen.add(`weapon:${e.weapon}`);
        if (e.type === 'explosion') seen.add(`explosion:${e.damageType}`);
      }
    }
    for (const want of [
      'shotFired',
      'hitscan',
      'explosion',
      'damage',
      'death',
      'respawn',
      'teleport',
      'land',
      'jumpPad',
      'pickupTaken',
      'weapon:assault',
      'weapon:rocket',
      'weapon:shock',
      'weapon:redeemer',
      'explosion:rocket',
      'explosion:grenade',
      'explosion:redeemer',
    ]) {
      expect(seen.has(want), want).toBe(true);
    }
    // Projectiles exist exactly between launch and arrival.
    const before = stateAt(MOMENTS.rocketFire - 1).entities.some((e) => e.id === 10);
    const during = stateAt(MOMENTS.rocketFire + 10).entities.some((e) => e.id === 10);
    const after = stateAt(MOMENTS.rocketHit).entities.some((e) => e.id === 10);
    expect([before, during, after]).toEqual([false, true, false]);
  });

  it('screenshot cameras exist and every shot tick has live effects within capacity', () => {
    const names = new Set([...LAUNDRY_SKETCH.cameras, ...FX_CAMERAS].map((c) => c.name));
    for (const shot of FX_SHOTS) expect(names.has(shot.camera), shot.camera).toBe(true);
    const fx = new FxSystem({ seed: 16, surface: flatFloorProbe(0) });
    const shotTicks = new Map(FX_SHOTS.map((s) => [s.tick, s.camera]));
    const cap = fx.capacities;
    for (let tick = 0; tick < LOOP_TICKS; tick++) {
      const state = stateAt(tick);
      fx.handleEvents(eventsAt(tick), state);
      fx.update(TICK_DT, camera, state);
      const s = fx.stats();
      expect(s.light).toBeLessThanOrEqual(cap.light);
      expect(s.matter).toBeLessThanOrEqual(cap.matter);
      if (shotTicks.has(tick)) {
        expect(
          s.light + s.matter + s.beams + s.gibs,
          `${shotTicks.get(tick)}@${tick}`,
        ).toBeGreaterThan(0);
      }
    }
    fx.dispose();
  });
});
