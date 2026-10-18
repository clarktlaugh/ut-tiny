/**
 * Seeded pseudo-random number generator for the simulation.
 *
 * The simulation never calls `Math.random()`; every random decision (spawn
 * selection noise, weapon spread, bot aim error, pickup jitter) goes through a
 * `Rng` owned by the `World`, so a host and a replay produce identical results
 * from the same seed and inputs. See docs/DESIGN.md §8.1 and §10.
 *
 * Algorithm: mulberry32. A single 32-bit state word, which makes the generator
 * trivially snapshot-able (`getState` / `setState`) and cheap to fork. Quality is
 * ample for gameplay; it is not cryptographic.
 */
export class Rng {
  private state: number;

  /** @param seed Any integer. Only the low 32 bits are used. */
  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Current 32-bit state, suitable for inclusion in a world snapshot. */
  getState(): number {
    return this.state;
  }

  /** Restore a state previously returned by `getState`. */
  setState(state: number): void {
    this.state = state >>> 0;
  }

  /** Next raw 32-bit unsigned integer. */
  nextU32(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Uniform float in [0, 1). */
  nextFloat(): number {
    return this.nextU32() / 4294967296;
  }

  /** Uniform float in [min, max). */
  nextRange(min: number, max: number): number {
    return min + (max - min) * this.nextFloat();
  }

  /** Uniform integer in [0, n). `n` must be a positive integer. */
  nextInt(n: number): number {
    if (!Number.isInteger(n) || n <= 0) {
      throw new RangeError(`nextInt: n must be a positive integer, got ${n}`);
    }
    return Math.floor(this.nextFloat() * n);
  }

  /** `true` with probability `p` (default 0.5). */
  nextBool(p = 0.5): boolean {
    return this.nextFloat() < p;
  }

  /**
   * Standard normal sample (mean 0, standard deviation 1) via the Marsaglia
   * polar method. The spare value is deliberately discarded so the generator
   * carries no hidden state beyond the 32-bit word.
   */
  nextGaussian(): number {
    for (;;) {
      const u = this.nextFloat() * 2 - 1;
      const v = this.nextFloat() * 2 - 1;
      const s = u * u + v * v;
      if (s > 0 && s < 1) {
        return u * Math.sqrt((-2 * Math.log(s)) / s);
      }
    }
  }

  /** Uniformly chosen element. Throws on an empty array. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('pick: empty array');
    return items[this.nextInt(items.length)] as T;
  }

  /** In-place Fisher–Yates shuffle. Returns the same array for chaining. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.nextInt(i + 1);
      const a = items[i] as T;
      items[i] = items[j] as T;
      items[j] = a;
    }
    return items;
  }

  /**
   * A new generator seeded from this one's stream. Use it to give a subsystem
   * (one bot, one weapon) its own sequence without entangling call orders.
   */
  fork(): Rng {
    return new Rng(this.nextU32());
  }
}

/**
 * Derive a deterministic 32-bit seed from a string (for example a map name
 * plus a match id), so the same inputs reproduce the same match.
 */
export function seedFromString(text: string): number {
  // FNV-1a
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
