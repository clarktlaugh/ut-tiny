import { describe, expect, it } from 'vitest';
import { DEFAULT_BINDINGS } from '../player/bindings';
import { PlayerController } from '../player/playerController';
import { pawn, worldState } from '../player/testUtil';
import { Buttons, DODGE_BUTTONS } from '../../sim/types';
import { TOUCH_RADIANS_PER_PX, TouchController } from './touchController';
import { FLICK_MAX_MS, STICK_RADIUS, flickDirection } from './touchInput';
import {
  TOUCH_SETTINGS_STORAGE_KEY,
  loadTouchSettings,
  sanitizeTouchSettings,
  saveTouchSettings,
} from './touchSettings';
import { attachDemoInput, wantsTouch } from '../../demos/shell/input';

const settings = {
  sensitivity: 1,
  invertY: false,
  doubleTapDodge: true,
  bindings: DEFAULT_BINDINGS,
};

function setup(touchSettings = { lookSensitivity: 1, invertY: false }) {
  const player = new PlayerController({ pawnId: 1, settings });
  const touch = new TouchController({ player, settings: touchSettings });
  const state = worldState([pawn({ id: 1, yaw: 0, pitch: 0 })]);
  let tick = 0;
  const step = () => touch.produce(tick++, state);
  // First produce is the spawn tick: it snaps the view to the pawn.
  step();
  return { player, touch, input: touch.input, step };
}

describe('stick → moveX / moveY', () => {
  it('maps deflection to axes: right is +x, screen up is +y (forward)', () => {
    const { input, step } = setup();
    input.stickDown(100, 300, 0);
    input.stickMove(100 + STICK_RADIUS, 300);
    let cmd = step();
    expect(cmd.moveX).toBeCloseTo(1);
    expect(cmd.moveY).toBeCloseTo(0);
    input.stickMove(100, 300 - STICK_RADIUS);
    cmd = step();
    expect(cmd.moveX).toBeCloseTo(0);
    expect(cmd.moveY).toBeCloseTo(1);
    input.stickMove(100, 300 + 2 * STICK_RADIUS); // beyond the radius clamps
    cmd = step();
    expect(cmd.moveY).toBeCloseTo(-1);
  });

  it('is analog, has a dead zone, and floats to the touch point', () => {
    const { input, step } = setup();
    input.stickDown(40, 200, 0);
    input.stickMove(40 + STICK_RADIUS * 0.05, 200);
    expect(step().moveX).toBe(0);
    input.stickMove(40 + STICK_RADIUS * 0.56, 200);
    const x = step().moveX;
    expect(x).toBeGreaterThan(0.4);
    expect(x).toBeLessThan(0.6);
  });

  it('returns to zero on release and adds to keyboard axes, clamped', () => {
    const { player, input, step } = setup();
    player.input.press('KeyW', 0);
    input.stickDown(0, 0, 0);
    input.stickMove(0, -STICK_RADIUS);
    expect(step().moveY).toBe(1);
    input.stickMove(STICK_RADIUS, 0);
    const cmd = step();
    expect(cmd.moveY).toBe(1);
    expect(cmd.moveX).toBeCloseTo(1);
    input.stickUp(1000);
    player.input.release('KeyW');
    const after = step();
    expect(after.moveX).toBe(0);
    expect(after.moveY).toBe(0);
  });
});

