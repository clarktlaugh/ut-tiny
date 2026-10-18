/**
 * Local keyboard-and-mouse controller (docs/DESIGN.md §8.2, §11).
 *
 * Turns the raw input aggregated by `InputState` into one `InputCommand` per
 * tick. It is DOM-free; `attachPlayerInput` (pointerLock.ts) wires a browser
 * element to its `input`.
 *
 * View convention: right-handed, +Y up. Yaw is counter-clockwise seen from
 * above (moving the mouse right decreases it), wrapped to (−π, π]. Pitch is
 * positive looking up and clamped short of straight up/down.
 */
import {
  Buttons,
  WeaponIds,
  type Controller,
  type InputCommand,
  type PawnId,
  type PawnState,
  type Tick,
  type WeaponId,
  type WorldState,
} from '../../sim/types';
import type { Action, Bindings } from './bindings';
import { DODGE_WINDOW_MS, type DodgeDirection } from './dodge';
import { InputState } from './inputState';

/** Radians of view rotation per mouse count at sensitivity 1 (≈ UT2004 default feel). */
export const RADIANS_PER_COUNT = 0.0022;

/** Pitch limit; the sim clamps too (types.ts), this keeps the controller's own state sane. */
export const PITCH_LIMIT = Math.PI / 2 - 0.01;

/** The settings this controller reads. `Settings` from `src/app/settings.ts` satisfies it. */
export interface PlayerInputSettings {
  sensitivity: number;
  invertY: boolean;
  doubleTapDodge: boolean;
  bindings: Readonly<Bindings>;
}

export interface PlayerControllerOptions {
  pawnId: PawnId;
  settings: Readonly<PlayerInputSettings>;
  /** Weapon → bar slot (1–8). Defaults to UT order (`WeaponIds` index + 1). */
  weaponSlot?: (weapon: WeaponId) => number;
  dodgeWindowMs?: number;
}

/** Held actions that map straight onto a button bit. */
const HELD_BUTTONS: readonly [Action, number][] = [
  ['fire', Buttons.Fire],
  ['altFire', Buttons.AltFire],
  ['jump', Buttons.Jump],
  ['crouch', Buttons.Crouch],
  ['use', Buttons.Use],
  ['camView', Buttons.CamView],
];

/** One-tick actions: set on the tick after the press only. */
const EDGE_BUTTONS: readonly [Action, number][] = [
  ['dodgeForward', Buttons.DodgeForward],
  ['dodgeBack', Buttons.DodgeBack],
  ['dodgeLeft', Buttons.DodgeLeft],
  ['dodgeRight', Buttons.DodgeRight],
  ['nextWeapon', Buttons.NextWeapon],
  ['prevWeapon', Buttons.PrevWeapon],
];

const DODGE_BIT: Record<DodgeDirection, number> = {
  forward: Buttons.DodgeForward,
  back: Buttons.DodgeBack,
  left: Buttons.DodgeLeft,
  right: Buttons.DodgeRight,
};

const SLOT_ACTIONS: Partial<Record<Action, number>> = {
  weapon1: 1,
  weapon2: 2,
  weapon3: 3,
  weapon4: 4,
  weapon5: 5,
  weapon6: 6,
  weapon7: 7,
  weapon8: 8,
};

function defaultWeaponSlot(weapon: WeaponId): number {
  return WeaponIds.indexOf(weapon) + 1;
}

export function wrapAngle(a: number): number {
  const t = Math.PI * 2;
  const w = a - t * Math.floor((a + Math.PI) / t);
  return w === -Math.PI ? Math.PI : w;
}

function findPawn(state: Readonly<WorldState>, id: PawnId): Readonly<PawnState> | undefined {
  for (const e of state.entities) {
    if (e.id === id && e.kind === 'pawn') return e;
  }
  return undefined;
}

export class PlayerController implements Controller {
  readonly pawnId: PawnId;
  readonly input: InputState;

  private settings: Readonly<PlayerInputSettings>;
  private readonly weaponSlot: (weapon: WeaponId) => number;
  private seq = 0;
  private yaw = 0;
  private pitch = 0;
  private wasAlive = false;
  private currentWeapon: WeaponId | null = null;
  private previousWeapon: WeaponId | null = null;

  constructor(options: PlayerControllerOptions) {
    this.pawnId = options.pawnId;
    this.settings = options.settings;
    this.weaponSlot = options.weaponSlot ?? defaultWeaponSlot;
    this.input = new InputState({
      bindings: options.settings.bindings,
      doubleTapDodge: options.settings.doubleTapDodge,
      dodgeWindowMs: options.dodgeWindowMs ?? DODGE_WINDOW_MS,
    });
  }

  /** Apply new settings (e.g. from `SettingsStore.subscribe`). Rebinding releases held keys. */
  setSettings(settings: Readonly<PlayerInputSettings>): void {
    const old = this.settings;
    this.settings = settings;
    if (settings.bindings !== old.bindings) this.input.setBindings(settings.bindings);
    if (settings.doubleTapDodge !== old.doubleTapDodge) {
      this.input.setDoubleTapDodge(settings.doubleTapDodge);
    }
  }

  /** Current view angles (for the renderer's local camera between ticks). */
  get view(): { yaw: number; pitch: number } {
    return { yaw: this.yaw, pitch: this.pitch };
  }

  /** Set the view directly, e.g. at spawn. */
  setView(yaw: number, pitch: number): void {
    this.yaw = wrapAngle(yaw);
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
  }

  produce(_tick: Tick, state: Readonly<WorldState>): InputCommand {
    const frame = this.input.drain();
    const pawn = findPawn(state, this.pawnId);
    const alive = pawn?.alive ?? false;

    if (pawn && alive && !this.wasAlive) {
      // Fresh spawn: face the way the spawn point faces and forget motion from the death cam.
      this.setView(pawn.yaw, pawn.pitch);
      this.currentWeapon = null;
      this.previousWeapon = null;
    } else {
      const scale = RADIANS_PER_COUNT * this.settings.sensitivity;
      const ySign = this.settings.invertY ? 1 : -1;
      this.setView(this.yaw - frame.lookX * scale, this.pitch + ySign * frame.lookY * scale);
    }
    this.wasAlive = alive;
    this.trackWeapon(pawn?.weapon ?? null);

    const { active, pressed } = frame;
    const axis = (pos: Action, neg: Action) =>
      (active.has(pos) ? 1 : 0) - (active.has(neg) ? 1 : 0);

    let buttons = 0;
    for (const [action, bit] of HELD_BUTTONS) if (active.has(action)) buttons |= bit;
    for (const [action, bit] of EDGE_BUTTONS) if (pressed.includes(action)) buttons |= bit;
    if (frame.dodge) buttons |= DODGE_BIT[frame.dodge];

    let weapon = 0;
    for (const action of pressed) {
      const slot = SLOT_ACTIONS[action];
      if (slot !== undefined) weapon = slot;
      else if (action === 'lastWeapon' && this.previousWeapon) {
        weapon = this.weaponSlot(this.previousWeapon);
      }
    }

    this.seq += 1;
    return {
      seq: this.seq,
      moveX: axis('moveRight', 'moveLeft'),
      moveY: axis('moveForward', 'moveBack'),
      yaw: this.yaw,
      pitch: this.pitch,
      buttons,
      weapon,
    };
  }

  private trackWeapon(weapon: WeaponId | null): void {
    if (weapon === null || weapon === this.currentWeapon) return;
    if (this.currentWeapon !== null) this.previousWeapon = this.currentWeapon;
    this.currentWeapon = weapon;
  }
}
