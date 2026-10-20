import { describe, expect, it } from 'vitest';
import { DEFAULT_MOVEMENT, MOVEMENT_TUNABLES, createMovementConfig } from '../../sim/movement';
import {
  PRESETS,
  TUNING_STORAGE_KEY,
  applyPreset,
  applyTuning,
  formatValue,
  loadTuning,
  overrides,
  saveTuning,
  snapValue,
  tuningFeedback,
} from './tuning';

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

describe('walkabout tuning', () => {
  it('starts at the §4 defaults with nothing overridden', () => {
    const config = createMovementConfig();
    expect(overrides(config)).toEqual({});
    expect(tuningFeedback(config)).toEqual({ movement: '§4 defaults' });
  });

  it('reports changed values with units and the §4 value', () => {
    const config = createMovementConfig({ groundSpeed: 10, gravity: 15 });
    const fb = tuningFeedback(config);
    expect(fb.movement).toBe('custom (2 values changed)');
    expect(fb['groundSpeed (m/s)']).toBe('10.0 (§4 8.8)');
    expect(fb['gravity (m/s²)']).toBe('15.0 (§4 19.0)');
  });

  it('names a preset when the overrides match one', () => {
    const config = createMovementConfig();
    const soft = PRESETS.find((p) => p.id === 'soft')!;
    expect(applyPreset(config, soft).sort()).toEqual(
      ['fallDamageLethalSpeed', 'fallDamageMinSpeed'].sort(),
    );
    expect(tuningFeedback(config).movement).toBe('Soft landings');
    // Back to spec.
    expect(applyPreset(config, PRESETS[0]!).length).toBe(2);
    expect(config).toEqual(DEFAULT_MOVEMENT);
  });

  it('applyTuning ignores unknown and non-finite values', () => {
    const config = createMovementConfig();
    const changed = applyTuning(config, {
      jumpSpeed: Number.NaN,
      dodgeSpeed: 13,
      ...({ bogus: 1 } as object),
    });
    expect(changed).toEqual(['dodgeSpeed']);
    expect(config.jumpSpeed).toBe(DEFAULT_MOVEMENT.jumpSpeed);
    expect(config.dodgeSpeed).toBe(13);
  });

  it('snaps values to the slider step and range', () => {
    const speed = MOVEMENT_TUNABLES.find((t) => t.key === 'groundSpeed')!;
    expect(snapValue(speed, 9.04)).toBe(9);
    expect(snapValue(speed, 9.06)).toBe(9.1);
    expect(snapValue(speed, 99)).toBe(speed.max);
    expect(snapValue(speed, -1)).toBe(speed.min);
    expect(snapValue(speed, Number.NaN)).toBe(speed.min);
    const accel = MOVEMENT_TUNABLES.find((t) => t.key === 'groundAccelTime')!;
    expect(formatValue(accel, 0.1)).toBe('0.10');
    expect(formatValue(speed, 8.8)).toBe('8.8');
  });

  it('persists only the overrides and clears the entry at the defaults', () => {
    const storage = new MemoryStorage();
    const config = createMovementConfig({ airControl: 0.5 });
    saveTuning(config, storage);
    expect(JSON.parse(storage.getItem(TUNING_STORAGE_KEY)!)).toEqual({ airControl: 0.5 });
    const fresh = createMovementConfig();
    expect(loadTuning(fresh, storage)).toEqual(['airControl']);
    expect(fresh.airControl).toBe(0.5);
    applyTuning(fresh, { airControl: DEFAULT_MOVEMENT.airControl });
    saveTuning(fresh, storage);
    expect(storage.getItem(TUNING_STORAGE_KEY)).toBeNull();
    // Garbage in storage is ignored.
    storage.setItem(TUNING_STORAGE_KEY, '{"groundSpeed":"fast","gravity":null,"x":1');
    expect(loadTuning(createMovementConfig(), storage)).toEqual([]);
  });

  it('works without storage', () => {
    const config = createMovementConfig({ gravity: 10 });
    expect(() => saveTuning(config, null)).not.toThrow();
    expect(loadTuning(config, null)).toEqual([]);
  });
});
