/**
 * Placeholder first-person weapon meshes (docs/DESIGN.md §5, §8.3).
 *
 * Each weapon is a handful of boxes and cylinders described as data, so the
 * shapes are easy to tweak and to test. Units are meters in view-model camera
 * space: the model's origin is the grip, the barrel points down −Z, +Y is up.
 * `WeaponModel.muzzle` is where the muzzle flash appears.
 *
 * These are stand-ins until real GLTF view models exist; the silhouettes are
 * meant to make the eight weapons tell apart at a glance.
 */
import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  type BufferGeometry,
} from 'three';
import type { WeaponId } from '../../sim/types';

export type PartMaterial = 'body' | 'dark' | 'metal' | 'accent' | 'glow';
export type PartShape = 'box' | 'cyl';

/** One primitive in a weapon model. */
export interface WeaponPart {
  shape: PartShape;
  /** Box: full extents. Cylinder (along Z): x = diameter, z = length (y ignored). */
  size: readonly [number, number, number];
  /** Center, in weapon space. */
  at: readonly [number, number, number];
  /** Rotation about X in radians (tilt a magazine, a scope mount...). */
  tiltX?: number;
  material: PartMaterial;
}

export interface WeaponModelDef {
  parts: readonly WeaponPart[];
  /** Muzzle position in weapon space. */
  muzzle: readonly [number, number, number];
  /** Body tint (the `body` material), so each weapon reads differently. */
  bodyColor: number;
  /** Tint for `accent` and `glow` parts. */
  accentColor: number;
}

const box = (
  size: WeaponPart['size'],
  at: WeaponPart['at'],
  material: PartMaterial,
  tiltX?: number,
): WeaponPart => ({ shape: 'box', size, at, material, ...(tiltX ? { tiltX } : {}) });

const cyl = (
  diameter: number,
  length: number,
  at: WeaponPart['at'],
  material: PartMaterial,
): WeaponPart => ({ shape: 'cyl', size: [diameter, 0, length], at, material });

