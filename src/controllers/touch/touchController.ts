/**
 * Touch input merged into the local player's commands (docs/DESIGN.md §11).
 *
 * Wraps the `PlayerController`, so keyboard, mouse and touch share one view
 * state (yaw/pitch, pitch clamp, respawn reset, weapon tracking) and one
 * command stream: nothing downstream knows touch exists. Look drags rotate the
 * player's view before it produces; the stick and buttons are added to the
 * command it returns. Touch buttons set their bits directly rather than
 * pressing bound key codes, so a touch release can never release a key or
 * mouse button that is also held.
 */
import {
  Buttons,
  type Controller,
  type InputCommand,
  type Tick,
  type WorldState,
} from '../../sim/types';
import type { DodgeDirection } from '../player/dodge';
import type { PlayerController } from '../player/playerController';
import { TouchInput } from './touchInput';
import { DEFAULT_TOUCH_SETTINGS, type TouchSettings } from './touchSettings';

/** Radians of look per CSS pixel of drag at touch sensitivity 1. */
export const TOUCH_RADIANS_PER_PX = 0.0045;

const DODGE_BIT: Record<DodgeDirection, number> = {
  forward: Buttons.DodgeForward,
  back: Buttons.DodgeBack,
  left: Buttons.DodgeLeft,
  right: Buttons.DodgeRight,
};

function clampAxis(v: number): number {
  return Math.max(-1, Math.min(1, v));
}

export interface TouchControllerOptions {
  player: PlayerController;
  /** Defaults to a fresh `TouchInput`. */
  input?: TouchInput;
  settings?: Readonly<TouchSettings>;
}

export class TouchController implements Controller {
  readonly pawnId: number;
  readonly player: PlayerController;
  readonly input: TouchInput;
  private settings: Readonly<TouchSettings>;

  constructor(options: TouchControllerOptions) {
    this.player = options.player;
    this.pawnId = options.player.pawnId;
    this.input = options.input ?? new TouchInput();
    this.settings = options.settings ?? DEFAULT_TOUCH_SETTINGS;
  }

  setSettings(settings: Readonly<TouchSettings>): void {
    this.settings = settings;
  }

  get view(): { yaw: number; pitch: number } {
    return this.player.view;
  }

  produce(tick: Tick, state: Readonly<WorldState>): InputCommand {
    const frame = this.input.drain();
    if (frame.lookX !== 0 || frame.lookY !== 0) {
      const k = TOUCH_RADIANS_PER_PX * this.settings.lookSensitivity;
      const ySign = this.settings.invertY ? 1 : -1;
      const { yaw, pitch } = this.player.view;
      // Same sense as the mouse: drag right turns right (yaw decreases), drag up looks up.
      // On a fresh spawn the player's produce replaces this with the spawn facing.
      this.player.setView(yaw - frame.lookX * k, pitch + ySign * frame.lookY * k);
    }
    const cmd = this.player.produce(tick, state);
    cmd.moveX = clampAxis(cmd.moveX + frame.moveX);
    cmd.moveY = clampAxis(cmd.moveY + frame.moveY);
    cmd.buttons |= frame.buttons;
    if (frame.dodge) cmd.buttons |= DODGE_BIT[frame.dodge];
    return cmd;
  }
}
