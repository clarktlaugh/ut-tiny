/**
 * First-person muzzle flash (docs/DESIGN.md §5 common rules, §8.3).
 *
 * A flash is three crossed additive quads with a procedural star texture plus
 * a short-lived point light that lights the weapon. It sits at the current
 * weapon's muzzle socket and fades over `duration`. Rotation and size vary
 * per shot from a counter, not `Math.random`, so screenshots are repeatable.
 *
 * World-space flashes seen by other players belong to the FX system (P16).
 */
import {
  AdditiveBlending,
  DataTexture,
  DoubleSide,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  PointLight,
  RGBAFormat,
  type Object3D,
} from 'three';
import type { WeaponId } from '../../sim/types';

export interface FlashStyle {
  color: number;
  /** Quad size in meters at full scale. */
  size: number;
  /** Seconds the flash stays visible. */
  duration: number;
  /** Peak point-light intensity (0 = no light). */
  light: number;
}

/** Flash per weapon and fire mode; `null` means the mode has no flash. */
export const FLASH_STYLES: Readonly<
  Record<WeaponId, { primary: FlashStyle | null; alt: FlashStyle | null }>
> = {
  // Disc throw and teleport have no muzzle flash.
  teleporter: { primary: null, alt: null },
  assault: {
    primary: { color: 0xffc66b, size: 0.12, duration: 0.05, light: 2.5 },
    alt: { color: 0xffa040, size: 0.16, duration: 0.07, light: 3 },
  },
  mines: {
    primary: { color: 0xff8a50, size: 0.1, duration: 0.06, light: 1.5 },
    // Alt detonates mines remotely: nothing leaves the barrel.
    alt: null,
  },
  rocket: {
    primary: { color: 0xff9a3c, size: 0.24, duration: 0.09, light: 4 },
    alt: { color: 0xff9a3c, size: 0.24, duration: 0.09, light: 4 },
  },
  sniper: {
    primary: { color: 0xfff1c8, size: 0.16, duration: 0.06, light: 3 },
    // Alt is the zoom.
    alt: null,
  },
  shock: {
    primary: { color: 0xc58cff, size: 0.18, duration: 0.08, light: 3.5 },
    alt: { color: 0xc58cff, size: 0.18, duration: 0.08, light: 3.5 },
  },
  shockScoped: {
    primary: { color: 0x8cc4ff, size: 0.18, duration: 0.08, light: 3.5 },
    alt: null,
  },
  redeemer: {
    primary: { color: 0xffb347, size: 0.34, duration: 0.14, light: 5 },
    alt: { color: 0xffb347, size: 0.34, duration: 0.14, light: 5 },
  },
};

/** Flash style for a shot, or null if that mode shows none. */
export function flashStyleFor(weapon: WeaponId, mode: 'primary' | 'alt'): FlashStyle | null {
  return FLASH_STYLES[weapon][mode];
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Six-pointed soft star, white on transparent; tinted by the material color. */
function starTexture(size = 64): DataTexture {
  const data = new Uint8Array(size * size * 4);
  const half = (size - 1) / 2;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const dx = (i - half) / half;
      const dy = (j - half) / half;
      const r = Math.hypot(dx, dy);
      const a = Math.atan2(dy, dx);
      const spikes = Math.pow(Math.abs(Math.cos(a * 3)), 8);
      const core = Math.max(0, 1 - r * 2.2);
      const rays = Math.max(0, 1 - r) * spikes;
      const v = Math.min(1, core + rays * 0.9);
      const k = (j * size + i) * 4;
      data[k] = 255;
      data[k + 1] = 255;
      data[k + 2] = 255;
      data[k + 3] = Math.round(v * 255);
    }
  }
  const tex = new DataTexture(data, size, size, RGBAFormat);
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export class MuzzleFlash {
  /** Add to the view-model scene; it follows the muzzle via `update`. */
  readonly object = new Group();
  readonly light = new PointLight(0xffffff, 0, 1.5, 2);

  private readonly texture = starTexture();
  private readonly geometry = new PlaneGeometry(1, 1);
  private readonly material = new MeshBasicMaterial({
    map: this.texture,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
    toneMapped: false,
  });
  private style: FlashStyle | null = null;
  private age = 0;
  private count = 0;
  private scaleJitter = 1;
  private twist = 0;

  constructor() {
    this.object.name = 'muzzleFlash';
    // Three quads: one facing the viewer, two along the barrel.
    const front = new Mesh(this.geometry, this.material);
    const side = new Mesh(this.geometry, this.material);
    side.rotation.y = Math.PI / 2;
    side.scale.set(1.6, 1, 1);
    side.position.z = -0.4;
    const top = new Mesh(this.geometry, this.material);
    top.rotation.set(Math.PI / 2, 0, Math.PI / 2);
    top.scale.set(1, 1.6, 1);
    top.position.z = -0.4;
    for (const m of [front, side, top]) {
      m.frustumCulled = false;
      m.renderOrder = 10;
      this.object.add(m);
    }
    this.object.visible = false;
    this.object.add(this.light);
  }

  /** True while a flash is showing. */
  get active(): boolean {
    return this.style !== null;
  }

  /** Start a flash; `null` style is ignored. */
  trigger(style: FlashStyle | null): void {
    if (!style) return;
    this.style = style;
    this.age = 0;
    this.count++;
    this.twist = (this.count * GOLDEN_ANGLE) % (Math.PI * 2);
    this.scaleJitter = 0.8 + ((this.count * 0.618034) % 1) * 0.4;
    this.material.color.setHex(style.color);
    this.light.color.setHex(style.color);
  }

  /** Cut the flash immediately (weapon hidden, respawn). */
  stop(): void {
    this.style = null;
    this.object.visible = false;
    this.light.intensity = 0;
  }

  /**
   * Advance by `dt` seconds and place the flash at `muzzle` (an object in the
   * same scene, usually the current weapon's muzzle socket).
   */
  update(dt: number, muzzle: Object3D | null): void {
    const style = this.style;
    if (!style || !muzzle) {
      if (style && !muzzle) this.stop();
      return;
    }
    this.age += Math.max(0, dt);
    const t = this.age / style.duration;
    if (t >= 1) {
      this.stop();
      return;
    }
    muzzle.updateWorldMatrix(true, false);
    muzzle.getWorldPosition(this.object.position);
    // Keep the twist from `trigger`, align the quads with the barrel.
    muzzle.getWorldQuaternion(this.object.quaternion);
    this.object.rotateZ(this.twist);
    const fade = 1 - t;
    // Burst out fast, then shrink as it fades.
    const s = style.size * this.scaleJitter * (0.6 + 0.4 * Math.min(1, t * 4)) * (0.5 + 0.5 * fade);
    this.object.scale.setScalar(s);
    this.material.opacity = fade;
    this.light.intensity = style.light * fade;
    this.object.visible = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
    this.light.dispose();
  }
}
