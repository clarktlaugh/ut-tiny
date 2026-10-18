import { describe, expect, it } from 'vitest';
import { Buttons, NULL_INPUT } from '../types';
import { DEFAULT_MOVEMENT, createMovementConfig } from './config';
import {
  PITCH_LIMIT,
  accelerateAir,
  accelerateGround,
  clampPitch,
  dodgeDirection,
  fallDamage,
  forwardVector,
  groundAcceleration,
  isWalkable,
  rightVector,
  wishDirection,
} from './kinematics';

const cfg = createMovementConfig();

describe('view vectors', () => {
  it('yaw 0 faces −Z with +X on the right (Three.js camera convention)', () => {
    expect(forwardVector(0)).toEqual({ x: -0, y: 0, z: -1 });
    expect(rightVector(0)).toEqual({ x: 1, y: 0, z: -0 });
  });

  it('positive yaw turns forward toward −X', () => {
    const f = forwardVector(Math.PI / 2);
    expect(f.x).toBeCloseTo(-1);
    expect(f.z).toBeCloseTo(0);
  });

  it('pitch is clamped to just under ±90°', () => {
    expect(clampPitch(10)).toBe(PITCH_LIMIT);
    expect(clampPitch(-10)).toBe(-PITCH_LIMIT);
    expect(clampPitch(0.5)).toBe(0.5);
    expect(clampPitch(NaN)).toBe(0);
    expect(PITCH_LIMIT).toBeLessThan(Math.PI / 2);
    expect(PITCH_LIMIT).toBeGreaterThan(Math.PI / 2 - 0.05);
  });
});

describe('wishDirection', () => {
  it('maps moveY to forward and moveX to right', () => {
    const fwd = wishDirection({ ...NULL_INPUT, moveY: 1 }, 0);
    expect(fwd.z).toBeCloseTo(-1);
    const right = wishDirection({ ...NULL_INPUT, moveX: 1 }, 0);
    expect(right.x).toBeCloseTo(1);
  });

  it('clamps diagonals to unit length and axes to ±1', () => {
    const diag = wishDirection({ ...NULL_INPUT, moveX: 1, moveY: 1 }, 0);
    expect(Math.hypot(diag.x, diag.z)).toBeCloseTo(1);
    const big = wishDirection({ ...NULL_INPUT, moveY: 5 }, 0);
    expect(Math.hypot(big.x, big.z)).toBeCloseTo(1);
  });

  it('is zero with no input', () => {
    expect(wishDirection(NULL_INPUT, 1.3)).toEqual({ x: 0, y: 0, z: 0 });
  });
});

describe('dodgeDirection', () => {
  it('returns the horizontal unit vector for each dodge bit', () => {
    expect(dodgeDirection(Buttons.DodgeForward, 0)?.z).toBeCloseTo(-1);
    expect(dodgeDirection(Buttons.DodgeBack, 0)?.z).toBeCloseTo(1);
    expect(dodgeDirection(Buttons.DodgeLeft, 0)?.x).toBeCloseTo(-1);
    expect(dodgeDirection(Buttons.DodgeRight, 0)?.x).toBeCloseTo(1);
  });

  it('returns null without a dodge bit', () => {
    expect(dodgeDirection(Buttons.Jump | Buttons.Fire, 0)).toBeNull();
  });
});

