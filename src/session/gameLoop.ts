/**
 * Fixed-step game loop (docs/DESIGN.md §8, §8.3).
 *
 * The simulation advances in whole ticks of `TICK_DT`; rendering runs at
 * display refresh and interpolates between the last two ticks with
 * `alpha = accumulator / dt`. Frame time is wall-clock, but it only ever
 * decides *how many* ticks to run, never what happens inside one, so the sim
 * stays deterministic (§10 rule 1).
 */
import { TICK_DT, type Seconds } from '../sim/types';
import type { Unsubscribe } from '../net/transport';

/**
 * Tolerance when deciding whether the accumulator holds a whole tick. Frame
 * deltas are summed in floating point, so 1000 frames that add up to exactly
 * 1000 ticks can leave the accumulator a few ulps short of the last tick.
 */
const EPSILON: Seconds = 1e-9;

export interface FixedStepOptions {
  /** Seconds per simulation step. Defaults to `TICK_DT` (1/60 s). */
  stepDt?: Seconds;
  /**
   * Longest frame delta honoured, in seconds. Longer frames (a GC pause, a
   * debugger break, a backgrounded tab that kept running) are clamped so the
   * loop does not try to catch up with hundreds of ticks at once. Default 0.25.
   */
  maxFrameDt?: Seconds;
}

/** Pure accumulator: turns variable frame deltas into a whole number of fixed steps. */
export class FixedStepClock {
  readonly stepDt: Seconds;
  readonly maxFrameDt: Seconds;
  private accumulator: Seconds = 0;

  constructor(options: FixedStepOptions = {}) {
    this.stepDt = options.stepDt ?? TICK_DT;
    this.maxFrameDt = options.maxFrameDt ?? 0.25;
    if (!(this.stepDt > 0)) throw new RangeError(`stepDt must be > 0, got ${this.stepDt}`);
    if (!(this.maxFrameDt >= this.stepDt)) {
      throw new RangeError(`maxFrameDt must be >= stepDt, got ${this.maxFrameDt}`);
    }
  }

  /**
   * Add one frame's elapsed time and return how many steps are now due.
   * Negative, NaN and infinite deltas count as zero; deltas above `maxFrameDt`
   * are clamped to it.
   */
  advance(frameDt: Seconds): number {
    const dt = Number.isFinite(frameDt) && frameDt > 0 ? Math.min(frameDt, this.maxFrameDt) : 0;
    this.accumulator += dt;
    const steps = Math.floor((this.accumulator + EPSILON) / this.stepDt);
    this.accumulator = Math.max(0, this.accumulator - steps * this.stepDt);
    return steps;
  }

  /** Fraction of a step left in the accumulator, in [0, 1): the render interpolation factor. */
  get alpha(): number {
    return Math.min(this.accumulator / this.stepDt, 1 - Number.EPSILON);
  }

  /** Time banked toward the next step, in seconds. */
  get pending(): Seconds {
    return this.accumulator;
  }

  reset(): void {
    this.accumulator = 0;
  }
}

/** Abstraction over `requestAnimationFrame` so the loop runs in tests and headless. */
export interface FrameScheduler {
  /** Call `cb` on the next frame with a timestamp in milliseconds. */
  request(cb: (timeMs: number) => void): number;
  cancel(handle: number): void;
}

/** Browser scheduler backed by `requestAnimationFrame`. */
export const animationFrameScheduler: FrameScheduler = {
  request: (cb) => requestAnimationFrame(cb),
  cancel: (handle) => cancelAnimationFrame(handle),
};

export interface LoopCallbacks {
  /** Advance the simulation by exactly one tick. */
  step(): void;
  /** Draw a frame; `alpha` in [0, 1) interpolates between the previous and current tick. */
  render?(alpha: number): void;
}

export interface GameLoopOptions extends FixedStepOptions {
  /** Defaults to `animationFrameScheduler`. */
  scheduler?: FrameScheduler;
}

/** What one frame did. */
export interface FrameResult {
  /** Ticks stepped this frame. */
  steps: number;
  /** Interpolation factor passed to `render`. */
  alpha: number;
}

/** Why the loop is paused. The loop runs only when no reason is active. */
export type PauseReason = 'manual' | 'blur' | 'hidden' | (string & {});

export interface Pausable {
  pause(reason?: PauseReason): void;
  resume(reason?: PauseReason): void;
}

