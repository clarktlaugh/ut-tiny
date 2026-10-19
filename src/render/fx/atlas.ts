/**
 * Procedural sprite sheet for particles and decals (docs/DESIGN.md §8.3).
 *
 * A 4 × 4 atlas of 64 px cells generated on the CPU into a `DataTexture`, so
 * the FX system needs no image assets and works in tests without a canvas.
 * Every cell is a white shape with an alpha mask; particles tint it with their
 * vertex color. Values are deterministic (hash noise, no `Math.random`).
 */
import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RGBAFormat,
  UnsignedByteType,
} from 'three';

/** Cells per atlas side. */
export const ATLAS_CELLS = 4;
/** Pixels per cell side. */
export const ATLAS_CELL_PX = 64;
/** Atlas side in pixels. */
export const ATLAS_PX = ATLAS_CELLS * ATLAS_CELL_PX;

/** Frame indices into the atlas (row-major from the top-left cell). */
export const Frame = {
  /** Soft gaussian blob: glows, fireballs, muzzle flashes. */
  Glow: 0,
  /** Small hard dot with a short falloff: sparks and embers. */
  Spark: 1,
  /** Noisy soft puff: smoke and dust. */
  Smoke: 2,
  /** Thin ring: shockwaves and the shock-beam impact. */
  Ring: 3,
  /** Four-point star: muzzle flash cores and the shock flare. */
  Flare: 4,
  /** Irregular dark splat: explosion scorch marks. */
  Scorch: 5,
  /** Bullet hole: dark center with a chipped rim. */
  Hole: 6,
  /** Horizontal soft streak: tracer heads. */
  Streak: 7,
  /** Solid disc: blood drops and debris. */
  Disc: 8,
} as const;

export type FrameIndex = (typeof Frame)[keyof typeof Frame];

/** Deterministic hash → [0, 1). */
function hash2(x: number, y: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1) with `freq` lattice cells per unit. */
function valueNoise(u: number, v: number, freq: number, seed: number): number {
  const x = u * freq;
  const y = v * freq;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const n00 = hash2(x0 + seed * 131, y0);
  const n10 = hash2(x0 + 1 + seed * 131, y0);
  const n01 = hash2(x0 + seed * 131, y0 + 1);
  const n11 = hash2(x0 + 1 + seed * 131, y0 + 1);
  const a = n00 + (n10 - n00) * sx;
  const b = n01 + (n11 - n01) * sx;
  return a + (b - a) * sy;
}

/** Two octaves of value noise in [0, 1). */
function fbm(u: number, v: number, seed: number): number {
  return valueNoise(u, v, 4, seed) * 0.65 + valueNoise(u, v, 9, seed + 7) * 0.35;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (edge0: number, edge1: number, v: number): number => {
  const t = clamp01((v - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

/**
 * Alpha of a cell at normalised coordinates `u, v` in [0, 1] (origin bottom
 * left), with `d` the distance from the cell center in [0, ~0.7].
 */
export function cellAlpha(frame: number, u: number, v: number): number {
  const dx = u - 0.5;
  const dy = v - 0.5;
  const d = Math.hypot(dx, dy) * 2; // 0 at center, 1 at the inscribed circle
  switch (frame) {
    case Frame.Glow:
      return clamp01(Math.exp(-d * d * 4.5) - Math.exp(-4.5) * (1 - d * d)) * (d < 1 ? 1 : 0);
    case Frame.Spark:
      return clamp01(1 - smooth(0.15, 0.6, d));
    case Frame.Smoke: {
      const n = fbm(u, v, 3);
      const edge = 1 - smooth(0.45 + (n - 0.5) * 0.5, 1, d);
      return clamp01(edge * (0.6 + n * 0.4));
    }
    case Frame.Ring:
      return clamp01(1 - smooth(0, 0.16, Math.abs(d - 0.78)));
    case Frame.Flare: {
      const ax = Math.abs(dx) * 2;
      const ay = Math.abs(dy) * 2;
      const arms = Math.max(
        clamp01(1 - ax * 8) * clamp01(1 - ay),
        clamp01(1 - ay * 8) * clamp01(1 - ax),
      );
      return clamp01(arms + Math.exp(-d * d * 9));
    }
    case Frame.Scorch: {
      const n = fbm(u, v, 11);
      const edge = 1 - smooth(0.35 + (n - 0.5) * 0.7, 0.98, d);
      return clamp01(edge * (0.55 + n * 0.45));
    }
    case Frame.Hole: {
      const n = fbm(u, v, 5);
      const core = 1 - smooth(0.35, 0.5, d);
      const rim = (1 - smooth(0.5, 0.85 + (n - 0.5) * 0.3, d)) * 0.55;
      return clamp01(Math.max(core, rim));
    }
    case Frame.Streak: {
      const along = 1 - smooth(0.55, 1, Math.abs(dx) * 2);
      const across = Math.exp(-dy * dy * 90);
      return clamp01(along * across);
    }
    case Frame.Disc:
      return clamp01(1 - smooth(0.8, 0.95, d));
    default:
      return 0;
  }
}

/** Fill an RGBA byte buffer with the atlas (white, alpha = mask). */
export function buildAtlasPixels(): Uint8Array {
  const data = new Uint8Array(ATLAS_PX * ATLAS_PX * 4);
  for (let frame = 0; frame < ATLAS_CELLS * ATLAS_CELLS; frame++) {
    const col = frame % ATLAS_CELLS;
    const row = Math.floor(frame / ATLAS_CELLS);
    // Rows count from the top of the image; texture v = 0 is the bottom row.
    const py0 = (ATLAS_CELLS - 1 - row) * ATLAS_CELL_PX;
    const px0 = col * ATLAS_CELL_PX;
    for (let y = 0; y < ATLAS_CELL_PX; y++) {
      for (let x = 0; x < ATLAS_CELL_PX; x++) {
        const u = (x + 0.5) / ATLAS_CELL_PX;
        const v = (y + 0.5) / ATLAS_CELL_PX;
        const a = Math.round(cellAlpha(frame, u, v) * 255);
        const i = ((py0 + y) * ATLAS_PX + px0 + x) * 4;
        data[i] = 255;
        data[i + 1] = 255;
        data[i + 2] = 255;
        data[i + 3] = a;
      }
    }
  }
  return data;
}

/** Build the atlas texture. One per FX system; `dispose()` it with the system. */
export function createAtlasTexture(): DataTexture {
  const tex = new DataTexture(buildAtlasPixels(), ATLAS_PX, ATLAS_PX, RGBAFormat, UnsignedByteType);
  tex.name = 'fx-atlas';
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** UV rectangle of a frame: `[u0, v0, u1, v1]` with v = 0 at the bottom. */
export function frameUv(frame: number): [number, number, number, number] {
  const col = frame % ATLAS_CELLS;
  const row = Math.floor(frame / ATLAS_CELLS);
  const u0 = col / ATLAS_CELLS;
  const v0 = (ATLAS_CELLS - 1 - row) / ATLAS_CELLS;
  // Inset by a texel so neighbouring cells never bleed in with linear filtering.
  const inset = 1 / ATLAS_PX;
  return [u0 + inset, v0 + inset, u0 + 1 / ATLAS_CELLS - inset, v0 + 1 / ATLAS_CELLS - inset];
}
