/**
 * A scripted pawn for headless route checks (P31). A `RouteDriver` runs a
 * list of `RouteStep`s and produces one `InputCommand` per tick from the
 * pawn's state, like a controller would: walk toward a point, run off an edge
 * or onto a jump pad, jump at a mark, dodge, wait for a landing. Nothing here
 * reads the mover's private state; steps see only `PawnState`.
 *
 * Steps are plain closures so a route can describe its own trick (the wall
 * dodge at a pad's apex, a double jump onto the iron) in a line.
 */
import {
  Buttons,
  NULL_INPUT,
  type InputCommand,
  type PawnState,
  type Tick,
  type Vec3,
} from '../../sim/types';

/** What a step sees each tick. */
export interface StepView {
  readonly pawn: Readonly<PawnState>;
  readonly tick: Tick;
  /** Ticks spent in this step so far (0 on its first tick). */
  readonly ticksInStep: number;
}

/** A step's command for one tick. Missing fields keep the driver's heading and press nothing. */
export interface StepCommand {
  yaw?: number;
  pitch?: number;
  moveX?: number;
  moveY?: number;
  buttons?: number;
  /** The step has finished; the next step starts on the next tick. */
  done?: boolean;
}

export interface RouteStep {
  readonly name: string;
  /** Ticks allowed before the step counts as failed. */
  readonly maxTicks: number;
  next(view: StepView): StepCommand;
}

/** Yaw that faces from `from` toward `to` (poses face −Z at yaw 0). */
export function yawToward(from: Readonly<Vec3>, to: Readonly<Vec3>): number {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z));
}

