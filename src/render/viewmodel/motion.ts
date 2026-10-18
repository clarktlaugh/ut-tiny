/**
 * View model motion (docs/DESIGN.md §8.3): weapon bob, sway, strafe roll,
 * airborne lift, landing dip, recoil and the lower/raise used for weapon
 * switches. Pure and DOM-free so it runs in Node tests.
 *
 * Everything is driven from the local pawn's interpolated state once per
 * rendered frame: velocity drives bob and roll, yaw/pitch change drives sway,
 * and `land` / `shotFired` events add spring impulses. The output is an offset
 * in view-model camera space (meters and radians) applied on top of the
 * weapon's rest pose. Offsets are clamped so the weapon can never swing into
 * the view-model camera's near plane (see `MOTION_LIMITS`).
 *
 * Angle conventions match the rest of the renderer: yaw 0 faces −Z, positive
 * yaw turns toward −X, positive pitch looks up.
 */
import type { Vec3 } from '../../sim/types';

/** What the motion model reads from the pawn each frame. */
export interface MotionInput {
  velocity: Readonly<Vec3>;
  yaw: number;
  pitch: number;
  grounded: boolean;
  crouching: boolean;
}

/** Offset applied to the weapon rig, in view-model camera space. */
export interface MotionOffset {
  /** Meters; +x right, +y up, +z toward the viewer. */
  x: number;
  y: number;
  z: number;
  /** Radians about camera X (positive tips the muzzle up). */
  pitch: number;
  /** Radians about camera Y (positive turns the muzzle left). */
  yaw: number;
  /** Radians about camera Z (positive rolls the top left). */
  roll: number;
}

export interface MotionConfig {
  /** Speed at which bob reaches full amplitude (§4 ground speed). */
  runSpeed: number;
  /** Bob cycles per meter travelled on the ground (two footsteps per cycle). */
  bobCyclesPerMeter: number;
  /** Peak sideways bob at full speed, meters. */
  bobX: number;
  /** Peak vertical bob at full speed, meters. */
  bobY: number;
  /** Bob amplitude scale while crouched. */
  crouchBobScale: number;
  /** Rate (1/s) at which bob amplitude follows speed and grounded changes. */
  bobResponse: number;
  /** Meters of positional sway per rad/s of look rate. */
  swayPosition: number;
  /** Radians of rotational sway per rad/s of look rate. */
  swayRotation: number;
  /** Look rate (rad/s) beyond which sway stops growing. */
  swayMaxRate: number;
  /** Rate (1/s) at which sway follows the look rate. */
  swayResponse: number;
  /** Roll (radians) at full strafe speed; leans into the strafe. */
  strafeRoll: number;
  /** Meters the weapon drops per m/s of upward velocity while airborne. */
  airLift: number;
  /** Clamp for the airborne offset, meters. */
  airLiftMax: number;
  /** Downward spring velocity (m/s) per m/s of landing impact speed. */
  landKick: number;
  /** Lower offset in meters when fully lowered for a weapon switch. */
  lowerDrop: number;
  /** Pitch (radians, negative = muzzle down) when fully lowered. */
  lowerPitch: number;
  /** Seconds to go from raised to fully lowered (and back). */
  lowerTime: number;
  /** Spring stiffness (1/s²) for impulses (landing, recoil). */
  springStiffness: number;
  /** Damping ratio for impulse springs (1 = critical). */
  springDamping: number;
}

/** Defaults tuned by eye against the §4 movement numbers. */
export const DEFAULT_MOTION: Readonly<MotionConfig> = Object.freeze({
  runSpeed: 8.8,
  bobCyclesPerMeter: 0.2,
  bobX: 0.012,
  bobY: 0.008,
  crouchBobScale: 0.5,
  bobResponse: 8,
  swayPosition: 0.006,
  swayRotation: 0.02,
  swayMaxRate: 6,
  swayResponse: 12,
  strafeRoll: 0.06,
  airLift: 0.0015,
  airLiftMax: 0.02,
  landKick: 0.012,
  lowerDrop: 0.22,
  lowerPitch: -0.6,
  lowerTime: 0.15,
  springStiffness: 220,
  springDamping: 0.65,
});

