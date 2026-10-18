import { afterEach, describe, expect, it } from 'vitest';
import type { Brush, MapDef } from '../types';
import { HitMask, PhysicsWorld, type SensorEvent } from './physicsWorld';
import { rampLocalVertices, rotateVec, yawQuat } from './shapes';

const box = (position: Brush['position'], size: Brush['size'], yaw?: number): Brush => ({
  shape: 'box',
  position,
  size,
  yaw,
  material: 'grey',
});

/**
 * Box world:
 * 0: floor, 40 × 1 × 40, top face at y = 0
 * 1: wall at x = 10..12, 10 m tall
 * 2: ramp centered at z = -10, 4 wide, 2 tall, 8 long, rising toward +z
 * 3: cylinder pillar at (−10, 0, 0), diameter 2, height 6
 * 4: thin box rotated 90°: 10 long in local x, so 10 long in world z after yaw
 */
function boxMap(): MapDef {
  return {
    name: 'test-box',
    scale: 40,
    brushes: [
      box({ x: 0, y: -0.5, z: 0 }, { x: 40, y: 1, z: 40 }),
      box({ x: 11, y: 5, z: 0 }, { x: 2, y: 10, z: 40 }),
      {
        shape: 'ramp',
        position: { x: 0, y: 1, z: -10 },
        size: { x: 4, y: 2, z: 8 },
        material: 'grey',
      },
      {
        shape: 'cylinder',
        position: { x: -10, y: 3, z: 0 },
        size: { x: 2, y: 6, z: 0 },
        material: 'grey',
      },
      box({ x: 0, y: 1, z: 10 }, { x: 10, y: 2, z: 1 }, Math.PI / 2),
    ],
    props: [],
    spawns: [],
    pickups: [],
    jumpPads: [
      {
        position: { x: 5, y: 0.5, z: 5 },
        size: { x: 2, y: 1, z: 2 },
        launch: { x: 0, y: 20, z: 0 },
      },
    ],
    volumes: [
      { kind: 'kill', box: { min: { x: -2, y: 0, z: 3 }, max: { x: 2, y: 3, z: 7 } } },
      { kind: 'water', box: { min: { x: 0, y: 0, z: 3 }, max: { x: 4, y: 3, z: 7 } } },
    ],
    lights: [],
    navLinks: [],
    cameras: [],
    ambience: { loops: [], reverb: 'none' },
  };
}

const worlds: PhysicsWorld[] = [];

async function makeWorld(
  map: MapDef = boxMap(),
  opts?: Parameters<typeof PhysicsWorld.fromMap>[1],
) {
  const pw = await PhysicsWorld.fromMap(map, opts);
  worlds.push(pw);
  pw.step();
  return pw;
}

afterEach(() => {
  while (worlds.length) worlds.pop()?.dispose();
});

const DOWN = { x: 0, y: -1, z: 0 };

describe('shapes', () => {
  it('yawQuat turns +X toward −Z for positive yaw', () => {
    const v = rotateVec(yawQuat(Math.PI / 2), { x: 1, y: 0, z: 0 });
    expect(v.x).toBeCloseTo(0);
    expect(v.y).toBeCloseTo(0);
    expect(v.z).toBeCloseTo(-1);
  });

  it('ramp wedge has its top edge on local +Z', () => {
    const v = rampLocalVertices({ x: 2, y: 4, z: 6 });
    expect(v.length).toBe(18);
    // Last two vertices are the top edge.
    expect([v[13], v[14], v[16], v[17]]).toEqual([2, 3, 2, 3]);
  });
});