export function horizontalDistance(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function horizontalSpeed(v: Readonly<Vec3>): number {
  return Math.hypot(v.x, v.z);
}

/** Capsule center is `PAWN_CAPSULE` radius + half height above the feet (standing). */
export const CENTER_ABOVE_FEET = 0.9;

/** Feet height of a standing pawn. */
export function feetY(pawn: Readonly<PawnState>): number {
  return pawn.position.y - CENTER_ABOVE_FEET;
}

const SECOND = 60;

/**
 * How a walking step uses Jump: never; once when blocked; with a double jump
 * near the apex when blocked; or hopping all the way (jump whenever grounded),
 * which carries running speed into each jump and so climbs a run of steps.
 */
export type JumpHelp = 'none' | 'single' | 'double' | 'hop';

export interface WalkOptions {
  /** Done when the horizontal distance to the target is below this (default 1 m). */
  radius?: number;
  /** Jump when blocked (once, or with a double jump), or hop all the way. */
  jump?: JumpHelp;
  maxTicks?: number;
  name?: string;
}

/**
 * Walk toward `to` until standing within `radius` of it horizontally. With
 * `jump`, a pawn that stands still while trying to move jumps (and double
 * jumps) over whatever blocks it.
 */
export function walkTo(to: Readonly<Vec3>, options: WalkOptions = {}): RouteStep {
  const radius = options.radius ?? 1;
  const help = options.jump ?? 'none';
  let stuckTicks = 0;
  let jumpHeld = false;
  let jumped = false;
  let doubled = false;
  return {
    name: options.name ?? `walk to ${fmt(to)}`,
    maxTicks: options.maxTicks ?? 20 * SECOND,
    next({ pawn }) {
      const yaw = yawToward(pawn.position, to);
      if (pawn.grounded && horizontalDistance(pawn.position, to) <= radius) {
        return { yaw, moveY: 0, done: true };
      }
      let buttons = 0;
      if (help === 'hop') {
        if (pawn.grounded && !jumpHeld) buttons |= Buttons.Jump;
      } else if (help !== 'none') {
        if (pawn.grounded) {
          jumped = doubled = false;
          stuckTicks = horizontalSpeed(pawn.velocity) < 0.5 ? stuckTicks + 1 : 0;
          if (stuckTicks > 6 && !jumpHeld) {
            buttons |= Buttons.Jump;
            jumped = true;
            stuckTicks = 0;
          }
        } else if (help === 'double' && jumped && !doubled && !jumpHeld && pawn.velocity.y <= 2) {
          buttons |= Buttons.Jump;
          doubled = true;
        }
      }
      jumpHeld = (buttons & Buttons.Jump) !== 0;
      return { yaw, moveY: 1, buttons };
    },
  };
}

/**
 * Walk toward `to` until the pawn leaves the ground: onto a jump pad, or off
 * an edge. Done on the first airborne tick after having stood on the ground.
 */
export function walkUntilAirborne(to: Readonly<Vec3>, name?: string): RouteStep {
  let stood = false;
  return {
    name: name ?? `walk off toward ${fmt(to)}`,
    maxTicks: 10 * SECOND,
    next({ pawn }) {
      const yaw = yawToward(pawn.position, to);
      if (pawn.grounded) stood = true;
      else if (stood) return { yaw, moveY: 0, done: true };
      return { yaw, moveY: 1 };
    },
  };
}

/** No input until the pawn stands on the ground again. */
export function waitLanding(name = 'wait for landing', maxTicks = 8 * SECOND): RouteStep {
  return {
    name,
    maxTicks,
    next: ({ pawn, ticksInStep }) => ({ done: ticksInStep > 0 && pawn.grounded }),
  };
}

/** No input until `test` holds. */
export function waitUntil(
  name: string,
  test: (pawn: Readonly<PawnState>) => boolean,
  maxTicks = 8 * SECOND,
): RouteStep {
  return { name, maxTicks, next: ({ pawn }) => ({ done: test(pawn) }) };
}

/** Hold `buttons` (and optionally a heading) for `ticks` ticks. */
export function hold(buttons: number, ticks: number, yaw?: number): RouteStep {
  return {
    name: `hold buttons ${buttons}`,
    maxTicks: ticks + 1,
    next: ({ ticksInStep }) => ({
      ...(yaw === undefined ? {} : { yaw }),
      buttons,
      done: ticksInStep >= ticks - 1,
    }),
  };
}

/**
 * Run toward `to` and press Jump the first tick `jumpWhen` holds, then keep
 * running forward in the air. Done when the pawn lands after the jump.
 */
export function runAndJump(
  to: Readonly<Vec3>,
  jumpWhen: (pawn: Readonly<PawnState>) => boolean,
  name?: string,
): RouteStep {
  let jumpedAt: Tick | null = null;
  return {
    name: name ?? `run and jump toward ${fmt(to)}`,
    maxTicks: 10 * SECOND,
    next({ pawn, tick }) {
      const yaw = yawToward(pawn.position, to);
      if (jumpedAt === null) {
        if (pawn.grounded && jumpWhen(pawn)) {
          jumpedAt = tick;
          return { yaw, moveY: 1, buttons: Buttons.Jump };
        }
        return { yaw, moveY: 1 };
      }
      const landed = tick > jumpedAt + 2 && pawn.grounded;
      return { yaw, moveY: landed ? 0 : 1, done: landed };
    },
  };
}

export type DodgeDir = 'forward' | 'back' | 'left' | 'right';

const DODGE_BIT: Record<DodgeDir, number> = {
  forward: Buttons.DodgeForward,
  back: Buttons.DodgeBack,
  left: Buttons.DodgeLeft,
  right: Buttons.DodgeRight,
};

/** One tick with a dodge bit set, facing `yaw` when given. */
export function dodge(dir: DodgeDir, yaw?: number): RouteStep {
  return {
    name: `dodge ${dir}`,
    maxTicks: 1,
    next: () => ({ ...(yaw === undefined ? {} : { yaw }), buttons: DODGE_BIT[dir], done: true }),
  };
}

/** Face `yaw` for one tick (the sim takes the view from the command). */
export function face(yaw: number): RouteStep {
  return { name: `face ${yaw.toFixed(2)}`, maxTicks: 1, next: () => ({ yaw, done: true }) };
}

function fmt(v: Readonly<Vec3>): string {
  return `(${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)})`;
}

export interface DriverStatus {
  /** Index of the running step, or `steps.length` when finished. */
  readonly index: number;
  readonly step: RouteStep | null;
  readonly finished: boolean;
}

/** Runs steps in order; `next()` is called once per tick with the previous tick's state. */
export class RouteDriver {
  private index = 0;
  private ticksInStep = 0;
  private yaw: number;
  private pitch = 0;

  constructor(
    private readonly steps: readonly RouteStep[],
    initialYaw = 0,
  ) {
    this.yaw = initialYaw;
  }

  get status(): DriverStatus {
    const step = this.steps[this.index] ?? null;
    return { index: this.index, step, finished: step === null };
  }

  /**
   * The command for `tick`. Throws when the running step exceeds its
   * `maxTicks`, naming it, so a failing route says where it got stuck.
   */
  next(pawn: Readonly<PawnState>, tick: Tick): InputCommand {
    const step = this.steps[this.index];
    if (!step) return { ...NULL_INPUT, seq: tick, yaw: this.yaw, pitch: this.pitch };
    if (this.ticksInStep >= step.maxTicks) {
      throw new Error(
        `step ${this.index + 1}/${this.steps.length} "${step.name}" exceeded ${step.maxTicks} ticks at ${describe(pawn)}`,
      );
    }
    const cmd = step.next({ pawn, tick, ticksInStep: this.ticksInStep });
    this.ticksInStep++;
    if (cmd.yaw !== undefined) this.yaw = cmd.yaw;
    if (cmd.pitch !== undefined) this.pitch = cmd.pitch;
    if (cmd.done) {
      this.index++;
      this.ticksInStep = 0;
    }
    return {
      seq: tick,
      moveX: cmd.moveX ?? 0,
      moveY: cmd.moveY ?? 0,
      yaw: this.yaw,
      pitch: this.pitch,
      buttons: cmd.buttons ?? 0,
      weapon: 0,
    };
  }
}

/** One line of a pawn's whereabouts for failure messages. */
export function describe(pawn: Readonly<PawnState>): string {
  const p = pawn.position;
  const v = pawn.velocity;
  return (
    `feet (${p.x.toFixed(1)}, ${feetY(pawn).toFixed(1)}, ${p.z.toFixed(1)}) ` +
    `v (${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)}) ` +
    `${pawn.grounded ? 'grounded' : 'airborne'} ${pawn.alive ? `hp ${pawn.health}` : 'dead'}`
  );
}
