/**
 * Browser wiring for the player controller: pointer lock plus keyboard, mouse
 * button, wheel and motion listeners feeding an `InputState` (docs/DESIGN.md §11).
 *
 * Input only counts while the pointer is locked to the game element, so typing
 * in menus or the click that grabs the pointer never moves or fires. Losing
 * the lock (Esc, alt-tab) or window focus releases every held key.
 */
import { mouseButtonCode, WHEEL_DOWN, WHEEL_UP } from './bindings';
import type { InputState } from './inputState';

/** The parts of `HTMLElement` this module uses. */
export interface LockTarget {
  requestPointerLock(): unknown;
  addEventListener(type: string, listener: (event: Event) => void, options?: unknown): void;
  removeEventListener(type: string, listener: (event: Event) => void, options?: unknown): void;
}

/** The parts of `Document` this module uses. */
export interface LockDocument {
  readonly pointerLockElement: unknown;
  exitPointerLock(): void;
  addEventListener(type: string, listener: (event: Event) => void, options?: unknown): void;
  removeEventListener(type: string, listener: (event: Event) => void, options?: unknown): void;
}

/** Window-like source of `blur`. */
export interface BlurSource {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

export interface AttachOptions {
  /** Element that takes pointer lock; clicking it requests the lock. */
  element: LockTarget;
  document: LockDocument;
  /** Usually `window`; releases input on blur. */
  window?: BlurSource;
  /** Called whenever the lock is gained or lost (e.g. to show the "click to play" overlay). */
  onLockChange?: (locked: boolean) => void;
}

export interface PlayerInputBinding {
  readonly locked: boolean;
  /** Ask for pointer lock (must be called from a user gesture in browsers). */
  lock(): void;
  unlock(): void;
  detach(): void;
}

type KeyLike = Event & { code: string; repeat: boolean; timeStamp: number };
type MouseLike = Event & { button: number; timeStamp: number };
type MoveLike = Event & { movementX: number; movementY: number };
type WheelLike = Event & { deltaY: number; timeStamp: number };

export function attachPlayerInput(input: InputState, options: AttachOptions): PlayerInputBinding {
  const { element, document: doc, window: win, onLockChange } = options;
  let locked = doc.pointerLockElement === element;

  const lock = () => {
    try {
      const result = element.requestPointerLock();
      // Modern browsers return a promise that rejects if the request is refused.
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch(() => {});
      }
    } catch {
      // Unsupported or refused; stay unlocked.
    }
  };

  const onKeyDown = (e: Event) => {
    if (!locked) return;
    const k = e as KeyLike;
    if (!input.isBound(k.code)) return;
    e.preventDefault();
    input.press(k.code, k.timeStamp, k.repeat);
  };
  const onKeyUp = (e: Event) => {
    const k = e as KeyLike;
    input.release(k.code);
  };
  const onMouseDown = (e: Event) => {
    const m = e as MouseLike;
    if (!locked) {
      if (m.button === 0) lock();
      return;
    }
    e.preventDefault();
    input.press(mouseButtonCode(m.button), m.timeStamp);
  };
  const onMouseUp = (e: Event) => {
    input.release(mouseButtonCode((e as MouseLike).button));
  };
  const onMouseMove = (e: Event) => {
    if (!locked) return;
    const m = e as MoveLike;
    input.look(m.movementX, m.movementY);
  };
  const onWheel = (e: Event) => {
    if (!locked) return;
    const w = e as WheelLike;
    if (w.deltaY === 0) return;
    e.preventDefault();
    input.impulse(w.deltaY < 0 ? WHEEL_UP : WHEEL_DOWN, w.timeStamp);
  };
  const onContextMenu = (e: Event) => {
    if (locked) e.preventDefault();
  };
  const onLockChanged = () => {
    const now = doc.pointerLockElement === element;
    if (now === locked) return;
    locked = now;
    if (!locked) input.releaseAll();
    onLockChange?.(locked);
  };
  const onBlur = () => input.releaseAll();

  const nonPassive = { passive: false };
  doc.addEventListener('keydown', onKeyDown);
  doc.addEventListener('keyup', onKeyUp);
  element.addEventListener('mousedown', onMouseDown);
  doc.addEventListener('mouseup', onMouseUp);
  doc.addEventListener('mousemove', onMouseMove);
  element.addEventListener('wheel', onWheel, nonPassive);
  element.addEventListener('contextmenu', onContextMenu);
  doc.addEventListener('pointerlockchange', onLockChanged);
  win?.addEventListener('blur', onBlur);

  return {
    get locked() {
      return locked;
    },
    lock,
    unlock() {
      if (locked) doc.exitPointerLock();
    },
    detach() {
      doc.removeEventListener('keydown', onKeyDown);
      doc.removeEventListener('keyup', onKeyUp);
      element.removeEventListener('mousedown', onMouseDown);
      doc.removeEventListener('mouseup', onMouseUp);
      doc.removeEventListener('mousemove', onMouseMove);
      element.removeEventListener('wheel', onWheel, nonPassive);
      element.removeEventListener('contextmenu', onContextMenu);
      doc.removeEventListener('pointerlockchange', onLockChanged);
      win?.removeEventListener('blur', onBlur);
      if (locked) {
        locked = false;
        doc.exitPointerLock();
      }
      input.releaseAll();
    },
  };
}
