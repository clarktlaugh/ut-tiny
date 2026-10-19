/**
 * Render quality for demos (docs/DESIGN.md §12): touch devices get the low
 * preset automatically; `?quality=low|high` overrides the choice.
 */

export type QualityLevel = 'low' | 'high';

export interface Quality {
  readonly level: QualityLevel;
  /** Device pixel ratio is capped at this before `renderScale` applies. */
  readonly maxPixelRatio: number;
  /** Multiplies the capped pixel ratio; at most 1. */
  readonly renderScale: number;
  readonly shadows: boolean;
  readonly antialias: boolean;
}

export const QUALITY: Readonly<Record<QualityLevel, Quality>> = {
  high: { level: 'high', maxPixelRatio: 2, renderScale: 1, shadows: true, antialias: true },
  low: { level: 'low', maxPixelRatio: 2, renderScale: 0.75, shadows: false, antialias: false },
};

export interface QualityEnv {
  /** Primary pointer is coarse (a phone or tablet). */
  readonly touch: boolean;
  /** Value of the `quality` query parameter, if any. */
  readonly override?: string | null;
}

export function chooseQuality(env: QualityEnv): Quality {
  if (env.override === 'low' || env.override === 'high') return QUALITY[env.override];
  return env.touch ? QUALITY.low : QUALITY.high;
}

/** Pixel ratio to hand the renderer: `min(dpr, cap) × scale`, never below 0.5. */
export function pixelRatioFor(quality: Quality, devicePixelRatio: number): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const scale = Math.min(1, Math.max(0, quality.renderScale));
  return Math.max(0.5, Math.min(dpr, quality.maxPixelRatio) * scale);
}
