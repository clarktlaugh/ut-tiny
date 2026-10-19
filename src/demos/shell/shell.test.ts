import { describe, expect, it } from 'vitest';
import { FpsMeter, formatFeedback } from './feedback';
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
