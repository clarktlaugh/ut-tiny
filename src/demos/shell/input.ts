/**
 * Input wiring for hub demos (docs/DESIGN.md §11, §18.8). A demo that drives a
 * `PlayerController` calls `attachDemoInput(shell, player)` and adds the
 * returned controller to its session. On touch devices (or with `?touch=1`,
 * for trying the controls on a desktop) the P27 touch controls mount in the
 * shell's input-overlay layer and their input is merged into the player's
 * commands; elsewhere the player controller is returned unchanged.
 */
import type { PlayerController } from '../../controllers/player/playerController';
import { TouchController } from '../../controllers/touch/touchController';
import { TouchInput } from '../../controllers/touch/touchInput';
import { TouchOverlay } from '../../controllers/touch/overlay';
import { loadTouchSettings, type TouchSettings } from '../../controllers/touch/touchSettings';
import type { Controller } from '../../sim/types';
import type { DemoShell, InputOverlay } from './shell';

export interface DemoInput {
  /** Add this to the session in place of the player controller. */
  readonly controller: Controller;
  /** The touch controller when touch controls are mounted, else null. */
  readonly touch: TouchController | null;
  detach(): void;
}

/** Touch controls are on for coarse pointers, or forced with `?touch=1` / off with `?touch=0`. */
export function wantsTouch(touchDevice: boolean, search: string): boolean {
  const param = new URLSearchParams(search).get('touch');
  if (param === '1') return true;
  if (param === '0') return false;
  return touchDevice;
}

export function attachDemoInput(
  shell: Pick<DemoShell, 'touch' | 'setInputOverlay'>,
  player: PlayerController,
  options: { settings?: Readonly<TouchSettings>; search?: string } = {},
): DemoInput {
  if (!wantsTouch(shell.touch, options.search ?? location.search)) {
    return { controller: player, touch: null, detach() {} };
  }
  const input = new TouchInput();
  const touch = new TouchController({
    player,
    input,
    settings: options.settings ?? loadTouchSettings(),
  });
  const overlay = new TouchOverlay({ input });
  const hook: InputOverlay = {
    mount: (root) => overlay.mount(root),
    unmount: () => overlay.unmount(),
  };
  shell.setInputOverlay(hook);
  return {
    controller: touch,
    touch,
    detach: () => shell.setInputOverlay(null),
  };
}