/** Placeholder model per weapon (§5 slot order). */
export const WEAPON_MODELS: Readonly<Record<WeaponId, WeaponModelDef>> = {
  // Slot 1: translocator launcher with the disc riding on top.
  teleporter: {
    bodyColor: 0x3d6fb6,
    accentColor: 0x7fd4ff,
    muzzle: [0, 0.03, -0.3],
    parts: [
      box([0.06, 0.07, 0.26], [0, 0, -0.1], 'body'),
      box([0.035, 0.1, 0.045], [0, -0.07, 0.01], 'dark', 0.25),
      cyl(0.03, 0.08, [0, 0.03, -0.25], 'metal'),
      cyl(0.11, 0.022, [0, 0.055, -0.13], 'accent'),
      box([0.02, 0.012, 0.05], [0, 0.072, -0.13], 'glow'),
    ],
  },
  // Slot 2: assault rifle with an under-barrel grenade tube.
  assault: {
    bodyColor: 0x6b6f58,
    accentColor: 0xd9a441,
    muzzle: [0, 0.02, -0.46],
    parts: [
      box([0.06, 0.08, 0.3], [0, 0.005, -0.1], 'body'),
      cyl(0.022, 0.2, [0, 0.02, -0.34], 'metal'),
      cyl(0.04, 0.16, [0, -0.03, -0.3], 'dark'),
      box([0.035, 0.11, 0.05], [0, -0.085, -0.13], 'dark', -0.25),
      box([0.035, 0.09, 0.045], [0, -0.065, 0.02], 'dark', 0.25),
      box([0.045, 0.06, 0.1], [0, -0.005, 0.09], 'body'),
      box([0.02, 0.025, 0.08], [0, 0.055, -0.08], 'accent'),
    ],
  },
  // Slot 3: mine layer, a stubby launcher under a round hopper.
  mines: {
    bodyColor: 0x8a5a2b,
    accentColor: 0xff4a3d,
    muzzle: [0, 0, -0.32],
    parts: [
      box([0.08, 0.08, 0.24], [0, 0, -0.1], 'body'),
      cyl(0.07, 0.08, [0, 0, -0.26], 'dark'),
      cyl(0.09, 0.09, [0, 0.07, -0.09], 'metal'),
      box([0.035, 0.1, 0.045], [0, -0.075, 0.01], 'dark', 0.25),
      box([0.03, 0.015, 0.03], [0, 0.12, -0.09], 'glow'),
    ],
  },
  // Slot 4: rocket launcher, three-tube cluster on a heavy body.
  rocket: {
    bodyColor: 0x8c2f2f,
    accentColor: 0xf08a24,
    muzzle: [0, 0.03, -0.5],
    parts: [
      box([0.1, 0.1, 0.32], [0, 0, -0.08], 'body'),
      cyl(0.05, 0.3, [-0.028, 0.045, -0.33], 'metal'),
      cyl(0.05, 0.3, [0.028, 0.045, -0.33], 'metal'),
      cyl(0.05, 0.3, [0, -0.005, -0.33], 'metal'),
      box([0.04, 0.11, 0.05], [0, -0.09, 0.0], 'dark', 0.2),
      box([0.11, 0.02, 0.12], [0, 0.06, -0.06], 'accent'),
    ],
  },
  // Slot 5: sniper rifle, long thin barrel and a scope.
  sniper: {
    bodyColor: 0x4a3b2a,
    accentColor: 0x9fb7c9,
    muzzle: [0, 0.015, -0.66],
    parts: [
      box([0.05, 0.07, 0.36], [0, 0, -0.08], 'body'),
      cyl(0.018, 0.36, [0, 0.015, -0.44], 'metal'),
      cyl(0.04, 0.2, [0, 0.07, -0.12], 'dark'),
      box([0.015, 0.03, 0.02], [0, 0.04, -0.06], 'dark'),
      box([0.015, 0.03, 0.02], [0, 0.04, -0.18], 'dark'),
      box([0.035, 0.1, 0.045], [0, -0.07, 0.02], 'dark', 0.3),
      cyl(0.036, 0.004, [0, 0.07, -0.222], 'accent'),
    ],
  },
  // Slot 6: super shock rifle, boxy with glowing coils.
  shock: {
    bodyColor: 0xc8c8d4,
    accentColor: 0xb05cff,
    muzzle: [0, 0.01, -0.42],
    parts: [
      box([0.08, 0.09, 0.32], [0, 0, -0.1], 'body'),
      box([0.05, 0.05, 0.16], [0, 0.01, -0.33], 'metal'),
      cyl(0.1, 0.02, [0, 0.01, -0.29], 'glow'),
      cyl(0.1, 0.02, [0, 0.01, -0.33], 'glow'),
      cyl(0.1, 0.02, [0, 0.01, -0.37], 'glow'),
      box([0.035, 0.1, 0.045], [0, -0.075, 0.01], 'dark', 0.25),
      box([0.09, 0.015, 0.2], [0, 0.052, -0.12], 'accent'),
    ],
  },
  // Slot 7: scoped super shock rifle, same frame plus a scope.
  shockScoped: {
    bodyColor: 0xa8b0c8,
    accentColor: 0x5ca8ff,
    muzzle: [0, 0.01, -0.42],
    parts: [
      box([0.08, 0.09, 0.32], [0, 0, -0.1], 'body'),
      box([0.05, 0.05, 0.16], [0, 0.01, -0.33], 'metal'),
      cyl(0.1, 0.02, [0, 0.01, -0.29], 'glow'),
      cyl(0.1, 0.02, [0, 0.01, -0.33], 'glow'),
      cyl(0.1, 0.02, [0, 0.01, -0.37], 'glow'),
      box([0.035, 0.1, 0.045], [0, -0.075, 0.01], 'dark', 0.25),
      cyl(0.04, 0.18, [0, 0.08, -0.1], 'dark'),
      box([0.015, 0.03, 0.02], [0, 0.055, -0.05], 'dark'),
      box([0.015, 0.03, 0.02], [0, 0.055, -0.15], 'dark'),
    ],
  },
  // Slot 8: Redeemer, a fat launch tube with the warhead nose showing.
  redeemer: {
    bodyColor: 0x3f4a3a,
    accentColor: 0xf2d230,
    muzzle: [0, 0.02, -0.55],
    parts: [
      cyl(0.11, 0.44, [0, 0.02, -0.24], 'body'),
      cyl(0.08, 0.06, [0, 0.02, -0.49], 'accent'),
      cyl(0.05, 0.04, [0, 0.02, -0.53], 'metal'),
      box([0.04, 0.11, 0.05], [0, -0.09, -0.04], 'dark', 0.2),
      box([0.02, 0.03, 0.2], [0.06, 0.02, -0.24], 'accent'),
    ],
  },
};

