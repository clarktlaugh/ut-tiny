/**
 * Helpers for world tests and headless runs: the default options for a
 * laundry-room match and a deterministic scripted controller that moves,
 * turns, jumps, dodges, fires and cycles weapons. Not used at runtime.
 */
import { PICKUPS } from '../../data/pickups';
import { WEAPONS } from '../../data/weapons';
import { LAUNDRY_ROOM } from '../../maps/laundry-room';
import {
  Buttons,
  NULL_INPUT,
  type InputCommand,
  type MapDef,
  type RulesConfig,
  type Tick,
  type WorldOptions,
} from '../types';

export const TEST_WORLD_RULES: RulesConfig = {
  fragLimit: 0,
  timeLimit: 0,
  weaponStay: true,
  spawnProtection: 2,
  respawnDelay: 1,
  udamageEnabled: true,
};

export function worldOptions(overrides: Partial<WorldOptions> = {}): WorldOptions {
  return {
    map: LAUNDRY_ROOM,
    seed: 1234,
    rules: TEST_WORLD_RULES,
    weapons: WEAPONS,
    pickups: PICKUPS,
    ...overrides,
  };
}

/** Empty map with only a floor (top face at y = 0) and the given extras. */
export function flatMap(extra: Partial<MapDef> = {}): MapDef {
  return {
    name: 'flat',
    scale: 40,
    brushes: [
      {
        shape: 'box',
        position: { x: 0, y: -0.5, z: 0 },
        size: { x: 200, y: 1, z: 200 },
        material: 'grey',
      },
    ],
    props: [],
    spawns: [{ position: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 }],
    pickups: [],
    jumpPads: [],
    volumes: [],
    lights: [],
    navLinks: [],
    cameras: [],
    ambience: { loops: [], reverb: 'none' },
    ...extra,
  };
}

const DODGES = [Buttons.DodgeForward, Buttons.DodgeLeft, Buttons.DodgeBack, Buttons.DodgeRight];

/**
 * Scripted input for bot number `n` on `tick`: always moving, turning slowly,
 * a jump every ~1.5 s (with a double jump), a dodge every ~2 s, bursts of
 * primary fire, occasional alt fire, and a weapon change every ~5 s.
 */
export function scriptedInput(n: number, tick: Tick): InputCommand {
  const phase = tick + n * 37;
  let buttons = 0;
  if (phase % 90 === 0 || phase % 90 === 20) buttons |= Buttons.Jump;
  if (phase % 120 === 60) buttons |= DODGES[((phase / 120 + n) % 4) | 0] ?? 0;
  if (phase % 60 < 25) buttons |= Buttons.Fire;
  else if (phase % 240 > 200) buttons |= Buttons.AltFire;
  if (phase % 400 > 380) buttons |= Buttons.Crouch;
  const weaponCycle = phase % 300 === 150;
  if (weaponCycle) buttons |= n % 2 ? Buttons.NextWeapon : Buttons.PrevWeapon;
  return {
    ...NULL_INPUT,
    seq: tick,
    moveX: Math.sin(phase / 47),
    moveY: Math.cos(phase / 31) > -0.3 ? 1 : -1,
    yaw: n * 1.7 + phase * 0.013,
    pitch: Math.sin(phase / 70) * 0.4,
    buttons,
    weapon: phase % 500 === 250 ? 1 + (((phase / 500 + n) % 3) | 0) * 2 : 0,
  };
}
