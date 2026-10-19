/** Mocked world state for HUD tests and the dev demo. */
import { WEAPONS } from '../../data/weapons';
import type { PawnState, WorldState } from '../../sim/types';

export const LOCAL_PAWN = 1;
export const ENEMY_PAWN = 2;

export function mockPawn(over: Partial<PawnState> = {}): PawnState {
  return {
    id: LOCAL_PAWN,
    kind: 'pawn',
    position: { x: 0, y: 0, z: 0 },
    playerId: 'you',
    alive: true,
    health: 100,
    shield: 50,
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    grounded: true,
    crouching: false,
    weapon: 'rocket',
    pendingWeapon: null,
    owned: ['teleporter', 'assault', 'rocket', 'shock'],
    ammo: { assault: 120, rocket: 14, shock: 30 },
    spawnProtectedUntil: 0,
    respawnAt: 0,
    guiding: 0,
    disc: 0,
    viewingDisc: false,
    zoom: 1,
    udamageUntil: 0,
    ...over,
  };
}

export function mockState(pawn: Partial<PawnState> = {}, time = 100): WorldState {
  const enemy = mockPawn({ id: ENEMY_PAWN, playerId: 'bot', weapon: 'assault' });
  return {
    tick: time * 60,
    time,
    rngState: 0,
    entities: [mockPawn(pawn), enemy],
    match: {
      phase: 'playing',
      fragLimit: 20,
      timeLimit: 600,
      elapsed: 125,
      scores: [
        { playerId: 'you', name: 'You', isBot: false, frags: 7, deaths: 3, suicides: 0, spree: 2 },
        {
          playerId: 'bot',
          name: 'Sock Bot',
          isBot: true,
          frags: 5,
          deaths: 6,
          suicides: 1,
          spree: 0,
        },
      ],
      winner: null,
    },
  };
}

export { WEAPONS };
