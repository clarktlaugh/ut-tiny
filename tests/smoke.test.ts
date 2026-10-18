import { describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { Vector3 } from 'three';

describe('scaffold', () => {
  it('runs vitest', () => {
    expect(1 + 1).toBe(2);
  });

  it('resolves three', () => {
    expect(new Vector3(1, 2, 3).length()).toBeCloseTo(Math.sqrt(14));
  });

  it('loads rapier wasm', async () => {
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    expect(world.gravity.y).toBeCloseTo(-9.81);
    world.free();
  });
});