describe('raycast', () => {
  it('hits the floor top with an upward normal', async () => {
    const pw = await makeWorld();
    const hit = pw.raycast({ x: 0, y: 5, z: 0 }, DOWN, 100);
    expect(hit).not.toBeNull();
    expect(hit?.distance).toBeCloseTo(5);
    expect(hit?.point.y).toBeCloseTo(0);
    expect(hit?.normal.y).toBeCloseTo(1);
    expect(hit?.collider).toEqual({ kind: 'brush', index: 0 });
  });

  it('returns null when the hit is beyond maxDistance', async () => {
    const pw = await makeWorld();
    expect(pw.raycast({ x: 0, y: 5, z: 0 }, DOWN, 4.9)).toBeNull();
  });

  it('normalises the direction', async () => {
    const pw = await makeWorld();
    const hit = pw.raycast({ x: 0, y: 5, z: 0 }, { x: 0, y: -10, z: 0 }, 100);
    expect(hit?.distance).toBeCloseTo(5);
  });

  it('returns null for a zero direction', async () => {
    const pw = await makeWorld();
    expect(pw.raycast({ x: 0, y: 5, z: 0 }, { x: 0, y: 0, z: 0 }, 100)).toBeNull();
  });

  it('hits a wall side-on with a normal facing the ray', async () => {
    const pw = await makeWorld();
    const hit = pw.raycast({ x: 0, y: 2, z: 0 }, { x: 1, y: 0, z: 0 }, 100);
    expect(hit?.collider).toEqual({ kind: 'brush', index: 1 });
    expect(hit?.distance).toBeCloseTo(10);
    expect(hit?.normal.x).toBeCloseTo(-1);
  });

  it('hits a cylinder at its radius', async () => {
    const pw = await makeWorld();
    const hit = pw.raycast({ x: 0, y: 2, z: 0 }, { x: -1, y: 0, z: 0 }, 100);
    expect(hit?.collider).toEqual({ kind: 'brush', index: 3 });
    expect(hit?.distance).toBeCloseTo(9);
  });

  it('applies brush yaw', async () => {
    const pw = await makeWorld();
    // Rotated 90°, brush 4 spans z = 5..15 and x = −0.5..0.5.
    const along = pw.raycast({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }, 100);
    expect(along?.collider).toEqual({ kind: 'brush', index: 4 });
    expect(along?.distance).toBeCloseTo(5);
    const beside = pw.raycast({ x: 2, y: 1, z: 10 }, { x: -1, y: 0, z: 0 }, 100);
    expect(beside?.distance).toBeCloseTo(1.5);
  });

  it('ramp surface rises toward +z', async () => {
    const pw = await makeWorld();
    // Ramp spans z = −14..−6, y = 0..2.
    const low = pw.raycast({ x: 0, y: 10, z: -12 }, DOWN, 100);
    const high = pw.raycast({ x: 0, y: 10, z: -8 }, DOWN, 100);
    expect(low?.collider).toEqual({ kind: 'brush', index: 2 });
    expect(low?.point.y).toBeCloseTo(0.5);
    expect(high?.point.y).toBeCloseTo(1.5);
    // Slope normal leans toward −z (down the ramp).
    expect(high?.normal.z).toBeLessThan(0);
    expect(high?.normal.y).toBeGreaterThan(0);
  });

  it('hits actors, and skips the ignored actor', async () => {
    const pw = await makeWorld();
    pw.addActor(7, { x: 5, y: 1, z: 0 });
    pw.step();
    const origin = { x: 0, y: 1, z: 0 };
    const dir = { x: 1, y: 0, z: 0 };
    const hit = pw.raycast(origin, dir, 100);
    expect(hit?.collider).toEqual({ kind: 'actor', entity: 7 });
    expect(hit?.distance).toBeCloseTo(4.6);
    expect(pw.raycast(origin, dir, 100, { ignoreActor: 7 })?.collider).toEqual({
      kind: 'brush',
      index: 1,
    });
    expect(pw.raycast(origin, dir, 100, { mask: HitMask.World })?.collider.kind).toBe('brush');
  });

  it('ignores sensors unless asked', async () => {
    const pw = await makeWorld();
    const origin = { x: -1, y: 10, z: 5 };
    expect(pw.raycast(origin, DOWN, 100)?.collider.kind).toBe('brush');
    const hit = pw.raycast(origin, DOWN, 100, { mask: HitMask.Sensors });
    expect(hit?.collider).toMatchObject({
      kind: 'sensor',
      tag: { kind: 'volume', placementIndex: 0 },
    });
    expect(hit?.distance).toBeCloseTo(7);
  });

  it('sees actors only after step()', async () => {
    const pw = await makeWorld();
    pw.addActor(1, { x: 0, y: 1, z: -2 });
    pw.step();
    pw.setActorPosition(1, { x: 0, y: 1, z: 2 });
    const ray = () => pw.raycast({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }, 3);
    expect(ray()).toBeNull();
    pw.step();
    expect(ray()?.collider).toEqual({ kind: 'actor', entity: 1 });
  });
});

