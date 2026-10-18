/**
 * DOM-free aggregation of raw input between ticks.
 *
 * The DOM layer (`pointerLock.ts`) feeds key, button, wheel and mouse-motion
 * events in; `PlayerController.produce` drains one `InputFrame` per tick. Keeping
 * this free of the DOM lets the tests drive it with plain calls.
 */
import { codeToActions, type Action, type Bindings } from './bindings';
import { DodgeDetector, type DodgeDirection } from './dodge';

/** What happened since the previous drain. */
export interface InputFrame {
  /** Actions held now, or pressed and released since the last drain (so short taps are never lost). */
  active: ReadonlySet<Action>;
  /** Actions pressed (fresh, non-repeat) since the last drain, in order. */
  pressed: readonly Action[];
  /** Dodge completed since the last drain, if any (latest wins). */
  dodge: DodgeDirection | null;
  /** Accumulated pointer motion in device units. */
  lookX: number;
  lookY: number;
}

const DIRECTION_OF: Partial<Record<Action, DodgeDirection>> = {
  moveForward: 'forward',
  moveBack: 'back',
  moveLeft: 'left',
  moveRight: 'right',
};

export interface InputStateOptions {
  bindings: Readonly<Bindings>;
  /** Detect dodges from double-tapped movement keys. Default true. */
  doubleTapDodge?: boolean;
  dodgeWindowMs?: number;
}

export class InputState {
  private actionsByCode = new Map<string, Action[]>();
  private readonly heldCodes = new Set<string>();
  /** Actions pressed since the last drain (held or already released). */
  private readonly latched = new Set<Action>();
  private pressed: Action[] = [];
  private dodge: DodgeDirection | null = null;
  private lookX = 0;
  private lookY = 0;
  private detector: DodgeDetector;
  private doubleTapDodge: boolean;

  constructor(options: InputStateOptions) {
    this.detector = new DodgeDetector(options.dodgeWindowMs);
    this.doubleTapDodge = options.doubleTapDodge ?? true;
    this.setBindings(options.bindings);
  }

  setBindings(bindings: Readonly<Bindings>): void {
    this.actionsByCode = codeToActions(bindings);
    this.releaseAll();
  }

  setDoubleTapDodge(enabled: boolean, windowMs = this.detector.windowMs): void {
    this.doubleTapDodge = enabled;
    this.detector = new DodgeDetector(windowMs);
  }

  /** True if any bound action uses `code` (the DOM layer uses this to decide on preventDefault). */
  isBound(code: string): boolean {
    return this.actionsByCode.has(code);
  }

  /**
   * A key or button went down. `timeMs` is the event timestamp; `repeat` marks
   * keyboard auto-repeat, which never counts as a press.
   */
  press(code: string, timeMs: number, repeat = false): void {
    if (repeat || this.heldCodes.has(code)) return;
    this.heldCodes.add(code);
    for (const action of this.actionsByCode.get(code) ?? []) {
      this.latched.add(action);
      this.pressed.push(action);
      const direction = DIRECTION_OF[action];
      if (direction && this.doubleTapDodge) {
        const dodge = this.detector.tap(direction, timeMs);
        if (dodge) this.dodge = dodge;
      }
    }
  }

  release(code: string): void {
    this.heldCodes.delete(code);
  }

  /** One-shot input with no "up" (a wheel notch): pressed and released at once. */
  impulse(code: string, timeMs: number): void {
    this.press(code, timeMs);
    this.release(code);
  }

  look(dx: number, dy: number): void {
    if (Number.isFinite(dx)) this.lookX += dx;
    if (Number.isFinite(dy)) this.lookY += dy;
  }

  /** Drop held keys and pending motion, e.g. on blur or when pointer lock is lost. */
  releaseAll(): void {
    this.heldCodes.clear();
    this.latched.clear();
    this.pressed = [];
    this.dodge = null;
    this.lookX = 0;
    this.lookY = 0;
    this.detector.reset();
  }

  isHeld(action: Action): boolean {
    for (const code of this.heldCodes) {
      if (this.actionsByCode.get(code)?.includes(action)) return true;
    }
    return false;
  }

  /** Return everything since the previous drain and start a new frame. */
  drain(): InputFrame {
    const active = new Set(this.latched);
    for (const code of this.heldCodes) {
      for (const action of this.actionsByCode.get(code) ?? []) active.add(action);
    }
    const frame: InputFrame = {
      active,
      pressed: this.pressed,
      dodge: this.dodge,
      lookX: this.lookX,
      lookY: this.lookY,
    };
    this.latched.clear();
    this.pressed = [];
    this.dodge = null;
    this.lookX = 0;
    this.lookY = 0;
    return frame;
  }
}
