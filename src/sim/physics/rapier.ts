/**
 * Loads the Rapier WASM module once. Every physics entry point awaits
 * `initPhysics()` before touching Rapier (docs/DESIGN.md §8.1).
 */
import RAPIER from '@dimforge/rapier3d-compat';

export type Rapier = typeof RAPIER;

let ready: Promise<Rapier> | null = null;

/** Initialise Rapier. Safe to call many times; the module loads once. */
export function initPhysics(): Promise<Rapier> {
  if (!ready) {
    ready = RAPIER.init().then(() => RAPIER);
  }
  return ready;
}
