import { describe, expect, it } from 'vitest';
import { FpsMeter, formatFeedback } from './feedback';
import { FrameStats, perfNumbers } from './perf';
import { QUALITY, chooseQuality, pixelRatioFor } from './quality';

describe('chooseQuality', () => {
  it('picks low on touch and high otherwise', () => {
    expect(chooseQuality({ touch: true }).level).toBe('low');
    expect(chooseQuality({ touch: false }).level).toBe('high');
  });

  it('honours a valid override and ignores junk', () => {
    expect(chooseQuality({ touch: true, override: 'high' }).level).toBe('high');
    expect(chooseQuality({ touch: false, override: 'low' }).level).toBe('low');
    expect(chooseQuality({ touch: true, override: 'ultra' }).level).toBe('low');
  });

  it('caps the pixel ratio at 2 and never scales above 1', () => {
    for (const q of Object.values(QUALITY)) {
      expect(q.maxPixelRatio).toBeLessThanOrEqual(2);
      expect(q.renderScale).toBeLessThanOrEqual(1);
    }
    expect(QUALITY.low.shadows).toBe(false);
  });
});

describe('pixelRatioFor', () => {
  it('caps then scales', () => {
    expect(pixelRatioFor(QUALITY.high, 3)).toBe(2);
    expect(pixelRatioFor(QUALITY.high, 1)).toBe(1);
    expect(pixelRatioFor(QUALITY.low, 3)).toBe(1.5);
    expect(pixelRatioFor(QUALITY.low, 1)).toBe(0.75);
  });

  it('survives a bogus device pixel ratio', () => {
    expect(pixelRatioFor(QUALITY.high, Number.NaN)).toBe(1);
    expect(pixelRatioFor(QUALITY.high, 0)).toBe(1);
    expect(pixelRatioFor({ ...QUALITY.low, renderScale: 0.1 }, 1)).toBe(0.5);
  });
});

describe('formatFeedback', () => {
  const info = {
    slug: 'scene',
    title: 'Scene view',
    commit: 'abc1234',
    url: 'https://example.test/demos/scene.html?x=1',
    userAgent: 'TestAgent/1.0',
    viewport: { width: 844, height: 390 },
    devicePixelRatio: 3,
    touch: true,
    quality: 'low',
    fps: 58.6,
  };

  it('includes the demo, commit, device and FPS', () => {
    const text = formatFeedback(info);
    expect(text).toContain('Scene view');
    expect(text).toContain('`scene`');
    expect(text).toContain('`abc1234`');
    expect(text).toContain('touch, 844×390 @3x, quality low');
    expect(text).toContain('FPS: 59');
    expect(text).toContain('TestAgent/1.0');
    expect(text).toContain(info.url);
    expect(text).not.toContain('Tuning');
  });

  it('lists tuning values', () => {
    const text = formatFeedback({ ...info, tuning: { speed: 12, gravity: 19.25, mode: 'naive' } });
    expect(text).toContain('- Tuning:');
    expect(text).toContain('  - speed: 12');
    expect(text).toContain('  - gravity: 19.250');
    expect(text).toContain('  - mode: naive');
  });
});

describe('FpsMeter', () => {
  it('converges on the frame rate and ignores a reset gap', () => {
    const meter = new FpsMeter();
    let t = 0;
    for (let i = 0; i < 200; i++) meter.sample((t += 1000 / 30));
    expect(meter.fps).toBeCloseTo(30, 0);
    meter.reset();
    meter.sample(t + 60_000);
    expect(meter.fps).toBeCloseTo(30, 0);
  });
});

describe('FrameStats', () => {
  it('summarises the last window of frames', () => {
    const stats = new FrameStats(1000);
    let t = 0;
    stats.sample(t);
    for (let i = 0; i < 120; i++) stats.sample((t += i === 100 ? 50 : 10));
    const s = stats.summary();
    expect(s.worstMs).toBe(50);
    expect(s.frames).toBeLessThanOrEqual(101);
    expect(s.fps).toBeGreaterThan(80);
    stats.reset();
    expect(stats.summary().frames).toBe(0);
  });
});

describe('perfNumbers', () => {
  const base = {
    frames: { fps: 59.6, avgMs: 16.78, worstMs: 33.4, frames: 60 },
    devicePixelRatio: 3,
    pixelRatio: 1.5,
    renderScale: 0.75,
    quality: 'low',
  };

  it('lists frame times, DPR and render scale', () => {
    const n = perfNumbers(base);
    expect(n.fps).toBe('60');
    expect(n['frame ms']).toBe('avg 16.8, worst 33.4');
    expect(n.dpr).toBe('3');
    expect(n['render scale']).toBe('0.75 (pixel ratio 1.50, low)');
    expect(n['draw calls']).toBeUndefined();
    expect(n['JS heap']).toBeUndefined();
  });

  it('adds renderer info, heap and extras when present', () => {
    const n = perfNumbers({
      ...base,
      renderer: { render: { calls: 80, triangles: 4656 }, memory: { geometries: 12, textures: 3 } },
      heapBytes: 25 * 1024 * 1024,
      extra: { particles: 16 },
    });
    expect(n['draw calls']).toBe('80');
    expect(n.triangles).toBe('4656');
    expect(n.geometries).toBe('12');
    expect(n.textures).toBe('3');
    expect(n['JS heap']).toBe('25.0 MB');
    expect(n.particles).toBe('16');
  });

  it('goes into the feedback text', () => {
    const text = formatFeedback({
      slug: 'scene',
      title: 'Scene view',
      commit: 'abc1234',
      url: 'https://example.test/',
      userAgent: 'UA',
      viewport: { width: 1, height: 1 },
      devicePixelRatio: 1,
      touch: false,
      quality: 'high',
      fps: 60,
      perf: perfNumbers(base),
    });
    expect(text).toContain('- Performance:');
    expect(text).toContain('  - frame ms: avg 16.8, worst 33.4');
  });
});
