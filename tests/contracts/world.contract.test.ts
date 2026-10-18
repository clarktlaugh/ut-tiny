/**
 * Behavioral contract for `World` (docs/DESIGN.md §8.1). These are filled in by
 * the packets that implement the simulation (P3, P6, P7, P11–P14, P18, P23).
 * Each `it.todo` names an observable guarantee other code relies on.
 */
import { describe, it } from 'vitest';

describe('World.step', () => {
  it.todo('advances tick by exactly one and time by TICK_DT per call');
  it.todo('treats pawns missing from the input map as receiving NULL_INPUT');
  it.todo('is deterministic: same options and inputs produce identical states and events');
  it.todo('never reads Date.now, performance.now or Math.random (lint rule + runtime guard)');
  it.todo('returns events in the order they occurred within the tick');
  it.todo('emits entitySpawned before any other event about that entity');
  it.todo('emits entityDestroyed as the last event about that entity');
});

describe('World participants', () => {
  it.todo('addPlayer creates a dead pawn and returns its id; pawnFor finds it');
  it.todo('addPlayer with isBot=true carries the skill level onto the pawn state');
  it.todo('removePlayer destroys the pawn and every projectile, mine and disc it owns');
  it.todo('entity ids are never reused within a match');
});

describe('World state', () => {
  it.todo('getState().rngState equals the internal Rng state');
  it.todo('getState() reflects the last completed tick, not a partial one');
});

describe('SnapshotCodec', () => {
  it.todo('decode(encode(state)) equals state up to position quantisation (1 cm)');
  it.todo('quaternions round-trip within 0.001 per component');
  it.todo('encodes 8 pawns and 50 projectiles in under 4 KB');
});
