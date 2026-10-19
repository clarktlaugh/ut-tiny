/** Frame-time statistics for the `?perf=1` overlay. */

export interface FrameSummary {
  readonly fps: number;
  readonly avgMs: number;
  readonly worstMs: number;
  readonly frames: number;
}

/** Rolling window of frame times (ms), summarised over the last `windowMs`. */
export class FrameStats {
  private readonly times: number[] = [];
  private readonly deltas: number[] = [];
  private last: number | null = null;

  constructor(private readonly windowMs = 1000) {}

  sample(now: number): void {
    if (this.last !== null) {
      this.times.push(now);
      this.deltas.push(now - this.last);
    }
    this.last = now;
    while (this.times.length && now - this.times[0]! > this.windowMs) {
      this.times.shift();
      this.deltas.shift();
    }
  }

  /** Drop history (after the tab was hidden). */
  reset(): void {
    this.times.length = 0;
    this.deltas.length = 0;
    this.last = null;
  }

  summary(): FrameSummary {
    const n = this.deltas.length;
    if (!n) return { fps: 0, avgMs: 0, worstMs: 0, frames: 0 };
    let sum = 0;
    let worst = 0;
    for (const d of this.deltas) {
      sum += d;
      worst = Math.max(worst, d);
    }
    const avgMs = sum / n;
    return { fps: 1000 / avgMs, avgMs, worstMs: worst, frames: n };
  }
}
