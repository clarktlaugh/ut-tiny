/**
 * Capped decals (docs/DESIGN.md §8.3): bullet holes and scorch marks as a
 * ring of textured quads in one geometry. When the ring is full the oldest
 * decal is overwritten. Each decal fades out over the last part of its life.
 */
import {
  BufferGeometry,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  Vector3,
  type Texture,
} from 'three';
import type { Vec3 } from '../../sim/types';
import { frameUv } from './atlas';
import { unpackColor } from './particles';
import { AllocationCounter, RingPool } from './pool';

export interface DecalSpawn {
  /** Surface point. */
  position: Vec3;
  /** Surface normal (unit). */
  normal: Vec3;
  /** Side length in meters. */
  size: number;
  /** Atlas frame (`Frame.Hole`, `Frame.Scorch`). */
  frame: number;
  color: number;
  alpha: number;
  /** Rotation about the normal, radians. */
  rotation: number;
  /** Seconds before the decal is gone. */
  life: number;
}

/** Lift above the surface to avoid z-fighting, meters. */
export const DECAL_OFFSET = 0.03;
/** Fraction of `life` over which a decal fades out. */
export const DECAL_FADE = 0.25;

const vN = new Vector3();
const vT = new Vector3();
const vB = new Vector3();
const vC = new Vector3();

export class DecalPool {
  readonly mesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  readonly ring: RingPool;
  readonly allocations = new AllocationCounter();
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly alpha: Float32Array;
  private readonly positions: Float32BufferAttribute;
  private readonly uvs: Float32BufferAttribute;
  private readonly colors: Float32BufferAttribute;

