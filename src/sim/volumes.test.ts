import { afterEach, describe, expect, it } from 'vitest';
import { createMovementConfig } from './movement/config';
import { CharacterMover, createMoverState, feetPosition, pawnCapsule } from './movement/mover';
import { PhysicsWorld, type SensorEvent } from './physics/physicsWorld';
import { NULL_INPUT, NO_ENTITY, type MapDef, type SimEvent } from './types';
import { DEFAULT_KILL_MESSAGE, VolumeSystem, launchVelocityTo } from './volumes';

const PAWN = 5;

/**
 * Floor top at y = 0 (80 × 80). Pad 0 at x = 0..2 launches straight up and
 * forward; volume 0 kills over x = 10..14; volume 1 hurts 30/s over x = −14..−10;
 * volume 2 is water over x = −24..−20.
 */
function map(): MapDef {
  return {
    name: 'volumes',
    scale: 40,
    brushes: [
      {
        shape: 'box',
        position: { x: 0, y: -0.5, z: 0 },
        size: { x: 80, y: 1, z: 80 },
        material: 'g',
      },
    ],
    props: [],
    spawns: [],
    pickups: [],
    jumpPads: [
      {
        position: { x: 1, y: 0.25, z: 0 },
        size: { x: 2, y: 0.5, z: 2 },
        launch: { x: 0, y: 14, z: -6 },
      },
    ],
    volumes: [
      {
        kind: 'kill',
        box: { min: { x: 10, y: -1, z: -2 }, max: { x: 14, y: 3, z: 2 } },
        deathMessage: 'flushed',
      },
      {
        kind: 'damage',
        box: { min: { x: -14, y: -1, z: -2 }, max: { x: -10, y: 3, z: 2 } },
        damagePerSecond: 30,
      },
      { kind: 'water', box: { min: { x: -24, y: -1, z: -2 }, max: { x: -20, y: 3, z: 2 } } },
    ],
    lights: [],
    navLinks: [],
    cameras: [],
    ambience: { loops: [], reverb: 'none' },
  };
}

const worlds: PhysicsWorld[] = [];
afterEach(() => {
  while (worlds.length) worlds.pop()?.dispose();
});

/** A pawn standing at feet `x` on the floor, with a volume system wired like the world will. */
async function rig(x: number) {
  const physics = await PhysicsWorld.fromMap(map());
  worlds.push(physics);
  const cfg = createMovementConfig();
  const mover = new CharacterMover(physics, cfg);
  const cap = pawnCapsule(false, cfg);
  const state = createMoverState({ x, y: cap.radius + cap.halfHeight + 0.02, z: 0 });
  mover.addPawn(PAWN, state);
  const volumes = new VolumeSystem(map());
  let alive = true;
  let tick = 0;
  const events: SimEvent[] = [];
  const r = {
    physics,
    mover,
    cfg,
    state,
    volumes,
    events,
    kill: () => (alive = false),
    /** One world tick: move, step physics, run volumes, apply launches and kills. */
    step() {
      const res = mover.step(PAWN, state, NULL_INPUT, tick);
      const sensors: SensorEvent[] = physics.step();
      const out = volumes.update(tick, sensors, {
        isAlive: () => alive,
        entityFor: (kind, i) => (kind === 'jumpPad' ? 100 + i : 200 + i),
      });
      for (const l of out.launches) mover.launch(state, l.velocity);
      if (out.kills.length) alive = false;
      events.push(...res.events, ...out.events);
      tick++;
      return out;
    },
  };
  return r;
}

