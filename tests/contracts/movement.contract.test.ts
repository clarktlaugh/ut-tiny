/**
 * Movement contract (docs/DESIGN.md §4). Implemented by P7.
 */
import { describe, it } from 'vitest';

describe('movement', () => {
  it.todo('ground speed caps at 8.8 m/s');
  it.todo('reaches full ground speed within 0.15 s from rest');
  it.todo('gravity is 19 m/s²');
  it.todo('jump apex is ~1.2 m above the takeoff height');
  it.todo('a second Jump press within 0.75 s of apex performs a double jump to ~2.4 m total');
  it.todo(
    'dodge bit sets 12 m/s horizontal and 3.2 m/s vertical velocity and starts a 0.5 s cooldown',
  );
  it.todo('dodge is ignored while on cooldown');
  it.todo('wall dodge is allowed once per airborne period when within 0.6 m of a wall');
  it.todo('air control applies 35% of ground acceleration');
  it.todo('steps up ledges up to 0.45 m without losing horizontal speed');
  it.todo('snaps to the ground when walking off small bumps');
  it.todo('fall damage begins at 20 m/s impact and is lethal at 35 m/s');
  it.todo('crouch halves height and speed');
  it.todo('pitch is clamped to just under ±90°');
  it.todo('a jump pad sets the pawn velocity to its launch vector and emits a jumpPad event');
});