/**
 * Drives `LoopCallbacks` from a `FrameScheduler`. Can also be driven by hand
 * with `frame(dt)`, which is what tests and the headless smoke run use.
 */
export class GameLoop implements Pausable {
  readonly clock: FixedStepClock;
  private readonly scheduler: FrameScheduler | undefined;
  private readonly pauseReasons = new Set<PauseReason>();
  private handle: number | undefined;
  private lastTimeMs: number | undefined;
  private totalSteps = 0;

  constructor(
    private readonly callbacks: LoopCallbacks,
    options: GameLoopOptions = {},
  ) {
    this.clock = new FixedStepClock(options);
    this.scheduler =
      options.scheduler ??
      (typeof requestAnimationFrame === 'function' ? animationFrameScheduler : undefined);
  }

  /** Total ticks stepped since construction. */
  get steps(): number {
    return this.totalSteps;
  }

  get running(): boolean {
    return this.handle !== undefined;
  }

  get paused(): boolean {
    return this.pauseReasons.size > 0;
  }

  /** Start scheduling frames. No-op if already running. */
  start(): void {
    if (this.running) return;
    if (!this.scheduler) throw new Error('GameLoop.start() needs a FrameScheduler');
    this.lastTimeMs = undefined;
    this.handle = this.scheduler.request(this.onAnimationFrame);
  }

  /** Stop scheduling frames. Banked time is kept; the next start does not catch up. */
  stop(): void {
    if (this.handle === undefined) return;
    this.scheduler?.cancel(this.handle);
    this.handle = undefined;
    this.lastTimeMs = undefined;
  }

  /**
   * Add a pause reason. While any reason is active, frames still render (with
   * a frozen alpha) but the simulation does not step and elapsed time is
   * discarded rather than banked.
   */
  pause(reason: PauseReason = 'manual'): void {
    this.pauseReasons.add(reason);
  }

  /** Remove a pause reason. The loop resumes once none remain. */
  resume(reason: PauseReason = 'manual'): void {
    if (!this.pauseReasons.delete(reason)) return;
    if (!this.paused) {
      // The first frame after resuming measures from itself, not from before the pause.
      this.lastTimeMs = undefined;
    }
  }

  isPausedFor(reason: PauseReason): boolean {
    return this.pauseReasons.has(reason);
  }

  /** Run one frame of `frameDt` seconds: step as many ticks as are due, then render. */
  frame(frameDt: Seconds): FrameResult {
    let steps = 0;
    if (!this.paused) {
      const due = this.clock.advance(frameDt);
      while (steps < due) {
        this.callbacks.step();
        steps++;
        this.totalSteps++;
        // A step may pause the loop (end of match, menu opened by an event):
        // drop the rest of the frame's ticks instead of running them later.
        if (this.paused) {
          this.clock.reset();
          break;
        }
      }
    }
    const alpha = this.clock.alpha;
    this.callbacks.render?.(alpha);
    return { steps, alpha };
  }

  private readonly onAnimationFrame = (timeMs: number): void => {
    if (this.handle === undefined) return;
    this.handle = this.scheduler?.request(this.onAnimationFrame);
    const dt = this.lastTimeMs === undefined ? 0 : (timeMs - this.lastTimeMs) / 1000;
    this.lastTimeMs = timeMs;
    this.frame(dt);
  };
}

/** Minimal shape of `document` used for visibility tracking. */
export interface VisibilitySource extends EventTarget {
  readonly hidden: boolean;
}

/**
 * Pause `loop` while the window is blurred or the document is hidden, and
 * resume when both clear. A manual pause (menu) is untouched: regaining focus
 * never resumes a game the player paused. Returns a function that detaches the
 * listeners and lifts any pause this helper applied.
 */
export function pauseOnBlur(loop: Pausable, win: EventTarget, doc?: VisibilitySource): Unsubscribe {
  const onBlur = (): void => loop.pause('blur');
  const onFocus = (): void => loop.resume('blur');
  const onVisibility = (): void => {
    if (doc?.hidden) loop.pause('hidden');
    else loop.resume('hidden');
  };

  win.addEventListener('blur', onBlur);
  win.addEventListener('focus', onFocus);
  doc?.addEventListener('visibilitychange', onVisibility);
  if (doc?.hidden) loop.pause('hidden');

  return () => {
    win.removeEventListener('blur', onBlur);
    win.removeEventListener('focus', onFocus);
    doc?.removeEventListener('visibilitychange', onVisibility);
    loop.resume('blur');
    loop.resume('hidden');
  };
}