describe('castShape', () => {
  it('sphere stops radius short of the wall', async () => {
    const pw = await makeWorld();
    const hit = pw.castShape(
      { type: 'sphere', radius: 0.5 },
      { x: 0, y: 2, z: 0 },
      { x: 1, y: 0, z: 0 },
      100,
    );
    expect(hit?.collider).toEqual({ kind: 'brush', index: 1 });
    expect(hit?.distance).toBeCloseTo(9.5, 3);
    expect(hit?.position.x).toBeCloseTo(9.5, 3);
    expect(hit?.point.x).toBeCloseTo(10, 3);
    expect(hit?.normal.x).toBeCloseTo(-1);
    expect(hit?.startedInside).toBe(false);
  });

  it('capsule lands on the floor', async () => {
    const pw = await makeWorld();
    const hit = pw.castShape(
      { type: 'capsule', radius: 0.4, halfHeight: 0.5 },
      { x: 0, y: 10, z: 0 },
      DOWN,
      100,
    );
    // Capsule bottom is 0.9 below its center.
    expect(hit?.distance).toBeCloseTo(10 - 0.9, 3);
    expect(hit?.normal.y).toBeCloseTo(1);
  });

  it('box misses when the sweep is too short', async () => {
    const pw = await makeWorld();
    const shape = { type: 'box', halfExtents: { x: 0.5, y: 0.5, z: 0.5 } } as const;
    expect(pw.castShape(shape, { x: 0, y: 2, z: 0 }, { x: 1, y: 0, z: 0 }, 9)).toBeNull();
    expect(pw.castShape(shape, { x: 0, y: 2, z: 0 }, { x: 1, y: 0, z: 0 }, 10)).not.toBeNull();
  });

  it('reports a start-inside hit at distance 0', async () => {
    const pw = await makeWorld();
    const hit = pw.castShape({ type: 'sphere', radius: 0.5 }, { x: 0, y: 0.2, z: 0 }, DOWN, 5);
    expect(hit?.distance).toBe(0);
    expect(hit?.startedInside).toBe(true);
    expect(hit?.collider).toEqual({ kind: 'brush', index: 0 });
    expect(hit?.normal.y).toBeCloseTo(1);
  });

  it('treats resting contact as touching, not inside', async () => {
    const pw = await makeWorld();
    // Sphere sits exactly on the floor and slides toward the wall.
    const hit = pw.castShape(
      { type: 'sphere', radius: 0.5 },
      { x: 0, y: 0.5, z: 0 },
      { x: 1, y: 0, z: 0 },
      100,
      { mask: HitMask.World },
    );
    expect(hit?.startedInside).toBe(false);
    expect(hit?.collider).toEqual({ kind: 'brush', index: 1 });
    expect(hit?.distance).toBeCloseTo(9.5, 3);
  });

  it('blocks at once when moving into a touched surface', async () => {
    const pw = await makeWorld();
    const hit = pw.castShape({ type: 'sphere', radius: 0.5 }, { x: 0, y: 0.5, z: 0 }, DOWN, 5);
    expect(hit?.collider).toEqual({ kind: 'brush', index: 0 });
    expect(hit?.distance).toBeCloseTo(0, 3);
  });

  it('skips the mover itself', async () => {
    const pw = await makeWorld();
    pw.addActor(3, { x: 0, y: 3, z: 0 });
    pw.step();
    const shape = { type: 'capsule', radius: 0.4, halfHeight: 0.5 } as const;
    const hit = pw.castShape(shape, { x: 0, y: 3, z: 0 }, DOWN, 10, { ignoreActor: 3 });
    expect(hit?.collider).toEqual({ kind: 'brush', index: 0 });
    expect(hit?.distance).toBeCloseTo(2.1, 3);
  });
});

describe('overlap', () => {
  it('lists overlapping colliders in stable order', async () => {
    const pw = await makeWorld();
    pw.addActor(2, { x: 0.5, y: 1, z: 3.5 });
    pw.step();
    const tags = pw.overlap(
      { type: 'sphere', radius: 1 },
      { x: 0.5, y: 0.5, z: 3.5 },
      {
        mask: HitMask.World | HitMask.Actors | HitMask.Sensors,
      },
    );
    expect(tags.map((t) => t.kind)).toEqual(['brush', 'actor', 'sensor', 'sensor']);
    expect(tags[0]).toEqual({ kind: 'brush', index: 0 });
  });
});