describe('acceleration', () => {
  const dt = 1 / 60;

  it('ground acceleration reaches full speed in groundAccelTime', () => {
    const accel = groundAcceleration(cfg);
    expect(accel).toBeCloseTo(8.8 / 0.15);
    let v = { x: 0, y: 0, z: 0 };
    const wish = { x: 0, y: 0, z: -1 };
    let ticks = 0;
    while (Math.hypot(v.x, v.z) < cfg.groundSpeed - 1e-9) {
      v = accelerateGround(v, wish, cfg.groundSpeed, accel, dt);
      ticks++;
    }
    expect(ticks * dt).toBeLessThanOrEqual(0.15 + 1e-9);
    expect(Math.hypot(v.x, v.z)).toBeCloseTo(cfg.groundSpeed);
  });

  it('ground speed never exceeds the cap', () => {
    let v = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 120; i++) {
      v = accelerateGround(v, { x: 0.7, y: 0, z: -0.7 }, cfg.groundSpeed, 100, dt);
      expect(Math.hypot(v.x, v.z)).toBeLessThanOrEqual(cfg.groundSpeed + 1e-9);
    }
  });

  it('brakes to a stop at the same rate', () => {
    let v = { x: 8.8, y: 0, z: 0 };
    v = accelerateGround(v, { x: 0, y: 0, z: 0 }, cfg.groundSpeed, groundAcceleration(cfg), 0.15);
    expect(v.x).toBeCloseTo(0);
  });

  it('air control only adds speed up to the cap along the wish direction', () => {
    const accel = groundAcceleration(cfg) * cfg.airControl;
    const slow = accelerateAir({ x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: -1 }, 8.8, accel, dt);
    expect(-slow.z).toBeCloseTo(accel * dt);
    expect(slow.y).toBe(-1);
    // Dodge speed along the wish direction is kept, not pulled back to 8.8.
    const fast = accelerateAir({ x: 0, y: 0, z: -12 }, { x: 0, y: 0, z: -1 }, 8.8, accel, dt);
    expect(fast.z).toBe(-12);
    // But a sideways wish still steers.
    const steer = accelerateAir({ x: 0, y: 0, z: -12 }, { x: 1, y: 0, z: 0 }, 8.8, accel, dt);
    expect(steer.x).toBeCloseTo(accel * dt);
  });
});

describe('isWalkable', () => {
  it('accepts floors and gentle slopes, rejects walls', () => {
    expect(isWalkable({ x: 0, y: 1, z: 0 }, cfg)).toBe(true);
    const slope30 = { x: Math.sin(Math.PI / 6), y: Math.cos(Math.PI / 6), z: 0 };
    expect(isWalkable(slope30, cfg)).toBe(true);
    const slope60 = { x: Math.sin(Math.PI / 3), y: Math.cos(Math.PI / 3), z: 0 };
    expect(isWalkable(slope60, cfg)).toBe(false);
    expect(isWalkable({ x: 1, y: 0, z: 0 }, cfg)).toBe(false);
  });
});

describe('fallDamage', () => {
  it('starts at 20 m/s and is lethal at 35 m/s', () => {
    expect(fallDamage(0, cfg)).toBe(0);
    expect(fallDamage(19.9, cfg)).toBe(0);
    expect(fallDamage(20, cfg)).toBe(0);
    expect(fallDamage(27.5, cfg)).toBe(50);
    expect(fallDamage(35, cfg)).toBe(100);
    expect(fallDamage(50, cfg)).toBeGreaterThan(100);
    expect(fallDamage(NaN, cfg)).toBe(0);
  });
});

describe('config', () => {
  it('defaults match §4', () => {
    expect(DEFAULT_MOVEMENT).toMatchObject({
      groundSpeed: 8.8,
      gravity: 19,
      jumpSpeed: 6.8,
      dodgeSpeed: 12,
      dodgeUpSpeed: 3.2,
      dodgeCooldown: 0.5,
      wallDodgeDistance: 0.6,
      airControl: 0.35,
      stepHeight: 0.45,
      fallDamageMinSpeed: 20,
      fallDamageLethalSpeed: 35,
    });
    expect(Object.isFrozen(DEFAULT_MOVEMENT)).toBe(true);
  });

  it('createMovementConfig returns an independent mutable copy', () => {
    const c = createMovementConfig({ gravity: 10 });
    expect(c.gravity).toBe(10);
    c.jumpSpeed = 1;
    expect(DEFAULT_MOVEMENT.jumpSpeed).toBe(6.8);
  });
});
