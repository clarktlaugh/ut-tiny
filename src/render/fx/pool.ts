/**
 * Fixed-capacity slot pools for the FX system (docs/DESIGN.md §8.3, §12).
 *
 * Every FX subsystem preallocates its slots and GPU buffers once, in its
 * constructor, and never grows: when a pool is full the oldest live slot is
 * recycled. `allocations` counts constructor-time allocations so tests can
 * assert that nothing is created after warm-up.
 */

/**
 * Tracks live slots in a dense array so that iteration and swap-removal are
 * O(1) and allocation-free. Slot indices are stable while a slot is alive.
 */
export class SlotPool {
  /** Dense list of live slot indices (order changes on release). */
  private readonly live: Int32Array;
  /** Spawn stamp per slot, to find the oldest when recycling. */
  private readonly stamp: Float64Array;
  private counter = 0;
  /** Position of each slot in `live`, or -1 when free. */
  private readonly position: Int32Array;
  /** Free slot indices as a stack. */
  private readonly free: Int32Array;
  private freeCount: number;
  private liveCount = 0;
  /** Total slots handed out since construction, including recycled ones. */
  spawned = 0;
  /** Live slots recycled because the pool was full. */
  recycled = 0;

  constructor(readonly capacity: number) {
    if (!(Number.isInteger(capacity) && capacity > 0)) {
      throw new RangeError(`SlotPool: capacity must be a positive integer, got ${capacity}`);
    }
    this.live = new Int32Array(capacity);
    this.position = new Int32Array(capacity).fill(-1);
    this.stamp = new Float64Array(capacity);
    this.free = new Int32Array(capacity);
    for (let i = 0; i < capacity; i++) this.free[i] = capacity - 1 - i;
    this.freeCount = capacity;
  }

  /** Number of live slots. */
  get size(): number {
    return this.liveCount;
  }

  /** Live slot index at dense position `i`. */
  at(i: number): number {
    return this.live[i] as number;
  }

  /** True while the slot is in use. */
  isLive(slot: number): boolean {
    return (this.position[slot] as number) >= 0;
  }

  /**
   * Take a slot. When the pool is full the oldest live slot is released and
   * returned, so the caller must fully re-initialise whatever it gets.
   */
  acquire(): number {
    if (this.freeCount === 0) {
      this.release(this.oldest());
      this.recycled++;
    }
    const slot = this.free[--this.freeCount] as number;
    this.position[slot] = this.liveCount;
    this.live[this.liveCount++] = slot;
    this.stamp[slot] = ++this.counter;
    this.spawned++;
    return slot;
  }

  /** Live slot with the earliest spawn. Only scanned when the pool is full. */
  oldest(): number {
    let best = this.live[0] as number;
    let bestStamp = this.stamp[best] as number;
    for (let i = 1; i < this.liveCount; i++) {
      const slot = this.live[i] as number;
      const st = this.stamp[slot] as number;
      if (st < bestStamp) {
        bestStamp = st;
        best = slot;
      }
    }
    return best;
  }

  /** Give a slot back. The last live slot takes its dense position. */
  release(slot: number): void {
    const pos = this.position[slot] as number;
    if (pos < 0) return;
    const lastPos = this.liveCount - 1;
    const moved = this.live[lastPos] as number;
    this.live[pos] = moved;
    this.position[moved] = pos;
    this.position[slot] = -1;
    this.liveCount = lastPos;
    this.free[this.freeCount++] = slot;
  }

  /** Release everything. */
  clear(): void {
    while (this.liveCount > 0) this.release(this.live[this.liveCount - 1] as number);
  }
}

/**
 * Ring of fixed slots for things that are overwritten rather than released
 * (decals). `next()` returns the slot to write and advances, wrapping around.
 */
export class RingPool {
  private head = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    if (!(Number.isInteger(capacity) && capacity > 0)) {
      throw new RangeError(`RingPool: capacity must be a positive integer, got ${capacity}`);
    }
  }

  /** Number of slots written so far, capped at the capacity. */
  get size(): number {
    return this.count;
  }

  /** Next slot to write; the oldest once the ring is full. */
  next(): number {
    const slot = this.head;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    return slot;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }
}

/** Counter for constructor-time allocations, reported in `FxStats`. */
export class AllocationCounter {
  count = 0;

  /** Record `n` allocations and return the value for chaining. */
  track<T>(value: T, n = 1): T {
    this.count += n;
    return value;
  }
}
