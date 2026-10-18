import { describe, expect, it } from 'vitest';
import { DODGE_BUTTONS, Buttons } from '../../sim/types';
import { defaultBindings } from './bindings';
import { DodgeDetector, DODGE_WINDOW_MS } from './dodge';
import { PlayerController } from './playerController';
import { pawn, worldState } from './testUtil';

describe('DodgeDetector', () => {
  it('detects a double tap inside the window', () => {
    const d = new DodgeDetector();
    expect(d.tap('left', 1000)).toBeNull();
    expect(d.tap('left', 1000 + DODGE_WINDOW_MS)).toBe('left');
  });

  it('ignores taps further apart than the window', () => {
    const d = new DodgeDetector();
    expect(d.tap('left', 0)).toBeNull();
    expect(d.tap('left', DODGE_WINDOW_MS + 1)).toBeNull();
    // ...but the late tap starts a new gesture.
    expect(d.tap('left', DODGE_WINDOW_MS + 100)).toBe('left');
  });

  it('a different direction restarts the gesture', () => {
    const d = new DodgeDetector();
    d.tap('left', 0);
    expect(d.tap('right', 50)).toBeNull();
    expect(d.tap('left', 100)).toBeNull();
  });

  it('a triple tap is one dodge', () => {
    const d = new DodgeDetector();
    d.tap('forward', 0);
    expect(d.tap('forward', 100)).toBe('forward');
    expect(d.tap('forward', 200)).toBeNull();
  });

  it('ignores timestamps that run backwards', () => {
    const d = new DodgeDetector();
    d.tap('back', 500);
    expect(d.tap('back', 400)).toBeNull();
  });
});

describe('PlayerController dodge', () => {
  const settings = {
    sensitivity: 1,
    invertY: false,
    doubleTapDodge: true,
    bindings: defaultBindings(),
  };
  const state = worldState([pawn()]);

  function tap(c: PlayerController, code: string, t: number) {
    c.input.press(code, t);
    c.input.release(code);
  }

  it('double-tap timing emits the dodge bit for exactly one tick', () => {
    const c = new PlayerController({ pawnId: 1, settings });
    tap(c, 'KeyA', 0);
    expect(c.produce(0, state).buttons & DODGE_BUTTONS).toBe(0);
    tap(c, 'KeyA', 200);
    expect(c.produce(1, state).buttons & DODGE_BUTTONS).toBe(Buttons.DodgeLeft);
    expect(c.produce(2, state).buttons & DODGE_BUTTONS).toBe(0);
    expect(c.produce(3, state).buttons & DODGE_BUTTONS).toBe(0);
  });

  it('emits the dodge once even if the key is still held', () => {
    const c = new PlayerController({ pawnId: 1, settings });
    tap(c, 'KeyW', 0);
    c.input.press('KeyW', 100);
    const first = c.produce(0, state);
    expect(first.buttons & DODGE_BUTTONS).toBe(Buttons.DodgeForward);
    expect(first.moveY).toBe(1);
    const second = c.produce(1, state);
    expect(second.buttons & DODGE_BUTTONS).toBe(0);
    expect(second.moveY).toBe(1);
  });

  it('does not dodge when taps are too slow', () => {
    const c = new PlayerController({ pawnId: 1, settings });
    tap(c, 'KeyD', 0);
    c.produce(0, state);
    tap(c, 'KeyD', 251);
    expect(c.produce(1, state).buttons & DODGE_BUTTONS).toBe(0);
  });

  it('keyboard auto-repeat never counts as a tap', () => {
    const c = new PlayerController({ pawnId: 1, settings });
    c.input.press('KeyS', 0);
    c.input.press('KeyS', 30, true);
    c.input.press('KeyS', 60, true);
    expect(c.produce(0, state).buttons & DODGE_BUTTONS).toBe(0);
  });

  it('can be turned off; dedicated dodge binds still work for one tick', () => {
    const bindings = defaultBindings();
    bindings.dodgeRight = ['KeyX'];
    const c = new PlayerController({
      pawnId: 1,
      settings: { ...settings, doubleTapDodge: false, bindings },
    });
    tap(c, 'KeyD', 0);
    tap(c, 'KeyD', 100);
    expect(c.produce(0, state).buttons & DODGE_BUTTONS).toBe(0);
    c.input.press('KeyX', 200);
    expect(c.produce(1, state).buttons & DODGE_BUTTONS).toBe(Buttons.DodgeRight);
    expect(c.produce(2, state).buttons & DODGE_BUTTONS).toBe(0);
  });
});
