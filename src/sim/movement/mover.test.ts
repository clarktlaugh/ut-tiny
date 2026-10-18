import { afterEach, describe, expect, it } from 'vitest';
import { PhysicsWorld } from '../physics/physicsWorld';
import {
  Buttons,
  NULL_INPUT,
  TICK_DT,
  TICK_RATE,
  type Brush,
  type InputCommand,
  type MapDef,
  type SimEvent,
} from '../types';
import { createMovementConfig, type MovementConfig } from './config';
import { CharacterMover, createMoverState, feetPosition, pawnCapsule } from './mover';

const PAWN = 7;

const box = (position: Brush['position'], size: Brush['size']): Brush => ({
  shape: 'box',
  position,
  size,
  material: 'grey',
});

/**
 * Test arena (meters, +Y up). Floor top at y = 0. The pawn starts at the origin
 * facing −Z.
 *
 *  0: floor 80 × 1 × 80
 *  1: wall x = 10..12, 10 m tall, full depth
 *  2: step 0.45 m high, x = −7..−5, z = −3..3
 *  3: step 0.60 m high, x = −7..−5, z = 7..13
 *  4: platform 10 m high, x = 20..30, z = −30..30 (its top at y = 10)
 *  5: low ceiling 1.2 m above the floor over z = 20..24 (x = −2..2)
 *  6: ramp 2 m tall, 8 m long, rising toward +z, centered at z = −20
 *  7: step 0.30 m high, x = −17..−15, z = −3..3
 */