/** A built weapon model: the root to add to the rig and its muzzle socket. */
export interface WeaponModel {
  readonly id: WeaponId;
  readonly root: Group;
  readonly muzzle: Object3D;
}

/**
 * Builds and caches weapon models. Geometry and materials are owned here and
 * freed by `dispose()`.
 */
export class WeaponModelLibrary {
  private readonly models = new Map<WeaponId, WeaponModel>();
  private readonly geometries: BufferGeometry[] = [];
  private readonly materials: MeshStandardMaterial[] = [];
  private readonly shared: Record<'dark' | 'metal', MeshStandardMaterial>;

  constructor() {
    this.shared = {
      dark: this.material(0x24262a, 0.75, 0.2),
      metal: this.material(0x8c9198, 0.35, 0.85),
    };
  }

  /** The model for `id`, built on first use. */
  get(id: WeaponId): WeaponModel {
    const existing = this.models.get(id);
    if (existing) return existing;
    const model = this.build(id, WEAPON_MODELS[id]);
    this.models.set(id, model);
    return model;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
    this.models.clear();
  }

  private material(color: number, roughness: number, metalness: number): MeshStandardMaterial {
    const m = new MeshStandardMaterial({ color, roughness, metalness });
    this.materials.push(m);
    return m;
  }

  private build(id: WeaponId, def: WeaponModelDef): WeaponModel {
    const body = this.material(def.bodyColor, 0.55, 0.3);
    const accent = this.material(def.accentColor, 0.4, 0.4);
    const glow = new MeshStandardMaterial({
      color: def.accentColor,
      emissive: def.accentColor,
      emissiveIntensity: 1.6,
      roughness: 0.3,
    });
    this.materials.push(glow);
    const mats: Record<PartMaterial, MeshStandardMaterial> = {
      body,
      accent,
      glow,
      dark: this.shared.dark,
      metal: this.shared.metal,
    };

    const root = new Group();
    root.name = `viewmodel:${id}`;
    for (const part of def.parts) {
      const mesh = new Mesh(this.geometry(part), mats[part.material]);
      mesh.position.set(part.at[0], part.at[1], part.at[2]);
      if (part.tiltX) mesh.rotation.x = part.tiltX;
      // Never culled: the view model is always on screen when drawn.
      mesh.frustumCulled = false;
      root.add(mesh);
    }
    const muzzle = new Object3D();
    muzzle.name = 'muzzle';
    muzzle.position.set(def.muzzle[0], def.muzzle[1], def.muzzle[2]);
    root.add(muzzle);
    return { id, root, muzzle };
  }

  private geometry(part: WeaponPart): BufferGeometry {
    let g: BufferGeometry;
    if (part.shape === 'box') {
      g = new BoxGeometry(part.size[0], part.size[1], part.size[2]);
    } else {
      const r = part.size[0] / 2;
      g = new CylinderGeometry(r, r, part.size[2], 16);
      // Cylinders are authored along Z (the barrel axis).
      g.rotateX(Math.PI / 2);
    }
    this.geometries.push(g);
    return g;
  }
}
