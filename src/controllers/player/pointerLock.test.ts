import { describe, expect, it, vi } from 'vitest';
import { Buttons } from '../../sim/types';
import { defaultBindings } from './bindings';
import { PlayerController } from './playerController';
import { attachPlayerInput, type LockDocument, type LockTarget } from './pointerLock';
import { domEvent, pawn, worldState } from './testUtil';

class FakeElement extends EventTarget implements LockTarget {
  constructor(private readonly doc: FakeDocument) {
    super();
  }
  requestPointerLock() {
    this.doc.pointerLockElement = this;
    this.doc.dispatchEvent(new Event('pointerlockchange'));
    return Promise.resolve();
  }
}

class FakeDocument extends EventTarget implements LockDocument {
  pointerLockElement: unknown = null;
  exitPointerLock() {
    this.pointerLockElement = null;
    this.dispatchEvent(new Event('pointerlockchange'));
  }
}

function setup() {
  const doc = new FakeDocument();
  const element = new FakeElement(doc);
  const win = new EventTarget();
  const controller = new PlayerController({
    pawnId: 1,
    settings: { sensitivity: 1, invertY: false, doubleTapDodge: true, bindings: defaultBindings() },
  });
  const state = worldState([pawn()]);
  controller.produce(0, state);
  const onLockChange = vi.fn();
  const binding = attachPlayerInput(controller.input, {
    element,
    document: doc,
    window: win,
    onLockChange,
  });
  const key = (type: string, code: string, timeStamp = 0, repeat = false) => {
    const e = domEvent(type, { code, timeStamp, repeat });
    doc.dispatchEvent(e);
    return e;
  };
  return { doc, element, win, controller, state, binding, onLockChange, key };
}

describe('attachPlayerInput', () => {
  it('ignores input until the pointer is locked; the locking click does not fire', () => {
    const { element, controller, state, binding, onLockChange, key } = setup();
    key('keydown', 'KeyW');
    expect(controller.produce(1, state).moveY).toBe(0);

    element.dispatchEvent(domEvent('mousedown', { button: 0, timeStamp: 0 }));
    expect(binding.locked).toBe(true);
    expect(onLockChange).toHaveBeenCalledWith(true);
    expect(controller.produce(2, state).buttons & Buttons.Fire).toBe(0);

    const e = key('keydown', 'KeyW');
    expect(e.defaultPrevented).toBe(true);
    expect(controller.produce(3, state).moveY).toBe(1);
  });

  it('feeds buttons, wheel and motion while locked', () => {
    const { element, doc, controller, state, binding } = setup();
    binding.lock();
    element.dispatchEvent(domEvent('mousedown', { button: 0, timeStamp: 1 }));
    element.dispatchEvent(domEvent('wheel', { deltaY: -120, timeStamp: 1 }));
    doc.dispatchEvent(domEvent('mousemove', { movementX: 10, movementY: 0 }));
    const cmd = controller.produce(1, state);
    expect(cmd.buttons & (Buttons.Fire | Buttons.NextWeapon)).toBe(
      Buttons.Fire | Buttons.NextWeapon,
    );
    expect(cmd.yaw).toBeLessThan(0);
    doc.dispatchEvent(domEvent('mouseup', { button: 0 }));
    expect(controller.produce(2, state).buttons & Buttons.Fire).toBe(0);
  });

  it('double-tap through DOM events uses event timestamps', () => {
    const { controller, state, binding, key } = setup();
    binding.lock();
    key('keydown', 'KeyA', 1000);
    key('keyup', 'KeyA', 1050);
    key('keydown', 'KeyA', 1150);
    expect(controller.produce(1, state).buttons & Buttons.DodgeLeft).toBe(Buttons.DodgeLeft);
    expect(controller.produce(2, state).buttons & Buttons.DodgeLeft).toBe(0);
  });

  it('losing the lock or focus releases held keys', () => {
    const { controller, state, binding, win, onLockChange, key } = setup();
    binding.lock();
    key('keydown', 'KeyW');
    controller.produce(1, state);
    binding.unlock();
    expect(onLockChange).toHaveBeenLastCalledWith(false);
    expect(controller.produce(2, state).moveY).toBe(0);

    binding.lock();
    key('keydown', 'KeyD');
    controller.produce(3, state);
    win.dispatchEvent(new Event('blur'));
    expect(controller.produce(4, state).moveX).toBe(0);
  });

  it('leaves unbound keys alone and detaches cleanly', () => {
    const { controller, state, binding, key } = setup();
    binding.lock();
    expect(key('keydown', 'F5').defaultPrevented).toBe(false);
    binding.detach();
    expect(binding.locked).toBe(false);
    key('keydown', 'KeyW');
    expect(controller.produce(1, state).moveY).toBe(0);
  });
});