  constructor(
    atlas: Texture,
    readonly capacity: number,
  ) {
    const a = this.allocations;
    this.ring = a.track(new RingPool(capacity));
    this.age = a.track(new Float32Array(capacity));
    this.life = a.track(new Float32Array(capacity));
    this.alpha = a.track(new Float32Array(capacity));
    const geometry = a.track(new BufferGeometry());
    this.positions = a.track(new Float32BufferAttribute(capacity * 12, 3));
    this.positions.setUsage(DynamicDrawUsage);
    this.uvs = a.track(new Float32BufferAttribute(capacity * 8, 2));
    this.uvs.setUsage(DynamicDrawUsage);
    this.colors = a.track(new Float32BufferAttribute(capacity * 16, 4));
    this.colors.setUsage(DynamicDrawUsage);
    const index: number[] = [];
    for (let q = 0; q < capacity; q++) {
      const v = q * 4;
      index.push(v, v + 1, v + 2, v, v + 2, v + 3);
    }
    geometry.setAttribute('position', this.positions);
    geometry.setAttribute('uv', this.uvs);
    geometry.setAttribute('color', this.colors);
    geometry.setIndex(index);
    geometry.setDrawRange(0, 0);
    const material = a.track(
      new MeshBasicMaterial({
        map: atlas,
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: NormalBlending,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    );
    this.mesh = a.track(new Mesh(geometry, material));
    this.mesh.name = 'fx-decals';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
  }

  get size(): number {
    return this.ring.size;
  }

  place(d: Readonly<DecalSpawn>): void {
    const slot = this.ring.next();
    vN.set(d.normal.x, d.normal.y, d.normal.z);
    if (vN.lengthSq() < 1e-8) vN.set(0, 1, 0);
    vN.normalize();
    // Tangent frame: pick the world axis least aligned with the normal.
    const ax = Math.abs(vN.x);
    const ay = Math.abs(vN.y);
    const az = Math.abs(vN.z);
    if (ax <= ay && ax <= az) vT.set(1, 0, 0);
    else if (ay <= az) vT.set(0, 1, 0);
    else vT.set(0, 0, 1);
    vB.crossVectors(vN, vT).normalize();
    vT.crossVectors(vB, vN).normalize();
    const c = Math.cos(d.rotation);
    const s = Math.sin(d.rotation);
    // Rotate the tangent frame about the normal.
    const tx = vT.x * c + vB.x * s;
    const ty = vT.y * c + vB.y * s;
    const tz = vT.z * c + vB.z * s;
    vB.set(vB.x * c - vT.x * s, vB.y * c - vT.y * s, vB.z * c - vT.z * s);
    vT.set(tx, ty, tz);
    vC.set(d.position.x, d.position.y, d.position.z).addScaledVector(vN, DECAL_OFFSET);
    const h = d.size / 2;
    const pos = this.positions.array as Float32Array;
    const corner = (k: number, st: number, sb: number): void => {
      const j = (slot * 4 + k) * 3;
      pos[j] = vC.x + vT.x * h * st + vB.x * h * sb;
      pos[j + 1] = vC.y + vT.y * h * st + vB.y * h * sb;
      pos[j + 2] = vC.z + vT.z * h * st + vB.z * h * sb;
    };
    corner(0, -1, -1);
    corner(1, 1, -1);
    corner(2, 1, 1);
    corner(3, -1, 1);
    const [u0, v0, u1, v1] = frameUv(d.frame);
    const uv = this.uvs.array as Float32Array;
    uv.set([u0, v0, u1, v0, u1, v1, u0, v1], slot * 8);
    const col = this.colors.array as Float32Array;
    for (let k = 0; k < 4; k++) {
      unpackColor(d.color, col, (slot * 4 + k) * 4);
      col[(slot * 4 + k) * 4 + 3] = d.alpha;
    }
    this.age[slot] = 0;
    this.life[slot] = Math.max(1e-3, d.life);
    this.alpha[slot] = d.alpha;
    this.positions.needsUpdate = true;
    this.uvs.needsUpdate = true;
    this.colors.needsUpdate = true;
    this.mesh.geometry.setDrawRange(0, this.ring.size * 6);
  }

  update(dt: number): void {
    const col = this.colors.array as Float32Array;
    const pos = this.positions.array as Float32Array;
    const n = this.ring.size;
    let changed = false;
    for (let slot = 0; slot < n; slot++) {
      const life = this.life[slot] as number;
      if (life <= 0) continue; // already expired
      const age = (this.age[slot] as number) + dt;
      this.age[slot] = age;
      let alpha = this.alpha[slot] as number;
      if (age >= life) {
        alpha = 0;
        this.life[slot] = 0;
        // Collapse the quad so it is not rasterised at all.
        pos.fill(0, slot * 12, slot * 12 + 12);
        this.positions.needsUpdate = true;
      } else {
        const fadeStart = life * (1 - DECAL_FADE);
        if (age > fadeStart) alpha *= 1 - (age - fadeStart) / (life - fadeStart);
        else continue;
      }
      for (let k = 0; k < 4; k++) col[(slot * 4 + k) * 4 + 3] = alpha;
      changed = true;
    }
    if (changed) this.colors.needsUpdate = true;
  }

  /** Alpha of the decal in `slot` (for tests). */
  alphaAt(slot: number): number {
    return (this.colors.array as Float32Array)[slot * 16 + 3] as number;
  }

  /** Center of the decal in `slot` (for tests). */
  centerAt(slot: number, out: Vec3): Vec3 {
    const pos = this.positions.array as Float32Array;
    out.x = out.y = out.z = 0;
    for (let k = 0; k < 4; k++) {
      out.x += (pos[(slot * 4 + k) * 3] as number) / 4;
      out.y += (pos[(slot * 4 + k) * 3 + 1] as number) / 4;
      out.z += (pos[(slot * 4 + k) * 3 + 2] as number) / 4;
    }
    return out;
  }

  buffers(): readonly ArrayBufferView[] {
    return [this.positions.array, this.uvs.array, this.colors.array];
  }

  clear(): void {
    this.ring.clear();
    (this.positions.array as Float32Array).fill(0);
    this.positions.needsUpdate = true;
    this.mesh.geometry.setDrawRange(0, 0);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.removeFromParent();
  }
}