describe('jump pads', () => {
  it('launches a pawn entering the pad with the pad velocity and emits jumpPad', async () => {
    const r = await rig(1);
    const out = r.step();
    expect(out.launches).toEqual([
      { pawn: PAWN, placementIndex: 0, velocity: { x: 0, y: 14, z: -6 } },
    ]);
    expect(r.state.velocity).toEqual({ x: 0, y: 14, z: -6 });
    expect(r.state.airborne).toBe('launch');
    expect(r.state.grounded).toBe(false);
    expect(out.events).toEqual([{ type: 'jumpPad', tick: 0, pawn: PAWN, pad: 100 }]);

    // The pawn flies: apex ≈ v²/2g above the pad, and it does not re-trigger.
    let peak = 0;
    for (let i = 0; i < 120; i++) {
      r.step();
      peak = Math.max(peak, feetPosition(r.state, r.cfg).y);
    }
    const expected = (14 * 14) / (2 * r.cfg.gravity);
    expect(peak).toBeGreaterThan(expected * 0.9);
    expect(peak).toBeLessThan(expected * 1.1);
    expect(r.events.filter((e) => e.type === 'jumpPad')).toHaveLength(1);
  });

  it('does not launch dead pawns', async () => {
    const r = await rig(1);
    r.kill();
    const out = r.step();
    expect(out.launches).toEqual([]);
    expect(out.events).toEqual([]);
  });

  it('launchVelocityTo lands on the target', () => {
    const g = 19;
    const from = { x: 0, y: 0, z: 0 };
    const to = { x: 12, y: 4, z: -6 };
    const v = launchVelocityTo(from, to, 3, g);
    // Ballistic flight until y comes back down to the target height.
    const tUp = v.y / g;
    const tDown = Math.sqrt((2 * (4 + 3 - 4)) / g);
    const t = tUp + tDown;
    expect(from.x + v.x * t).toBeCloseTo(to.x, 6);
    expect(from.z + v.z * t).toBeCloseTo(to.z, 6);
    expect(from.y + v.y * t - 0.5 * g * t * t).toBeCloseTo(to.y, 6);
    expect((v.y * v.y) / (2 * g)).toBeCloseTo(7, 6);
  });
});

describe('kill volumes', () => {
  it('kills a live pawn inside with a death event carrying the message', async () => {
    const r = await rig(12);
    const out = r.step();
    expect(out.kills).toEqual([{ pawn: PAWN, placementIndex: 0, message: 'flushed' }]);
    expect(out.events).toEqual([
      {
        type: 'death',
        tick: 0,
        victim: PAWN,
        killer: NO_ENTITY,
        damageType: 'killVolume',
        weapon: null,
        message: 'flushed',
      },
    ]);
    // Dead pawns are not killed again.
    expect(r.step().events).toEqual([]);
    expect(r.events.filter((e) => e.type === 'death')).toHaveLength(1);
  });

  it('kills a pawn walking in, and uses the default message when none is set', () => {
    const v = new VolumeSystem({
      jumpPads: [],
      volumes: [{ kind: 'kill', box: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } } }],
    });
    const ctx = { isAlive: () => true };
    expect(v.update(0, [], ctx).events).toEqual([]);
    const enter: SensorEvent = {
      type: 'enter',
      actor: 3,
      sensor: 1,
      tag: { kind: 'volume', placementIndex: 0 },
    };
    const out = v.update(1, [enter], ctx);
    expect(out.events).toMatchObject([{ type: 'death', victim: 3, message: DEFAULT_KILL_MESSAGE }]);
  });

  it('a kill volume overrides a pad entered on the same tick', () => {
    const v = new VolumeSystem({
      jumpPads: [
        {
          position: { x: 0, y: 0, z: 0 },
          size: { x: 1, y: 1, z: 1 },
          launch: { x: 0, y: 10, z: 0 },
        },
      ],
      volumes: [{ kind: 'kill', box: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } } }],
    });
    const out = v.update(
      0,
      [
        { type: 'enter', actor: 3, sensor: 1, tag: { kind: 'volume', placementIndex: 0 } },
        { type: 'enter', actor: 3, sensor: 2, tag: { kind: 'jumpPad', placementIndex: 0 } },
      ],
      { isAlive: () => true },
    );
    expect(out.kills).toHaveLength(1);
    expect(out.launches).toEqual([]);
  });
});

describe('damage and water volumes', () => {
  it('deals damagePerSecond in whole points while inside, and stops on exit', async () => {
    const r = await rig(-12);
    let total = 0;
    for (let i = 0; i < 60; i++) {
      for (const d of r.step().damage) {
        expect(d).toMatchObject({ pawn: PAWN, placementIndex: 1 });
        expect(Number.isInteger(d.amount)).toBe(true);
        total += d.amount;
      }
    }
    expect(total).toBe(30);

    r.mover.teleport(PAWN, r.state, { x: 0, y: 2, z: 10 });
    r.step();
    expect(r.volumes.volumesContaining(PAWN)).toEqual([]);
    for (let i = 0; i < 30; i++) expect(r.step().damage).toEqual([]);
  });

  it('tracks water occupancy', async () => {
    const r = await rig(-22);
    r.step();
    expect(r.volumes.inWater(PAWN)).toBe(true);
    expect(r.volumes.isInside(PAWN, 'kill')).toBe(false);
    r.mover.teleport(PAWN, r.state, { x: 0, y: 2, z: 10 });
    r.step();
    expect(r.volumes.inWater(PAWN)).toBe(false);
  });
});
