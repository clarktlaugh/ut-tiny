import { describe, expect, it } from 'vitest';
import { TICK_DT } from '../sim/types';
import { FixedStepClock, GameLoop, pauseOnBlur, type FrameScheduler } from './gameLoop';

/** Deterministic PRNG so the variable frame deltas are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Split `total` seconds into frames of random length between 0 and `maxDt`. */
function variableFrames(total: number, maxDt: number, seed: number): number[] {
  const rand = mulberry32(seed);
  const frames: number[] = [];
  let t = 0;
  while (t < total) {
    const next = Math.min(total, t + rand() * maxDt);
    frames.push(next - t);
    t = next;
  }
  return frames;
}

class ManualScheduler implements FrameScheduler {
  private next = 1;
  readonly queue = new Map<number, (timeMs: number) => void>();
  request(cb: (timeMs: number) => void): number {
    const h = this.next++;
    this.queue.set(h, cb);
    return h;
  }
  cancel(handle: number): void {
    this.queue.delete(handle);
  }
  fire(timeMs: number): void {
    const cbs = [...this.queue.values()];
    this.queue.clear();
    for (const cb of cbs) cb(timeMs);
  }
}

describe('FixedStepClock', () => {
  it('1000 ticks at variable frame dt produce exactly 1000 steps', () => {
    for (const seed of [1, 2, 3, 42, 1337]) {
      for (const maxDt of [0.004, 0.017, 0.05, 0.2]) {
        const clock = new FixedStepClock();
        let steps = 0;
        for (const dt of variableFrames(1000 * TICK_DT, maxDt, seed)) steps += clock.advance(dt);
        expect(steps).toBe(1000);
        expect(clock.alpha).toBeLessThan(1e-6);
      }
    }
  });

  it('1000 ticks at typical display rates produce exactly 1000 steps', () => {
    for (const hz of [30, 59.94, 60, 75, 120, 144, 165, 240]) {
      const clock = new FixedStepClock();
      const frames = Math.round(1000 * TICK_DT * hz);
      const dt = (1000 * TICK_DT) / frames;
      let steps = 0;
      for (let i = 0; i < frames; i++) steps += clock.advance(dt);
      expect(steps, `${hz} Hz`).toBe(1000);
    }
  });

  it('banks partial ticks and exposes them as alpha', () => {
    const clock = new FixedStepClock();
    expect(clock.advance(TICK_DT * 0.25)).toBe(0);
    expect(clock.alpha).toBeCloseTo(0.25, 9);
    expect(clock.advance(TICK_DT * 0.5)).toBe(0);
    expect(clock.alpha).toBeCloseTo(0.75, 9);
    expect(clock.advance(TICK_DT * 0.5)).toBe(1);
    expect(clock.alpha).toBeCloseTo(0.25, 9);
    expect(clock.advance(TICK_DT * 2)).toBe(2);
    expect(clock.alpha).toBeGreaterThanOrEqual(0);
    expect(clock.alpha).toBeLessThan(1);
  });

  it('clamps long frames to maxFrameDt', () => {
    const clock = new FixedStepClock({ maxFrameDt: 0.25 });
    expect(clock.advance(10)).toBe(15);
  });

  it('ignores negative, NaN and infinite deltas', () => {
    const clock = new FixedStepClock();
    expect(clock.advance(-1)).toBe(0);
    expect(clock.advance(Number.NaN)).toBe(0);
    expect(clock.advance(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clock.pending).toBe(0);
  });

  it('rejects nonsensical options', () => {
    expect(() => new FixedStepClock({ stepDt: 0 })).toThrow(RangeError);
    expect(() => new FixedStepClock({ stepDt: 0.1, maxFrameDt: 0.05 })).toThrow(RangeError);
  });
});

describe('GameLoop', () => {
  it('steps then renders once per frame with the clock alpha', () => {
    const log: string[] = [];
    const loop = new GameLoop({
      step: () => log.push('step'),
      render: (a) => log.push(`render ${a.toFixed(2)}`),
    });
    expect(loop.frame(TICK_DT * 2.5)).toEqual({ steps: 2, alpha: expect.closeTo(0.5, 9) });
    expect(log).toEqual(['step', 'step', 'render 0.50']);
    expect(loop.steps).toBe(2);
  });

  it('runs exactly 1000 steps over 1000 ticks of variable rAF timestamps', () => {
    const scheduler = new ManualScheduler();
    let steps = 0;
    const loop = new GameLoop({ step: () => steps++ }, { scheduler });
    loop.start();
    let t = 1234.5;
    scheduler.fire(t); // first frame only establishes the time base
    for (const dt of variableFrames(1000 * TICK_DT, 0.033, 7)) {
      t += dt * 1000;
      scheduler.fire(t);
    }
    expect(steps).toBe(1000);
    loop.stop();
    expect(scheduler.queue.size).toBe(0);
    expect(loop.running).toBe(false);
  });

  it('does not step while paused and does not catch up after resuming', () => {
    const scheduler = new ManualScheduler();
    let steps = 0;
    let renders = 0;
    const loop = new GameLoop(
      { step: () => steps++, render: () => renders++ },
      { scheduler, maxFrameDt: 10 },
    );
    loop.start();
    scheduler.fire(0);
    scheduler.fire(1000 / 60);
    expect(steps).toBe(1);

    loop.pause();
    scheduler.fire(2000);
    scheduler.fire(4000);
    expect(steps).toBe(1);
    expect(renders).toBe(4); // rendering continues while paused

    loop.resume();
    scheduler.fire(5000); // re-establishes the time base, no 5 s burst
    expect(steps).toBe(1);
    scheduler.fire(5000 + 1000 / 60);
    expect(steps).toBe(2);
  });

  it('only resumes when every pause reason is lifted', () => {
    const loop = new GameLoop({ step: () => {} });
    loop.pause('manual');
    loop.pause('blur');
    loop.resume('blur');
    expect(loop.paused).toBe(true);
    expect(loop.frame(1).steps).toBe(0);
    loop.resume('manual');
    expect(loop.paused).toBe(false);
  });

  it('stops stepping mid-frame when a step pauses the loop', () => {
    let steps = 0;
    const loop = new GameLoop({
      step: () => {
        steps++;
        if (steps === 2) loop.pause();
      },
    });
    expect(loop.frame(TICK_DT * 5).steps).toBe(2);
    loop.resume();
    expect(loop.frame(0).steps).toBe(0);
  });

  it('start() without a scheduler outside the browser throws', () => {
    const loop = new GameLoop({ step: () => {} });
    expect(() => loop.start()).toThrow();
  });
});

describe('pauseOnBlur', () => {
  class FakeDocument extends EventTarget {
    hidden = false;
  }

  it('pauses on blur and on hidden, resumes when both clear', () => {
    const win = new EventTarget();
    const doc = new FakeDocument();
    const loop = new GameLoop({ step: () => {} });
    const detach = pauseOnBlur(loop, win, doc);

    win.dispatchEvent(new Event('blur'));
    expect(loop.paused).toBe(true);
    doc.hidden = true;
    doc.dispatchEvent(new Event('visibilitychange'));
    win.dispatchEvent(new Event('focus'));
    expect(loop.paused).toBe(true);
    doc.hidden = false;
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(loop.paused).toBe(false);

    detach();
    win.dispatchEvent(new Event('blur'));
    expect(loop.paused).toBe(false);
  });

  it('never lifts a manual pause on focus', () => {
    const win = new EventTarget();
    const loop = new GameLoop({ step: () => {} });
    pauseOnBlur(loop, win);
    loop.pause('manual');
    win.dispatchEvent(new Event('blur'));
    win.dispatchEvent(new Event('focus'));
    expect(loop.paused).toBe(true);
    expect(loop.isPausedFor('manual')).toBe(true);
  });

  it('starts paused when the document is already hidden', () => {
    const doc = new FakeDocument();
    doc.hidden = true;
    const loop = new GameLoop({ step: () => {} });
    const detach = pauseOnBlur(loop, new EventTarget(), doc);
    expect(loop.isPausedFor('hidden')).toBe(true);
    detach();
    expect(loop.paused).toBe(false);
  });
});
