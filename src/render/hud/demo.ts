/** HUD dev demo: `?case=` picks a mocked state (default, lowHealth, scoped, dead, power). */
import { Hud, injectHudStyle, type HudNode } from './index';
import { ENEMY_PAWN, LOCAL_PAWN, WEAPONS, mockState } from './mockState';
import type { PawnState, SimEvent } from '../../sim/types';

const cases: Record<string, Partial<PawnState>> = {
  default: {},
  lowHealth: { health: 18, shield: 0, weapon: 'assault' },
  scoped: {
    weapon: 'sniper',
    owned: ['sniper', 'assault'],
    ammo: { sniper: 8, assault: 60 },
    zoom: 4,
  },
  dead: { alive: false, health: 0, shield: 0 },
  power: { udamageUntil: 1e9, spawnProtectedUntil: 1e9, weapon: 'shock', health: 150 },
};

const stage = document.getElementById('stage')!;
injectHudStyle(document);
const root = document.createElement('div');
stage.appendChild(root);
const hud = new Hud(root as unknown as HudNode, document, {
  weapons: WEAPONS,
  localPawn: LOCAL_PAWN,
});

const name = new URLSearchParams(location.search).get('case') ?? 'default';
const state = mockState(cases[name] ?? {});
const events: SimEvent[] = [
  {
    type: 'death',
    tick: 1,
    victim: ENEMY_PAWN,
    killer: LOCAL_PAWN,
    damageType: 'rocket',
    weapon: 'rocket',
  },
  {
    type: 'death',
    tick: 1,
    victim: LOCAL_PAWN,
    killer: ENEMY_PAWN,
    damageType: 'bullet',
    weapon: 'assault',
  },
  {
    type: 'death',
    tick: 1,
    victim: ENEMY_PAWN,
    killer: 0,
    damageType: 'killVolume',
    weapon: null,
    message: 'went down the drain',
  },
  { type: 'announcer', tick: 1, line: 'killingSpree', toPawn: 0 },
];
hud.handleEvents(events, state);
hud.update(state);
