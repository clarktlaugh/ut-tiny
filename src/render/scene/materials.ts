/**
 * Placeholder materials for the grey-box scene (docs/DESIGN.md §8.3).
 *
 * `MapDef` brushes name a `MaterialId`; until the realistic material library
 * exists, each id resolves to a flat-colored `MeshStandardMaterial`. Known ids
 * (and ids that start with a known family, like `enamel-white`) get a fixed
 * color; anything else gets a stable muted color hashed from its name, so new
 * ids are visible and distinguishable without code changes.
 */
import { Color, MeshStandardMaterial } from 'three';
import type { MaterialId } from '../../sim/types';

/** Placeholder colors (sRGB hex) by material family. */
export const PLACEHOLDER_COLORS: Readonly<Record<string, number>> = {
  floor: 0x8a8378,
  tile: 0x9c968c,
  concrete: 0x7d7d7a,
  wall: 0xb9b2a4,
  drywall: 0xc4bdb0,
  ceiling: 0xd6d2c8,
  enamel: 0xe8e8e2,
  metal: 0x8f959c,
  chrome: 0xb8bec4,
  steel: 0x7f868d,
  wood: 0x8b6a47,
  plastic: 0x4f7fa8,
  fabric: 0x9a6f8e,
  cardboard: 0xa88a5f,
  rubber: 0x2f3236,
  glass: 0x9fc4cc,
  water: 0x3f6f8f,
  porcelain: 0xf0eee8,
  paper: 0xe2dccd,
};

/** Fallback for an empty id. */
const DEFAULT_COLOR = 0x9a9a9a;

/** 32-bit FNV-1a hash of a string. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Placeholder sRGB color for a material id: an exact family match, then the
 * family before the first `-`, `_`, `.` or `/`, then a hashed muted color.
 */
export function placeholderColor(id: MaterialId): number {
  if (!id) return DEFAULT_COLOR;
  const key = id.toLowerCase();
  const exact = PLACEHOLDER_COLORS[key];
  if (exact !== undefined) return exact;
  const family = key.split(/[-_./]/, 1)[0] ?? '';
  const byFamily = PLACEHOLDER_COLORS[family];
  if (byFamily !== undefined) return byFamily;
  const h = hashString(key);
  const color = new Color().setHSL((h % 360) / 360, 0.25, 0.55);
  return color.getHex();
}

/**
 * Approximate RGB (0..1, sRGB) of a black body at `kelvin`, for `LightDef`
 * color temperatures (§7). Tanner Helland's fit; clamped to 1000–40000 K.
 */
export function kelvinToRgb(kelvin: number): { r: number; g: number; b: number } {
  const t = Math.min(40000, Math.max(1000, kelvin)) / 100;
  let r: number;
  let g: number;
  let b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  }
  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const clamp = (v: number): number => Math.min(255, Math.max(0, v)) / 255;
  return { r: clamp(r), g: clamp(g), b: clamp(b) };
}

/** Three.js color for a color temperature. */
export function kelvinToColor(kelvin: number): Color {
  const { r, g, b } = kelvinToRgb(kelvin);
  return new Color().setRGB(r, g, b, 'srgb');
}

/** Caches one placeholder material per id; owns and disposes them. */
export class MaterialLibrary {
  private readonly cache = new Map<MaterialId, MeshStandardMaterial>();

  get(id: MaterialId): MeshStandardMaterial {
    let mat = this.cache.get(id);
    if (!mat) {
      const key = id.toLowerCase();
      const shiny = /^(enamel|chrome|metal|steel|porcelain|glass)/.test(key);
      mat = new MeshStandardMaterial({
        name: id,
        color: placeholderColor(id),
        roughness: shiny ? 0.35 : 0.85,
        metalness: /^(chrome|metal|steel)/.test(key) ? 0.6 : 0,
        flatShading: true,
      });
      this.cache.set(id, mat);
    }
    return mat;
  }

  /** Number of distinct materials created so far. */
  get size(): number {
    return this.cache.size;
  }

  dispose(): void {
    for (const mat of this.cache.values()) mat.dispose();
    this.cache.clear();
  }
}