describe('drag → yaw / pitch', () => {
  it('drag right turns right (yaw decreases), drag up looks up', () => {
    const { input, step } = setup();
    input.look(100, 0);
    let cmd = step();
    expect(cmd.yaw).toBeCloseTo(-100 * TOUCH_RADIANS_PER_PX);
    expect(cmd.pitch).toBeCloseTo(0);
    input.look(0, -50);
    cmd = step();
    expect(cmd.pitch).toBeCloseTo(50 * TOUCH_RADIANS_PER_PX);
  });

  it('uses its own sensitivity and invert, and accumulates drags between ticks', () => {
    const { input, step } = setup({ lookSensitivity: 2, invertY: true });
    input.look(10, 20);
    input.look(15, 5);
    const cmd = step();
    expect(cmd.yaw).toBeCloseTo(-25 * TOUCH_RADIANS_PER_PX * 2);
    expect(cmd.pitch).toBeCloseTo(25 * TOUCH_RADIANS_PER_PX * 2);
    expect(step().yaw).toBeCloseTo(cmd.yaw); // drained
  });

  it('shares the view with the mouse and keeps the pitch clamp', () => {
    const { player, input, step } = setup();
    player.input.look(100, 0);
    input.look(100, 0);
    const cmd = step();
    expect(cmd.yaw).toBeLessThan(-100 * TOUCH_RADIANS_PER_PX);
    input.look(0, -1e6);
    expect(step().pitch).toBeLessThan(Math.PI / 2);
  });
});

describe('flick → dodge bit for exactly one tick', () => {
  it('a short, far stick touch dodges once in the flick direction', () => {
    const { input, step } = setup();
    input.stickDown(100, 300, 1000);
    input.stickMove(100 - STICK_RADIUS, 300);
    input.stickUp(1000 + FLICK_MAX_MS - 20);
    const first = step();
    expect(first.buttons & DODGE_BUTTONS).toBe(Buttons.DodgeLeft);
    expect(step().buttons & DODGE_BUTTONS).toBe(0);
    expect(step().buttons & DODGE_BUTTONS).toBe(0);
  });

  it('each direction maps to its bit', () => {
    const cases: [number, number, number][] = [
      [0, -1, Buttons.DodgeForward],
      [0, 1, Buttons.DodgeBack],
      [1, 0, Buttons.DodgeRight],
      [-1, 0, Buttons.DodgeLeft],
    ];
    for (const [sx, sy, bit] of cases) {
      const { input, step } = setup();
      input.stickDown(0, 0, 0);
      input.stickMove(sx * STICK_RADIUS, sy * STICK_RADIUS);
      input.stickUp(100);
      expect(step().buttons & DODGE_BUTTONS).toBe(bit);
    }
  });

  it('holding the stick, a slow lift or a small nudge does not dodge', () => {
    const { input, step } = setup();
    input.stickDown(0, 0, 0);
    input.stickMove(STICK_RADIUS, 0);
    expect(step().buttons & DODGE_BUTTONS).toBe(0);
    input.stickUp(FLICK_MAX_MS + 1);
    expect(step().buttons & DODGE_BUTTONS).toBe(0);

    input.stickDown(0, 0, 1000);
    input.stickMove(STICK_RADIUS * 0.3, 0);
    input.stickUp(1050);
    expect(step().buttons & DODGE_BUTTONS).toBe(0);
  });

  it('uses the dominant axis of the peak deflection', () => {
    expect(flickDirection(0.9, 0.4)).toBe('right');
    expect(flickDirection(-0.2, -0.7)).toBe('back');
    expect(flickDirection(0, 0.8)).toBe('forward');
  });
});

