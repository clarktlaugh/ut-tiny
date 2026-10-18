/** Test helpers shared by the player-controller tests. */
import type { PawnState, WorldState } from '../../sim/types';

export function worldState(entities: WorldState['entities'] = []): WorldState {
  return {
    tick: 0,
    time: 0,
    rngState: 0,
    entities,
    match: {} as WorldState['match'],
  };
}

export function pawn(overrides: Partial<PawnState> = {}): PawnState {
  return {
    id: 1,
    kind: 'pawn',
    position: { x: 0, y: 0, z: 0 },
    playerId: 'local',
    alive: true,
    health: 100,
    shield: 0,
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    grounded: true,
    crouching: false,
    weapon: null,
    pendingWeapon: null,
    owned: [],
    ammo: {},
    spawnProtectedUntil: 0,
    respawnAt: 0,
    guiding: 0,
    disc: 0,
    viewingDisc: false,
    zoom: 1,
    udamageUntil: 0,
    ...overrides,
  };
}

/** A DOM-like event with arbitrary fields, including the read-only `timeStamp`. */
export function domEvent(type: string, fields: Record<string, unknown> = {}): Event {
  const event = new Event(type, { cancelable: true });
  for (const [key, value] of Object.entries(fields)) {
    Object.defineProperty(event, key, { value, configurable: true });
  }
  return event;
}
