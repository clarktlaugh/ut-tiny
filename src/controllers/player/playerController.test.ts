import { describe, expect, it } from 'vitest';
import { Buttons } from '../../sim/types';
import { defaultBindings, WHEEL_DOWN, WHEEL_UP } from './bindings';
import { PITCH_LIMIT, PlayerController, RADIANS_PER_COUNT, wrapAngle } from './playerController';
import { pawn, worldState } from './testUtil';

const settings = {
  sensitivity: 1,
  invertY: false,
  doubleTapDodge: true,
  bindings: defaultBindings(),
};

/** A controller that has already seen its pawn spawn, so look input applies. */
function make(overrides: Partial<typeof settings> = {}) {
  const c = new PlayerController({ pawnId: 1, settings: { ...settings, ...overrides } });
  c.produce(-1, worldState([pawn()]));
  return c;
}

describe('PlayerController', () => {
  const alive = worldState([pawn()]);

  it('maps held movement keys to axes and cancels opposites', () => {
    const c = make();
    c.input.press('KeyW', 0);
    c.input.press('KeyD', 0);
    let cmd = c.produce(0, alive);
    expect([cmd.moveX, cmd.moveY]).toEqual([1, 1]);
    c.input.press('KeyA', 1);
    cmd = c.produce(1, alive);
    expect([cmd.moveX, cmd.moveY]).toEqual([0, 1]);
    c.input.release('KeyW');
    c.input.release('KeyD');
    cmd = c.produce(2, alive);
    expect([cmd.moveX, cmd.moveY]).toEqual([-1, 0]);
  });

  it('numbers commands with increasing seq', () => {
    const c = make();
    expect([c.produce(0, alive).seq, c.produce(1, alive).seq]).toEqual([2, 3]);
  });

  it('keeps a press shorter than a tick (jump tap between ticks)', () => {
    const c = make();
    c.input.press('Space', 0);
    c.input.release('Space');
    expect(c.produce(0, alive).buttons & Buttons.Jump).toBe(Buttons.Jump);
    expect(c.produce(1, alive).buttons & Buttons.Jump).toBe(0);
  });

  it('sets held buttons every tick they are down', () => {
    const c = make();
    c.input.press('Mouse0', 0);
    c.input.press('Mouse2', 0);
    for (let t = 0; t < 3; t++) {
      expect(c.produce(t, alive).buttons & (Buttons.Fire | Buttons.AltFire)).toBe(
        Buttons.Fire | Buttons.AltFire,
      );
    }
  });

  it('applies mouse look with sensitivity, inversion and pitch clamp', () => {
    const c = make({ sensitivity: 2 });
    c.input.look(100, -50);
    const cmd = c.produce(0, alive);
    expect(cmd.yaw).toBeCloseTo(-100 * RADIANS_PER_COUNT * 2);
    expect(cmd.pitch).toBeCloseTo(50 * RADIANS_PER_COUNT * 2);

    const inv = make({ invertY: true });
    inv.input.look(0, -50);
    expect(inv.produce(0, alive).pitch).toBeCloseTo(-50 * RADIANS_PER_COUNT);

    inv.input.look(0, -1e6);
    expect(inv.produce(1, alive).pitch).toBeCloseTo(-PITCH_LIMIT);
  });

  it('consumes look motion once', () => {
    const c = make();
    c.input.look(10, 0);
    const a = c.produce(0, alive).yaw;
    expect(a).not.toBe(0);
    expect(c.produce(1, alive).yaw).toBe(a);
  });

  it('wraps yaw into (-pi, pi]', () => {
    expect(wrapAngle(Math.PI * 3)).toBeCloseTo(Math.PI);
    expect(wrapAngle(-Math.PI)).toBe(Math.PI);
    expect(wrapAngle(0.5 + Math.PI * 4)).toBeCloseTo(0.5);
  });

  it('adopts the spawn orientation on respawn', () => {
    const c = make();
    c.produce(0, worldState([pawn({ alive: false })]));
    c.input.look(500, 0);
    const cmd = c.produce(1, worldState([pawn({ yaw: 1.25, pitch: 0.1 })]));
    expect(cmd.yaw).toBeCloseTo(1.25);
    expect(cmd.pitch).toBeCloseTo(0.1);
    c.input.look(10, 0);
    expect(c.produce(2, worldState([pawn({ yaw: 1.25 })])).yaw).toBeCloseTo(
      1.25 - 10 * RADIANS_PER_COUNT,
    );
  });

  it('requests weapon slots, wheel cycling and last weapon', () => {
    const c = make();
    c.input.press('Digit3', 0);
    expect(c.produce(0, alive).weapon).toBe(3);
    c.input.release('Digit3');
    expect(c.produce(1, alive).weapon).toBe(0);

    c.input.impulse(WHEEL_UP, 2);
    let cmd = c.produce(2, alive);
    expect(cmd.buttons & Buttons.NextWeapon).toBe(Buttons.NextWeapon);
    expect(c.produce(3, alive).buttons & Buttons.NextWeapon).toBe(0);
    c.input.impulse(WHEEL_DOWN, 4);
    expect(c.produce(4, alive).buttons & Buttons.PrevWeapon).toBe(Buttons.PrevWeapon);

    // Q does nothing until the pawn has switched at least once.
    c.produce(5, worldState([pawn({ weapon: 'assault' })]));
    c.input.impulse('KeyQ', 6);
    expect(c.produce(6, worldState([pawn({ weapon: 'assault' })])).weapon).toBe(0);
    c.produce(7, worldState([pawn({ weapon: 'rocket' })]));
    c.input.impulse('KeyQ', 8);
    cmd = c.produce(8, worldState([pawn({ weapon: 'rocket' })]));
    expect(cmd.weapon).toBe(2); // assault is slot 2 in UT order
  });

  it('picks up rebinding through setSettings', () => {
    const c = make();
    const bindings = defaultBindings();
    bindings.jump = ['KeyF'];
    c.setSettings({ ...settings, bindings });
    c.input.press('Space', 0);
    expect(c.produce(0, alive).buttons & Buttons.Jump).toBe(0);
    c.input.press('KeyF', 1);
    expect(c.produce(1, alive).buttons & Buttons.Jump).toBe(Buttons.Jump);
  });

  it('produces neutral movement when nothing is pressed', () => {
    const cmd = make().produce(0, worldState());
    expect(cmd).toMatchObject({ moveX: 0, moveY: 0, buttons: 0, weapon: 0 });
  });
});