describe('buttons → bits', () => {
  it('fire, alt fire and jump are held bits, and a tap between ticks is not lost', () => {
    for (const [button, bit] of [
      ['fire', Buttons.Fire],
      ['altFire', Buttons.AltFire],
      ['jump', Buttons.Jump],
    ] as const) {
      const { input, step } = setup();
      input.buttonDown(button);
      expect(step().buttons & bit).toBe(bit);
      expect(step().buttons & bit).toBe(bit); // still held
      input.buttonUp(button);
      expect(step().buttons & bit).toBe(0);
      input.buttonDown(button);
      input.buttonUp(button);
      expect(step().buttons & bit).toBe(bit); // tapped between ticks
      expect(step().buttons & bit).toBe(0);
    }
  });

  it('next and previous weapon are one-tick edges', () => {
    for (const [button, bit] of [
      ['nextWeapon', Buttons.NextWeapon],
      ['prevWeapon', Buttons.PrevWeapon],
    ] as const) {
      const { input, step } = setup();
      input.buttonDown(button);
      expect(step().buttons & bit).toBe(bit);
      expect(step().buttons & bit).toBe(0); // even while still held
      input.buttonUp(button);
    }
  });

  it('crouch toggles', () => {
    const { input, step } = setup();
    expect(input.buttonDown('crouch')).toBe(true);
    input.buttonUp('crouch');
    expect(step().buttons & Buttons.Crouch).toBe(Buttons.Crouch);
    expect(step().buttons & Buttons.Crouch).toBe(Buttons.Crouch);
    expect(input.buttonDown('crouch')).toBe(false);
    expect(step().buttons & Buttons.Crouch).toBe(0);
  });

  it('touch bits combine with keyboard and mouse bits', () => {
    const { player, input, step } = setup();
    player.input.press('Mouse0', 0);
    input.buttonDown('jump');
    const b = step().buttons;
    expect(b & (Buttons.Fire | Buttons.Jump)).toBe(Buttons.Fire | Buttons.Jump);
  });

  it('releaseAll drops held buttons, crouch, stick and pending dodge', () => {
    const { input, step } = setup();
    input.buttonDown('fire');
    input.buttonDown('crouch');
    input.stickDown(0, 0, 0);
    input.stickMove(STICK_RADIUS, 0);
    input.releaseAll();
    const cmd = step();
    expect(cmd.buttons).toBe(0);
    expect(cmd.moveX).toBe(0);
  });
});

describe('touch settings', () => {
  it('sanitises stored values', () => {
    expect(sanitizeTouchSettings({ lookSensitivity: 99, invertY: 'yes' })).toEqual({
      lookSensitivity: 5,
      invertY: false,
    });
    expect(sanitizeTouchSettings(null)).toEqual({ lookSensitivity: 1, invertY: false });
  });

  it('round-trips through storage and survives garbage', () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    };
    saveTouchSettings({ lookSensitivity: 1.5, invertY: true }, storage);
    expect(loadTouchSettings(storage)).toEqual({ lookSensitivity: 1.5, invertY: true });
    data.set(TOUCH_SETTINGS_STORAGE_KEY, '{nope');
    expect(loadTouchSettings(storage).lookSensitivity).toBe(1);
  });
});

describe('demo shell input hook', () => {
  it('mounts touch controls only on touch devices, with ?touch= overrides', () => {
    expect(wantsTouch(true, '')).toBe(true);
    expect(wantsTouch(false, '')).toBe(false);
    expect(wantsTouch(false, '?touch=1')).toBe(true);
    expect(wantsTouch(true, '?touch=0')).toBe(false);
  });

  it('returns the player unchanged on desktop and never touches the overlay', () => {
    const player = new PlayerController({ pawnId: 1, settings });
    let calls = 0;
    const shell = { touch: false, setInputOverlay: () => void calls++ };
    const result = attachDemoInput(shell, player, { search: '' });
    expect(result.controller).toBe(player);
    expect(result.touch).toBeNull();
    expect(calls).toBe(0);
  });

  it('hands an overlay to the shell on touch devices and merges touch input', () => {
    const player = new PlayerController({ pawnId: 1, settings });
    const overlays: unknown[] = [];
    const shell = { touch: true, setInputOverlay: (o: unknown) => void overlays.push(o) };
    const result = attachDemoInput(shell, player, {
      search: '',
      settings: { lookSensitivity: 1, invertY: false },
    });
    expect(overlays).toHaveLength(1);
    expect(result.touch).toBeInstanceOf(TouchController);
    expect(result.controller.pawnId).toBe(1);
    result.detach();
    expect(overlays).toEqual([overlays[0], null]);
  });
});
