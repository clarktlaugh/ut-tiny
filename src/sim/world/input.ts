/**
 * Input sanitising for `World.step` (docs/DESIGN.md §8.2). Commands can come
 * from the network, so the world never trusts them: non-finite axes become 0,
 * axes are clamped to −1..1, non-finite view angles keep the pawn's previous
 * view, and the weapon slot must be an integer 0–8.
 */
import type { InputCommand } from '../types';

function axis(v: number): number {
  return Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
}

/** A safe copy of `cmd`. `view` supplies the angles used when the command's are not finite. */
export function sanitizeInput(
  cmd: Readonly<InputCommand>,
  view: Readonly<{ yaw: number; pitch: number }>,
): InputCommand {
  const weapon =
    Number.isInteger(cmd.weapon) && cmd.weapon >= 0 && cmd.weapon <= 8 ? cmd.weapon : 0;
  return {
    seq: Number.isFinite(cmd.seq) ? cmd.seq : 0,
    moveX: axis(cmd.moveX),
    moveY: axis(cmd.moveY),
    yaw: Number.isFinite(cmd.yaw) ? cmd.yaw : view.yaw,
    pitch: Number.isFinite(cmd.pitch) ? cmd.pitch : view.pitch,
    buttons: Number.isInteger(cmd.buttons) ? cmd.buttons & 0xffff : 0,
    weapon,
  };
}