describe('sensors', () => {
  it('reports enter once, nothing while inside, then exit', async () => {
    const pw = await makeWorld();
    pw.addActor(1, { x: -10, y: 1, z: 5 }); // outside both volumes
    expect(pw.step()).toEqual([]);

    pw.setActorPosition(1, { x: -1.5, y: 1, z: 5 }); // inside kill volume only
    const entered = pw.step();
    expect(entered).toEqual<SensorEvent[]>([
      { type: 'enter', actor: 1, sensor: 1, tag: { kind: 'volume', placementIndex: 0 } },
    ]);
    expect(pw.sensorsContaining(1)).toEqual([1]);

    pw.setActorPosition(1, { x: -1.2, y: 1, z: 5 });
    expect(pw.step()).toEqual([]);

    pw.setActorPosition(1, { x: -10, y: 1, z: 5 });
    expect(pw.step()).toEqual<SensorEvent[]>([
      { type: 'exit', actor: 1, sensor: 1, tag: { kind: 'volume', placementIndex: 0 } },
    ]);
    expect(pw.sensorsContaining(1)).toEqual([]);
  });

  it('orders events by actor, exits before enters, then sensor id', async () => {
    const pw = await makeWorld();
    pw.addActor(9, { x: -1.5, y: 1, z: 5 }); // kill only
    pw.addActor(4, { x: -10, y: 1, z: 5 });
    pw.step();

    pw.setActorPosition(9, { x: 3.5, y: 1, z: 5 }); // water only
    pw.setActorPosition(4, { x: 1, y: 1, z: 5 }); // kill and water overlap
    const events = pw.step().map((e) => `${e.type}:${e.actor}:${e.sensor}`);
    expect(events).toEqual(['enter:4:1', 'enter:4:2', 'exit:9:1', 'enter:9:2']);
  });

  it('jump pads from the map are sensors', async () => {
    const pw = await makeWorld();
    pw.addActor(1, { x: 5, y: 1, z: 5 });
    const [event] = pw.step();
    expect(event?.type).toBe('enter');
    expect(event?.tag).toEqual({ kind: 'jumpPad', placementIndex: 0 });
  });

  it('removing an actor or a sensor emits exits on the next step', async () => {
    const pw = await makeWorld();
    pw.addActor(1, { x: 1, y: 1, z: 5 });
    pw.addActor(2, { x: -1, y: 1, z: 5 });
    pw.step();
    pw.removeActor(1);
    pw.removeSensor(1);
    const events = pw.step().map((e) => `${e.type}:${e.actor}:${e.sensor}`);
    expect(events).toEqual(['exit:1:1', 'exit:1:2', 'exit:2:1']);
    expect(pw.step()).toEqual([]);
  });

  it('custom sensors work alongside map ones', async () => {
    const pw = await makeWorld();
    const id = pw.addSensor(
      { min: { x: 20, y: 0, z: 20 }, max: { x: 22, y: 2, z: 22 } },
      { kind: 'custom', name: 'pickup', entity: 42 },
    );
    pw.addActor(1, { x: 21, y: 1, z: 21 });
    expect(pw.step()).toEqual([
      { type: 'enter', actor: 1, sensor: id, tag: { kind: 'custom', name: 'pickup', entity: 42 } },
    ]);
  });

  it('is deterministic across worlds', async () => {
    const run = async () => {
      const pw = await makeWorld();
      const log: string[] = [];
      for (let id = 1; id <= 3; id++) pw.addActor(id, { x: -6 + id, y: 1, z: 5 });
      for (let t = 0; t < 60; t++) {
        for (let id = 1; id <= 3; id++) {
          pw.setActorPosition(id, { x: -6 + id + t * 0.2, y: 1, z: 5 });
        }
        for (const e of pw.step()) log.push(`${t}:${e.type}:${e.actor}:${e.sensor}`);
      }
      return log;
    };
    const a = await run();
    expect(a.length).toBeGreaterThan(0);
    expect(await run()).toEqual(a);
  });
});

describe('map loading', () => {
  it('rejects brushes with non-positive size', async () => {
    const map = boxMap();
    map.brushes.push(box({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 1 }));
    await expect(PhysicsWorld.fromMap(map)).rejects.toThrow(/Brush 5/);
  });

  it('builds props from supplied geometry and skips the rest', async () => {
    const map = boxMap();
    const prop = (collision: MapDef['props'][number]['collision']) => ({
      asset: 'crate',
      position: { x: -5, y: 0, z: -5 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 2, y: 2, z: 2 },
      collision,
    });
    map.props = [prop('box'), prop('none'), prop('box')];
    // Unit cube sitting on its base: y from 0 to 1 in asset space.
    // prettier-ignore
    const vertices = new Float32Array([
      -0.5, 0, -0.5,  0.5, 0, -0.5,  0.5, 0, 0.5,  -0.5, 0, 0.5,
      -0.5, 1, -0.5,  0.5, 1, -0.5,  0.5, 1, 0.5,  -0.5, 1, 0.5,
    ]);
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6]);
    const pw = await makeWorld(map, {
      propGeometry: (_p, index) => (index === 0 ? { vertices, indices } : undefined),
    });
    const hit = pw.raycast({ x: -5, y: 10, z: -5 }, DOWN, 100);
    expect(hit?.collider).toEqual({ kind: 'prop', index: 0 });
    expect(hit?.point.y).toBeCloseTo(2);
  });
});
