/**
 * Double-tap dodge detection (docs/DESIGN.md §4, §8.2).
 *
 * Two presses of the same movement direction within the window produce one
 * dodge. The detector only recognises the gesture; dodge physics and the
 * 0.5 s cooldown belong to the simulation.
 */

export type DodgeDirection = 'forward' | 'back' | 'left' | 'right';

/** Double-tap window from §4. */
export const DODGE_WINDOW_MS = 250;

export class DodgeDetector {
  private lastDirection: DodgeDirection | null = null;
  private lastTime = Number.NEGATIVE_INFINITY;

  constructor(readonly windowMs: number = DODGE_WINDOW_MS) {}

  /**
   * Record a fresh press (not an auto-repeat) of a direction at `timeMs`.
   * Returns the direction when this press completes a double tap, else null.
   * A completed dodge consumes both taps, so a triple tap is one dodge.
   * Tapping a different direction restarts the gesture.
   */
  tap(direction: DodgeDirection, timeMs: number): DodgeDirection | null {
    const dt = timeMs - this.lastTime;
    if (direction === this.lastDirection && dt >= 0 && dt <= this.windowMs) {
      this.reset();
      return direction;
    }
    this.lastDirection = direction;
    this.lastTime = timeMs;
    return null;
  }

  reset(): void {
    this.lastDirection = null;
    this.lastTime = Number.NEGATIVE_INFINITY;
  }
}