function arena(): MapDef {
  return {
    name: 'arena',
    scale: 40,
    brushes: [
      box({ x: 0, y: -0.5, z: 0 }, { x: 80, y: 1, z: 80 }),
      box({ x: 11, y: 5, z: 0 }, { x: 2, y: 10, z: 80 }),
      box({ x: -6, y: 0.225, z: 0 }, { x: 2, y: 0.45, z: 6 }),
      box({ x: -6, y: 0.3, z: 10 }, { x: 2, y: 0.6, z: 6 }),
      box({ x: 25, y: 5, z: 0 }, { x: 10, y: 10, z: 60 }),
      box({ x: 0, y: 1.45, z: 22 }, { x: 4, y: 0.5, z: 4 }),
      {
        shape: 'ramp',
        position: { x: 0, y: 1, z: -20 },
        size: { x: 4, y: 2, z: 8 },
        material: 'g',
      },
      box({ x: -16, y: 0.15, z: 0 }, { x: 2, y: 0.3, z: 6 }),
    ],
    props: [],
    spawns: [],
    pickups: [],
    jumpPads: [],
    volumes: [],
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

interface Rig {
  physics: PhysicsWorld;
  mover: CharacterMover;
  cfg: MovementConfig;
  state: ReturnType<typeof createMoverState>;
  tick: number;
  events: SimEvent[];
  fallDamage: number;
  /** Step `n` ticks with `input` (held). Returns the events of those ticks. */
  run(n: number, input?: Partial<InputCommand>): SimEvent[];
  /** Step one tick with `input`. */
  one(input?: Partial<InputCommand>): SimEvent[];
  feetY(): number;
}

/** Pawn standing on the floor at `at` (feet), settled, facing −Z. */
async function rig(
  at = { x: 0, y: 0, z: 0 },
  overrides: Partial<MovementConfig> = {},
): Promise<Rig> {
  const physics = await PhysicsWorld.fromMap(arena());
  worlds.push(physics);
  physics.step();
  const cfg = createMovementConfig(overrides);
  const mover = new CharacterMover(physics, cfg);
  const standing = pawnCapsule(false, cfg);
  const state = createMoverState({
    x: at.x,
    y: at.y + standing.radius + standing.halfHeight + 0.02,
    z: at.z,
  });
  mover.addPawn(PAWN, state);
  const r: Rig = {
    physics,
    mover,
    cfg,
    state,
    tick: 0,
    events: [],
    fallDamage: 0,
    run(n, input = {}) {
      const out: SimEvent[] = [];
      for (let i = 0; i < n; i++) out.push(...r.one(input));
      return out;
    },
    one(input = {}) {
      const res = mover.step(PAWN, state, { ...NULL_INPUT, ...input }, r.tick++);
      physics.step();
      r.events.push(...res.events);
      r.fallDamage += res.fallDamage;
      return res.events;
    },
    feetY: () => feetPosition(state, cfg).y,
  };
  // Settle onto the floor.
  r.run(3);
  r.events.length = 0;
  r.fallDamage = 0;
  return r;
}

const FORWARD = { moveY: 1 };
const JUMP = { buttons: Buttons.Jump };

const G = 19;
/** Ticks from takeoff to the apex of a jump. */
const APEX_TICKS = Math.round((6.8 / G) * TICK_RATE);

function speed(v: { x: number; z: number }): number {
  return Math.hypot(v.x, v.z);
}

describe('ground movement', () => {
  it('settles on the floor, grounded, a skin above it', async () => {
    const r = await rig();
    expect(r.state.grounded).toBe(true);
    expect(r.feetY()).toBeCloseTo(0.01, 2);
    expect(r.state.velocity.y).toBe(0);
  });

  it('reaches full ground speed within 0.15 s and caps at 8.8 m/s', async () => {
    const r = await rig();
    let ticksToFull = -1;
    for (let i = 0; i < 60; i++) {
      r.one(FORWARD);
      const s = speed(r.state.velocity);
      expect(s).toBeLessThanOrEqual(8.8 + 1e-9);
      if (ticksToFull < 0 && s >= 8.8 - 1e-6) ticksToFull = i + 1;
    }
    expect(ticksToFull).toBeGreaterThan(0);
    expect(ticksToFull * TICK_DT).toBeLessThanOrEqual(0.15 + 1e-9);
    expect(r.state.position.z).toBeLessThan(-7);
    expect(r.state.grounded).toBe(true);
  });

  it('is stopped by a wall and never penetrates it', async () => {
    const r = await rig({ x: 8, y: 0, z: 0 });
    r.run(90, { yaw: -Math.PI / 2, moveY: 1 }); // yaw −90° faces +X
    expect(r.state.position.x).toBeLessThanOrEqual(10 - 0.4 - 0.009);
    expect(r.state.position.x).toBeGreaterThan(9.5);
    expect(r.state.grounded).toBe(true);
    expect(speed(r.state.velocity)).toBeLessThan(0.5);
  });

  it('walks up a ramp', async () => {
    const r = await rig({ x: 0, y: 0, z: -26 });
    const before = r.feetY();
    r.run(60, { yaw: Math.PI, moveY: 1 }); // yaw 180° faces +Z
    expect(r.state.grounded).toBe(true);
    expect(r.feetY()).toBeGreaterThan(before + 1);
    expect(r.state.position.z).toBeGreaterThan(-22);
  });

  it('emits footsteps while walking and not while standing', async () => {
    const r = await rig();
    const walking = r.run(120, FORWARD).filter((e) => e.type === 'footstep');
    expect(walking.length).toBeGreaterThan(3);
    r.run(30);
    const standing = r.run(60).filter((e) => e.type === 'footstep');
    expect(standing).toHaveLength(0);
  });

  it('is deterministic', async () => {
    const script = (r: Rig) => {
      r.run(20, FORWARD);
      r.run(1, { ...FORWARD, ...JUMP });
      r.run(20, FORWARD);
      r.run(1, { ...FORWARD, ...JUMP });
      r.run(40, { moveX: 1 });
      return { ...r.state.position };
    };
    const a = script(await rig());
    const b = script(await rig());
    expect(a).toEqual(b);
  });
});

describe('jump', () => {
  it('leaves the ground on press, not on hold, and pulls with 19 m/s²', async () => {
    const r = await rig();
    const ev = r.one(JUMP);
    expect(ev).toContainEqual({ type: 'jump', tick: 3, pawn: PAWN, double: false });
    expect(r.state.grounded).toBe(false);
    const v0 = r.state.velocity.y;
    r.one(JUMP);
    expect(v0 - r.state.velocity.y).toBeCloseTo(G * TICK_DT);
    // Holding jump through the landing does not jump again.
    const later = r.run(60, JUMP);
    expect(later.filter((e) => e.type === 'jump')).toHaveLength(0);
    expect(later.filter((e) => e.type === 'land')).toHaveLength(1);
    expect(r.state.grounded).toBe(true);
  });

  it('apex is ~1.2 m above the takeoff height', async () => {
    const r = await rig();
    const start = r.feetY();
    r.one(JUMP);
    let apex = 0;
    let apexTick = 0;
    for (let i = 0; i < 60; i++) {
      r.one();
      const h = r.feetY() - start;
      if (h > apex) {
        apex = h;
        apexTick = i + 1;
      }
      if (r.state.grounded) break;
    }
    expect(apex).toBeGreaterThan(1.1);
    expect(apex).toBeLessThan(1.3);
    expect(Math.abs(apexTick - APEX_TICKS)).toBeLessThanOrEqual(1);
  });

  it('a second press near the apex double jumps to ~2.4 m total', async () => {
    const r = await rig();
    const start = r.feetY();
    r.one(JUMP);
    r.run(APEX_TICKS - 1);
    const ev = r.one(JUMP);
    expect(ev).toContainEqual(expect.objectContaining({ type: 'jump', double: true }));
    let apex = 0;
    for (let i = 0; i < 120 && !r.state.grounded; i++) {
      r.one();
      apex = Math.max(apex, r.feetY() - start);
    }
    expect(apex).toBeGreaterThan(2.2);
    expect(apex).toBeLessThan(2.6);
  });

  it('ignores a press while still rising fast and keeps the double jump for later', async () => {
    const r = await rig();
    r.one(JUMP);
    r.run(2);
    expect(r.state.velocity.y).toBeGreaterThan(r.cfg.doubleJumpRiseLimit);
    expect(r.one(JUMP).filter((e) => e.type === 'jump')).toHaveLength(0);
    r.run(APEX_TICKS - 4);
    expect(r.one(JUMP)).toContainEqual(expect.objectContaining({ type: 'jump', double: true }));
  });

  it('allows only one double jump per jump', async () => {
    const r = await rig();
    r.one(JUMP);
    r.run(APEX_TICKS);
    expect(r.one(JUMP)).toContainEqual(expect.objectContaining({ double: true }));
    r.run(APEX_TICKS);
    expect(r.one(JUMP).filter((e) => e.type === 'jump')).toHaveLength(0);
  });

  it('closes the double-jump window 0.75 s after the apex', async () => {
    // Jump off the 10 m platform so the pawn is still airborne when the window closes.
    const r = await rig({ x: 20.5, y: 10, z: 0 });
    r.run(1, { ...JUMP, yaw: Math.PI / 2, moveY: 1 }); // yaw +90° faces −X, off the edge
    r.run(APEX_TICKS + Math.round(0.75 * TICK_RATE) + 1, { yaw: Math.PI / 2, moveY: 1 });
    expect(r.state.grounded).toBe(false);
    expect(r.state.position.x).toBeLessThan(19.6);
    expect(r.one(JUMP).filter((e) => e.type === 'jump')).toHaveLength(0);
  });

  it('cannot double jump after walking off a ledge or after a dodge', async () => {
    const fall = await rig({ x: 20.5, y: 10, z: 0 });
    fall.run(10, { yaw: Math.PI / 2, moveY: 1 });
    expect(fall.state.grounded).toBe(false);
    expect(fall.state.airborne).toBe('fall');
    expect(fall.one(JUMP).filter((e) => e.type === 'jump')).toHaveLength(0);

    const dodged = await rig();
    dodged.one({ buttons: Buttons.DodgeForward });
    dodged.run(5);
    expect(dodged.state.grounded).toBe(false);
    expect(dodged.one(JUMP).filter((e) => e.type === 'jump')).toHaveLength(0);
  });

  it('bumps its head on a low ceiling', async () => {
    const r = await rig({ x: 0, y: 0, z: 22 });
    r.one(JUMP);
    let maxFeet = 0;
    for (let i = 0; i < 40; i++) {
      r.one();
      maxFeet = Math.max(maxFeet, r.feetY());
    }
    // Ceiling at 1.2 m, pawn 1.8 m tall: cannot rise more than a hair.
    expect(maxFeet).toBeLessThan(0.05);
  });
});

describe('dodge', () => {
  it('sets 12 m/s horizontal and 3.2 m/s vertical and emits a dodge event', async () => {
    const r = await rig();
    const ev = r.one({ buttons: Buttons.DodgeForward });
    expect(ev).toContainEqual({ type: 'dodge', tick: 3, pawn: PAWN, wall: false });
    expect(speed(r.state.velocity)).toBeCloseTo(12);
    expect(r.state.velocity.z).toBeCloseTo(-12);
    expect(r.state.velocity.y).toBeCloseTo(3.2);
    expect(r.state.grounded).toBe(false);
  });

  it('dodges sideways relative to the view', async () => {
    const r = await rig();
    r.one({ buttons: Buttons.DodgeRight, yaw: Math.PI / 2 }); // right of −X is −Z
    expect(r.state.velocity.z).toBeCloseTo(-12);
    expect(Math.abs(r.state.velocity.x)).toBeLessThan(1e-3);
  });

  it('is ignored during the 0.5 s cooldown and allowed after it', async () => {
    const r = await rig();
    r.one({ buttons: Buttons.DodgeForward });
    r.run(Math.round(0.5 * TICK_RATE) - 2);
    expect(r.state.grounded).toBe(true);
    const tooSoon = r.one({ buttons: Buttons.DodgeForward });
    expect(tooSoon.filter((e) => e.type === 'dodge')).toHaveLength(0);
    r.run(1);
    const ok = r.one({ buttons: Buttons.DodgeForward });
    expect(ok.filter((e) => e.type === 'dodge')).toHaveLength(1);
  });

  it('is not available while crouching', async () => {
    const r = await rig();
    r.run(2, { buttons: Buttons.Crouch });
    const ev = r.one({ buttons: Buttons.Crouch | Buttons.DodgeForward });
    expect(ev.filter((e) => e.type === 'dodge')).toHaveLength(0);
  });

  it('wall dodge needs a wall within 0.6 m behind the dodge, once per airborne period', async () => {
    // Stand 0.3 m from the wall face at x = 10 (capsule radius 0.4), facing away (−X).
    const r = await rig({ x: 10 - 0.4 - 0.3, y: 0, z: 0 }, { dodgeCooldown: 0 });
    const face = { yaw: Math.PI / 2 };
    r.one({ ...face, ...JUMP });
    r.run(3, face);
    const ev = r.one({ ...face, buttons: Buttons.DodgeForward });
    expect(ev).toContainEqual(expect.objectContaining({ type: 'dodge', wall: true }));
    expect(r.state.velocity.x).toBeCloseTo(-12);
    r.run(2, face);
    // Still within reach of the wall? Either way a second one is refused this flight.
    const again = r.one({ ...face, buttons: Buttons.DodgeBack });
    expect(again.filter((e) => e.type === 'dodge')).toHaveLength(0);
  });

  it('a dodge into a wall stops at the wall instead of pushing through it', async () => {
    const r = await rig({ x: 8, y: 0, z: 0 });
    const face = { yaw: -Math.PI / 2 }; // facing +X, toward the wall at x = 10
    r.one({ ...face, buttons: Buttons.DodgeForward });
    r.run(15, face);
    expect(r.state.position.x).toBeLessThanOrEqual(10 - 0.4 - 0.009);
    expect(Math.abs(r.state.velocity.x)).toBeLessThan(1e-3);
  });

  it('wall dodge is refused when no wall is near', async () => {
    const r = await rig({ x: 0, y: 0, z: 0 }, { dodgeCooldown: 0 });
    r.one(JUMP);
    r.run(3);
    const ev = r.one({ buttons: Buttons.DodgeForward });
    expect(ev.filter((e) => e.type === 'dodge')).toHaveLength(0);
  });

  it('wall dodge is refused when the wall is ahead rather than behind', async () => {
    const r = await rig({ x: 10 - 0.4 - 0.3, y: 0, z: 0 }, { dodgeCooldown: 0 });
    const face = { yaw: -Math.PI / 2 }; // facing +X, into the wall
    r.one({ ...face, ...JUMP });
    r.run(3, face);
    const ev = r.one({ ...face, buttons: Buttons.DodgeForward });
    expect(ev.filter((e) => e.type === 'dodge')).toHaveLength(0);
  });
});

describe('air control', () => {
  it('applies 35% of ground acceleration while airborne', async () => {
    const r = await rig();
    r.one(JUMP);
    r.one(FORWARD);
    const air = speed(r.state.velocity);
    const g = await rig();
    g.one(FORWARD);
    const ground = speed(g.state.velocity);
    expect(air / ground).toBeCloseTo(0.35, 5);
  });

  it('keeps dodge momentum while holding forward', async () => {
    const r = await rig();
    r.one({ buttons: Buttons.DodgeForward });
    r.run(5, FORWARD);
    expect(speed(r.state.velocity)).toBeCloseTo(12);
  });
});

describe('steps and ground snap', () => {
  const faceWest = { yaw: Math.PI / 2, moveY: 1 }; // −X

  it('steps up a 0.45 m ledge without losing horizontal speed', async () => {
    const r = await rig({ x: -2, y: 0, z: 0 });
    r.run(20, faceWest);
    const before = speed(r.state.velocity);
    expect(before).toBeCloseTo(8.8);
    let minSpeed = Infinity;
    let everAirborne = false;
    for (let i = 0; i < 15; i++) {
      r.one(faceWest);
      minSpeed = Math.min(minSpeed, speed(r.state.velocity));
      if (!r.state.grounded) everAirborne = true;
    }
    expect(r.state.position.x).toBeLessThan(-5.5);
    expect(r.state.position.x).toBeGreaterThan(-7);
    expect(r.feetY()).toBeCloseTo(0.45 + 0.01, 1);
    expect(minSpeed).toBeCloseTo(8.8, 1);
    expect(everAirborne).toBe(false);
    expect(r.events.filter((e) => e.type === 'land')).toHaveLength(0);
  });

  it('is blocked by a 0.6 m ledge', async () => {
    const r = await rig({ x: -2, y: 0, z: 10 });
    r.run(60, faceWest);
    expect(r.state.position.x).toBeGreaterThan(-5 + 0.4 - 0.02);
    expect(r.feetY()).toBeLessThan(0.1);
  });

  it('snaps to the ground when walking off a small drop', async () => {
    // Start on the 0.45 m step and walk west off its far edge.
    const r = await rig({ x: -6, y: 0.45, z: 0 });
    expect(r.feetY()).toBeCloseTo(0.46, 1);
    let everAirborne = false;
    for (let i = 0; i < 60; i++) {
      r.one(faceWest);
      if (!r.state.grounded) everAirborne = true;
    }
    expect(r.state.position.x).toBeLessThan(-8);
    expect(r.feetY()).toBeCloseTo(0.01, 1);
    expect(everAirborne).toBe(false);
    expect(r.events.filter((e) => e.type === 'land')).toHaveLength(0);
  });

  it('falls off a tall ledge', async () => {
    const r = await rig({ x: 20.5, y: 10, z: 0 });
    r.run(10, faceWest);
    expect(r.state.grounded).toBe(false);
    expect(r.state.airborne).toBe('fall');
    r.run(120, faceWest);
    expect(r.state.grounded).toBe(true);
    expect(r.feetY()).toBeCloseTo(0.01, 1);
    expect(r.events.filter((e) => e.type === 'land')).toHaveLength(1);
  });
});

describe('fall damage', () => {
  it('is zero for a drop below 20 m/s and rises to lethal at 35 m/s', async () => {
    // 10 m platform: v = sqrt(2·19·10) ≈ 19.5 m/s, just under the threshold.
    const low = await rig({ x: 20.5, y: 10, z: 0 });
    low.run(150, { yaw: Math.PI / 2, moveY: 1 });
    const land = low.events.find((e) => e.type === 'land');
    expect(land && land.type === 'land' ? land.impactSpeed : 0).toBeGreaterThan(19);
    expect(low.fallDamage).toBe(0);

    // From 25 m: v ≈ 30.8 m/s → ~72 damage.
    const high = await rig();
    high.mover.teleport(PAWN, high.state, { x: 0, y: 25 + 0.9, z: 0 });
    high.run(200);
    expect(high.fallDamage).toBeGreaterThan(60);
    expect(high.fallDamage).toBeLessThan(85);

    // From 35 m: v ≈ 36.5 m/s → lethal.
    const lethal = await rig();
    lethal.mover.teleport(PAWN, lethal.state, { x: 0, y: 35 + 0.9, z: 0 });
    lethal.run(240);
    expect(lethal.fallDamage).toBeGreaterThanOrEqual(100);
  });
});

describe('crouch', () => {
  it('halves the capsule height and the speed, keeping the feet planted', async () => {
    const r = await rig();
    const feet = r.feetY();
    r.run(30, { buttons: Buttons.Crouch, moveY: 1 });
    expect(r.state.crouching).toBe(true);
    const c = pawnCapsule(true, r.cfg);
    expect(2 * (c.radius + c.halfHeight)).toBeCloseTo(0.9);
    expect(r.feetY()).toBeCloseTo(feet, 1);
    expect(r.state.position.y).toBeCloseTo(0.45 + 0.01, 1);
    expect(speed(r.state.velocity)).toBeCloseTo(4.4);
    expect(r.state.grounded).toBe(true);
  });

  it('cannot stand up under a low ceiling but can once clear of it', async () => {
    const r = await rig({ x: 0, y: 0, z: 22 });
    r.run(2, { buttons: Buttons.Crouch });
    expect(r.state.crouching).toBe(true);
    r.run(2);
    expect(r.state.crouching).toBe(true);
    // Crawl out to +Z (yaw 180°) past z = 24 and stand.
    r.run(60, { yaw: Math.PI, moveY: 1, buttons: Buttons.Crouch });
    r.run(2, { yaw: Math.PI });
    expect(r.state.position.z).toBeGreaterThan(24.5);
    expect(r.state.crouching).toBe(false);
    expect(r.state.position.y).toBeCloseTo(0.9 + 0.01, 1);
  });

  it('resizes the physics capsule', async () => {
    const r = await rig();
    r.run(2, { buttons: Buttons.Crouch });
    const collider = r.physics.actorCollider(PAWN);
    expect(collider?.halfHeight()).toBeCloseTo(pawnCapsule(true, r.cfg).halfHeight);
    r.run(2);
    expect(collider?.halfHeight()).toBeCloseTo(0.5);
  });
});

describe('view and launch', () => {
  it('clamps pitch to just under ±90° and takes yaw as given', async () => {
    const r = await rig();
    r.one({ yaw: 2, pitch: 3 });
    expect(r.state.yaw).toBe(2);
    expect(r.state.pitch).toBeLessThan(Math.PI / 2);
    expect(r.state.pitch).toBeGreaterThan(Math.PI / 2 - 0.05);
    r.one({ pitch: -3 });
    expect(r.state.pitch).toBeGreaterThan(-Math.PI / 2);
  });

  it('launch() sets the velocity (jump pads) and forbids a double jump', async () => {
    const r = await rig();
    r.mover.launch(r.state, { x: 0, y: 20, z: -5 });
    r.one();
    expect(r.state.grounded).toBe(false);
    expect(r.state.airborne).toBe('launch');
    expect(r.state.velocity.y).toBeCloseTo(20 - G * TICK_DT);
    expect(r.state.velocity.z).toBeCloseTo(-5);
    r.run(Math.round((20 / G) * TICK_RATE));
    expect(r.one(JUMP).filter((e) => e.type === 'jump')).toHaveLength(0);
  });

  it('keeps the physics actor at the capsule center', async () => {
    const r = await rig();
    r.run(10, FORWARD);
    const p = r.physics.actorPosition(PAWN);
    expect(p?.x).toBeCloseTo(r.state.position.x, 5);
    expect(p?.y).toBeCloseTo(r.state.position.y, 5);
    expect(p?.z).toBeCloseTo(r.state.position.z, 5);
  });
});
