/**
 * Gibs (docs/DESIGN.md §8.3): a handful of physics-less chunks per death that
 * fly ballistically, tumble, bounce once on the floor they were given and
 * shrink away. One `InstancedMesh`, one draw call; dead instances have a zero
 * scale matrix.
 */
import {
  Color,
  DodecahedronGeometry,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three';
import type { Vec3 } from '../../sim/types';
import { FX_GRAVITY } from './particles';
import { AllocationCounter, SlotPool } from './pool';

export interface GibSpawn {
  position: Vec3;
  velocity: Vec3;
  /** Angular velocity, radians per second about each axis. */
  spin: Vec3;
  /** Chunk size in meters (scale of a ~0.3 m chunk). */
  size: number;
  color: number;
  life: number;
  /** Y of the floor the chunk bounces on, or -Infinity to fall forever. */
  floorY: number;
}

const FLOATS = 14;
const PX = 0;
const PY = 1;
const PZ = 2;
const VX = 3;
const VY = 4;
const VZ = 5;
const SX = 6;
const SY = 7;
const SZ = 8;
const AGE = 9;
const LIFE = 10;
const SIZE = 11;
const FLOOR = 12;
const BOUNCES = 13;

const ZERO = new Matrix4().makeScale(0, 0, 0);
const mat = new Matrix4();
const q = new Quaternion();
const dq = new Quaternion();
const axis = new Vector3();
const pos = new Vector3();
const scl = new Vector3();
const tint = new Color();

export class GibPool {
  readonly mesh: InstancedMesh;
  readonly pool: SlotPool;
  readonly allocations = new AllocationCounter();
  private readonly state: Float32Array;
  private readonly rotations: Float32Array; // quaternion per slot

  constructor(readonly capacity: number) {
    const a = this.allocations;
    this.pool = a.track(new SlotPool(capacity));
    this.state = a.track(new Float32Array(capacity * FLOATS));
    this.rotations = a.track(new Float32Array(capacity * 4));
    const geometry = a.track(new DodecahedronGeometry(0.15, 0));
    const material = a.track(new MeshStandardMaterial({ roughness: 0.85, metalness: 0 }));
    this.mesh = a.track(new InstancedMesh(geometry, material, capacity));
    this.mesh.name = 'fx-gibs';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    for (let i = 0; i < capacity; i++) {
      this.mesh.setMatrixAt(i, ZERO);
      // Creates the instance color buffer once, up front.
      this.mesh.setColorAt(i, tint.setHex(0xffffff));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) {
      this.mesh.instanceColor.setUsage(DynamicDrawUsage);
      this.mesh.instanceColor.needsUpdate = true;
    }
  }

  get size(): number {
    return this.pool.size;
  }

  emit(g: Readonly<GibSpawn>): void {
    const slot = this.pool.acquire();
    const s = this.state;
    const o = slot * FLOATS;
    s[o + PX] = g.position.x;
    s[o + PY] = g.position.y;
    s[o + PZ] = g.position.z;
    s[o + VX] = g.velocity.x;
    s[o + VY] = g.velocity.y;
    s[o + VZ] = g.velocity.z;
    s[o + SX] = g.spin.x;
    s[o + SY] = g.spin.y;
    s[o + SZ] = g.spin.z;
    s[o + AGE] = 0;
    s[o + LIFE] = Math.max(1e-3, g.life);
    s[o + SIZE] = g.size;
    s[o + FLOOR] = g.floorY;
    s[o + BOUNCES] = 0;
    this.rotations.set([0, 0, 0, 1], slot * 4);
    this.mesh.setColorAt(slot, tint.setHex(g.color));
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  update(dt: number): void {
    const pool = this.pool;
    const s = this.state;
    for (let i = pool.size - 1; i >= 0; i--) {
      const slot = pool.at(i);
      const o = slot * FLOATS;
      const age = (s[o + AGE] as number) + dt;
      if (age >= (s[o + LIFE] as number)) {
        this.mesh.setMatrixAt(slot, ZERO);
        pool.release(slot);
        continue;
      }
      s[o + AGE] = age;
      let vy = (s[o + VY] as number) - FX_GRAVITY * dt;
      let px = (s[o + PX] as number) + (s[o + VX] as number) * dt;
      let py = (s[o + PY] as number) + vy * dt;
      let pz = (s[o + PZ] as number) + (s[o + VZ] as number) * dt;
      const floor = (s[o + FLOOR] as number) + (s[o + SIZE] as number) * 0.15;
      if (py < floor && vy < 0) {
        py = floor;
        if ((s[o + BOUNCES] as number) < 2 && -vy > 2) {
          vy = -vy * 0.35;
          s[o + VX] = (s[o + VX] as number) * 0.6;
          s[o + VZ] = (s[o + VZ] as number) * 0.6;
          s[o + SX] = (s[o + SX] as number) * 0.5;
          s[o + SY] = (s[o + SY] as number) * 0.5;
          s[o + SZ] = (s[o + SZ] as number) * 0.5;
          s[o + BOUNCES] = (s[o + BOUNCES] as number) + 1;
        } else {
          // Rest on the floor.
          vy = 0;
          px = (s[o + PX] as number) + (s[o + VX] as number) * dt * 0.2;
          pz = (s[o + PZ] as number) + (s[o + VZ] as number) * dt * 0.2;
          s[o + VX] = (s[o + VX] as number) * 0.8;
          s[o + VZ] = (s[o + VZ] as number) * 0.8;
          s[o + SX] = s[o + SY] = s[o + SZ] = 0;
        }
      }
      s[o + VY] = vy;
      s[o + PX] = px;
      s[o + PY] = py;
      s[o + PZ] = pz;
      // Tumble.
      const r = slot * 4;
      q.set(
        this.rotations[r] as number,
        this.rotations[r + 1] as number,
        this.rotations[r + 2] as number,
        this.rotations[r + 3] as number,
      );
      axis.set(s[o + SX] as number, s[o + SY] as number, s[o + SZ] as number);
      const w = axis.length();
      if (w > 1e-6) {
        dq.setFromAxisAngle(axis.multiplyScalar(1 / w), w * dt);
        q.premultiply(dq).normalize();
        this.rotations[r] = q.x;
        this.rotations[r + 1] = q.y;
        this.rotations[r + 2] = q.z;
        this.rotations[r + 3] = q.w;
      }
      // Shrink away over the last fifth of life.
      const t = age / (s[o + LIFE] as number);
      const shrink = t > 0.8 ? 1 - (t - 0.8) / 0.2 : 1;
      const size = (s[o + SIZE] as number) * shrink;
      pos.set(px, py, pz);
      scl.set(size, size, size);
      mat.compose(pos, q, scl);
      this.mesh.setMatrixAt(slot, mat);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Position of the live gib at dense index `i` (for tests). */
  positionAt(i: number, out: Vec3): Vec3 {
    const o = this.pool.at(i) * FLOATS;
    out.x = this.state[o + PX] as number;
    out.y = this.state[o + PY] as number;
    out.z = this.state[o + PZ] as number;
    return out;
  }

  clear(): void {
    for (let i = this.pool.size - 1; i >= 0; i--) this.mesh.setMatrixAt(this.pool.at(i), ZERO);
    this.pool.clear();
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshStandardMaterial).dispose();
    this.mesh.dispose();
    this.mesh.removeFromParent();
  }
}
