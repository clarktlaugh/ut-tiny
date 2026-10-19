/**
 * Pooled light flashes (docs/DESIGN.md §8.3): a few `PointLight`s that
 * explosions, muzzle flashes and beam impacts borrow for a fraction of a
 * second. The lights always stay in the scene (toggling lights recompiles
 * every lit shader); idle ones sit at intensity 0.
 */
import { Group, PointLight } from 'three';
import type { Vec3 } from '../../sim/types';
import { AllocationCounter, SlotPool } from './pool';

export interface FlashSpawn {
  position: Vec3;
  color: number;
  /** Peak intensity (candela-ish, physically based units are off in the grey box). */
  intensity: number;
  /** Light range in meters. */
  distance: number;
  /** Seconds until the light is out. */
  life: number;
}

export class LightFlashPool {
  readonly root = new Group();
  readonly pool: SlotPool;
  readonly allocations = new AllocationCounter();
  private readonly lights: PointLight[];
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly peak: Float32Array;

  constructor(readonly capacity: number) {
    const a = this.allocations;
    a.track(this.root);
    this.root.name = 'fx-flashes';
    this.pool = a.track(new SlotPool(capacity));
    this.age = a.track(new Float32Array(capacity));
    this.life = a.track(new Float32Array(capacity));
    this.peak = a.track(new Float32Array(capacity));
    this.lights = [];
    for (let i = 0; i < capacity; i++) {
      const light = a.track(new PointLight(0xffffff, 0, 10, 2));
      light.name = `fx-flash-${i}`;
      this.lights.push(light);
      this.root.add(light);
    }
  }

  get size(): number {
    return this.pool.size;
  }

  /** Light at a dense index (for tests). */
  lightAt(i: number): PointLight {
    return this.lights[this.pool.at(i)] as PointLight;
  }

  flash(f: Readonly<FlashSpawn>): void {
    const slot = this.pool.acquire();
    const light = this.lights[slot] as PointLight;
    light.position.set(f.position.x, f.position.y, f.position.z);
    light.color.setHex(f.color);
    light.distance = f.distance;
    light.intensity = f.intensity;
    this.age[slot] = 0;
    this.life[slot] = Math.max(1e-3, f.life);
    this.peak[slot] = f.intensity;
  }

  update(dt: number): void {
    const pool = this.pool;
    for (let i = pool.size - 1; i >= 0; i--) {
      const slot = pool.at(i);
      const age = (this.age[slot] as number) + dt;
      const life = this.life[slot] as number;
      const light = this.lights[slot] as PointLight;
      if (age >= life) {
        light.intensity = 0;
        pool.release(slot);
        continue;
      }
      this.age[slot] = age;
      const k = 1 - age / life;
      light.intensity = (this.peak[slot] as number) * k * k;
    }
  }

  clear(): void {
    for (const light of this.lights) light.intensity = 0;
    this.pool.clear();
  }

  dispose(): void {
    for (const light of this.lights) light.dispose();
    this.root.removeFromParent();
  }
}