/**
 * Hard limits on the dynamic offset (excluding the switch lower, which moves
 * the weapon down and out of frame by design). The weapon rest pose plus these
 * limits keeps every part well behind the view-model near plane; the frustum
 * test in `viewModel.test.ts` checks it for every weapon.
 */
export const MOTION_LIMITS = Object.freeze({
  position: 0.06,
  rotation: 0.2,
});

/** A recoil impulse: velocities added to the recoil springs. */
export interface RecoilImpulse {
  /** m/s pushing the weapon back toward the viewer. */
  back: number;
  /** rad/s tipping the muzzle up. */
  pitch: number;
}

/** One-dimensional damped spring toward 0. */
interface Spring {
  x: number;
  v: number;
}

const MAX_SUBSTEP = 1 / 240;

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Exponential approach factor for a rate (1/s) over `dt`, frame-rate independent. */
function approach(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

/** Shortest signed difference `b − a` between two angles, in (−π, π]. */
export function angleDelta(a: number, b: number): number {
  const twoPi = Math.PI * 2;
  let d = (b - a) % twoPi;
  if (d > Math.PI) d -= twoPi;
  else if (d <= -Math.PI) d += twoPi;
  return d;
}

export class ViewModelMotion {
  readonly config: Readonly<MotionConfig>;

  /** Bob phase in radians. */
  private phase = 0;
  /** Smoothed bob amplitude, 0..1. */
  private bobAmount = 0;
  private swayYaw = 0;
  private swayPitch = 0;
  private roll = 0;
  private air = 0;
  private lastYaw = 0;
  private lastPitch = 0;
  private primed = false;
  private readonly landSpring: Spring = { x: 0, v: 0 };
  private readonly backSpring: Spring = { x: 0, v: 0 };
  private readonly kickSpring: Spring = { x: 0, v: 0 };
  private lowerValue = 0;
  private lowerTargetValue = 0;
  private readonly out: MotionOffset = { x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0 };

  constructor(config: Partial<MotionConfig> = {}) {
    this.config = { ...DEFAULT_MOTION, ...config };
  }

  /** How far the weapon is lowered for a switch, 0 (raised) .. 1 (down). */
  get lower(): number {
    return this.lowerValue;
  }

  /** Lower (1) or raise (0) the weapon at the configured rate. */
  setLowerTarget(target: 0 | 1): void {
    this.lowerTargetValue = target;
  }

  /** Jump the lower state without animating (e.g. start fully lowered on spawn). */
  setLower(value: number): void {
    this.lowerValue = clamp(value, 0, 1);
  }

  /** Forget all motion; the next `step` treats its input as the starting view. */
  reset(): void {
    this.phase = 0;
    this.bobAmount = 0;
    this.swayYaw = 0;
    this.swayPitch = 0;
    this.roll = 0;
    this.air = 0;
    this.primed = false;
    this.landSpring.x = this.landSpring.v = 0;
    this.backSpring.x = this.backSpring.v = 0;
    this.kickSpring.x = this.kickSpring.v = 0;
  }

  /** Landing dip scaled by impact speed (m/s). */
  land(impactSpeed: number): void {
    this.landSpring.v -= Math.max(0, impactSpeed) * this.config.landKick;
  }

  /** Recoil kick from a shot. */
  recoil(impulse: Readonly<RecoilImpulse>): void {
    this.backSpring.v += impulse.back;
    this.kickSpring.v += impulse.pitch;
  }

  /**
   * Advance by `dt` seconds of render time and return the offset to apply.
   * The returned object is reused between calls.
   */
  step(input: Readonly<MotionInput>, dt: number): Readonly<MotionOffset> {
    const c = this.config;
    const h = Math.max(0, dt);

    // Look rate drives sway. The first frame (or a reset) has no history.
    let yawRate = 0;
    let pitchRate = 0;
    if (this.primed && h > 0) {
      yawRate = clamp(angleDelta(this.lastYaw, input.yaw) / h, -c.swayMaxRate, c.swayMaxRate);
      pitchRate = clamp((input.pitch - this.lastPitch) / h, -c.swayMaxRate, c.swayMaxRate);
    }
    this.lastYaw = input.yaw;
    this.lastPitch = input.pitch;
    this.primed = true;

    const k = approach(c.swayResponse, h);
    this.swayYaw += (yawRate - this.swayYaw) * k;
    this.swayPitch += (pitchRate - this.swayPitch) * k;

    // Velocity in the pawn's horizontal frame.
    const v = input.velocity;
    const sin = Math.sin(input.yaw);
    const cos = Math.cos(input.yaw);
    const right = v.x * cos - v.z * sin;
    const speed = Math.hypot(v.x, v.z);

    const bobTarget = input.grounded
      ? clamp(speed / c.runSpeed, 0, 1) * (input.crouching ? c.crouchBobScale : 1)
      : 0;
    const kb = approach(c.bobResponse, h);
    this.bobAmount += (bobTarget - this.bobAmount) * kb;
    if (input.grounded) {
      this.phase = (this.phase + speed * h * c.bobCyclesPerMeter * Math.PI * 2) % (Math.PI * 2);
    }

    const rollTarget = clamp(right / c.runSpeed, -1, 1) * c.strafeRoll;
    this.roll += (rollTarget - this.roll) * kb;

    const airTarget = input.grounded ? 0 : clamp(-v.y * c.airLift, -c.airLiftMax, c.airLiftMax);
    this.air += (airTarget - this.air) * kb;

    this.stepSprings(h);

    const lowerRate = c.lowerTime > 0 ? h / c.lowerTime : 1;
    if (this.lowerValue < this.lowerTargetValue) {
      this.lowerValue = Math.min(this.lowerTargetValue, this.lowerValue + lowerRate);
    } else if (this.lowerValue > this.lowerTargetValue) {
      this.lowerValue = Math.max(this.lowerTargetValue, this.lowerValue - lowerRate);
    }

    // Figure-eight bob: sideways once per cycle, down twice (once per footstep).
    const bx = Math.sin(this.phase) * c.bobX * this.bobAmount;
    const by = -Math.abs(Math.sin(this.phase)) * c.bobY * this.bobAmount;

    const P = MOTION_LIMITS.position;
    const R = MOTION_LIMITS.rotation;
    // Sway: the weapon lags behind the look direction.
    const o = this.out;
    o.x = clamp(bx + this.swayYaw * c.swayPosition, -P, P);
    o.y = clamp(by + this.air + this.landSpring.x - this.swayPitch * c.swayPosition, -P, P);
    o.z = clamp(this.backSpring.x, -P, P);
    o.pitch = clamp(this.kickSpring.x - this.swayPitch * c.swayRotation, -R, R);
    o.yaw = clamp(-this.swayYaw * c.swayRotation, -R, R);
    o.roll = clamp(-this.roll + this.swayYaw * c.swayRotation * 0.5, -R, R);

    // Switch lower, eased so the weapon accelerates out of view.
    const l = this.lowerValue * this.lowerValue * (3 - 2 * this.lowerValue);
    o.y -= l * c.lowerDrop;
    o.pitch += l * c.lowerPitch;
    return o;
  }

  private stepSprings(dt: number): void {
    const c = this.config;
    const k = c.springStiffness;
    const d = 2 * Math.sqrt(k) * c.springDamping;
    let remaining = dt;
    while (remaining > 1e-9) {
      const h = Math.min(MAX_SUBSTEP, remaining);
      remaining -= h;
      for (const s of [this.landSpring, this.backSpring, this.kickSpring]) {
        s.v += (-k * s.x - d * s.v) * h;
        s.x += s.v * h;
      }
    }
  }
}
