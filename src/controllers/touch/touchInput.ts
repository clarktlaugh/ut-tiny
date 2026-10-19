/**
 * DOM-free aggregation of touch input between ticks (docs/DESIGN.md §11).
 *
 * The overlay (`overlay.ts`) feeds stick, look-drag and button events in;
 * `TouchController.produce` drains one `TouchFrame` per tick, the same way
 * `PlayerController` drains `InputState`. Tests drive this with plain calls.
 *
 * Stick axes: x right, y forward (screen up), each −1..1 after a dead zone.
 * A flick is a short stick touch that travels far: lifting the finger within
 * `flickMaxMs` of touching down, after deflecting at least
 * `flickMinDeflection`, dodges in the dominant direction of the deflection.
 * It is the touch equivalent of a double tap and, like it, sets one dodge bit
 * for exactly one tick.
 */
import { Buttons } from '../../sim/types';
import type { DodgeDirection } from '../player/dodge';

export const TOUCH_BUTTONS = [
  'fire',
  'altFire',
  'jump',
  'crouch',
  'nextWeapon',
  'prevWeapon',
] as const;
export type TouchButton = (typeof TOUCH_BUTTONS)[number];

/** Held buttons: their bit is set while down, and for one drain after a tap between ticks. */
const HELD_BITS: Partial<Record<TouchButton, number>> = {
  fire: Buttons.Fire,
  altFire: Buttons.AltFire,
  jump: Buttons.Jump,
};

/** One-tick buttons: their bit is set on the drain after the press only. */
const EDGE_BITS: Partial<Record<TouchButton, number>> = {
  nextWeapon: Buttons.NextWeapon,
  prevWeapon: Buttons.PrevWeapon,
};

/** Stick travel in CSS pixels for full deflection. */
export const STICK_RADIUS = 56;
/** Deflection (fraction of the radius) below which the stick reads zero. */
export const STICK_DEAD_ZONE = 0.12;
/** A stick touch lifted within this many ms can be a flick. */
export const FLICK_MAX_MS = 220;
/** A flick must deflect the stick at least this far (fraction of the radius). */
export const FLICK_MIN_DEFLECTION = 0.6;

export interface TouchFrame {
  /** Stick axes, −1..1. Zero when the stick is not touched. */
  moveX: number;
  moveY: number;
  /** Look drag in CSS pixels since the last drain (x right, y down). */
  lookX: number;
  lookY: number;
  /** `Buttons` bits: held, tapped since the last drain, crouch toggle, weapon edges. */
  buttons: number;
  /** Flick completed since the last drain, if any (latest wins). */
  dodge: DodgeDirection | null;
}

export interface TouchInputOptions {
  stickRadius?: number;
  deadZone?: number;
  flickMaxMs?: number;
  flickMinDeflection?: number;
}

/** The dominant direction of a stick vector (x right, y forward). */
export function flickDirection(x: number, y: number): DodgeDirection {
  if (Math.abs(x) > Math.abs(y)) return x > 0 ? 'right' : 'left';
  return y >= 0 ? 'forward' : 'back';
}

export class TouchInput {
  readonly stickRadius: number;
  private readonly deadZone: number;
  private readonly flickMaxMs: number;
  private readonly flickMinDeflection: number;

  private stickActive = false;
  private stickStartMs = 0;
  /** Raw deflection (fraction of the radius, clamped to 1) and its peak this touch. */
  private rawX = 0;
  private rawY = 0;
  private peakX = 0;
  private peakY = 0;
  private originX = 0;
  private originY = 0;

  private held = 0;
  private latched = 0;
  private edges = 0;
  private crouch = false;
  private dodge: DodgeDirection | null = null;
  private lookX = 0;
  private lookY = 0;

  constructor(options: TouchInputOptions = {}) {
    this.stickRadius = options.stickRadius ?? STICK_RADIUS;
    this.deadZone = options.deadZone ?? STICK_DEAD_ZONE;
    this.flickMaxMs = options.flickMaxMs ?? FLICK_MAX_MS;
    this.flickMinDeflection = options.flickMinDeflection ?? FLICK_MIN_DEFLECTION;
  }

  /** True while a finger holds the stick. */
  get stickHeld(): boolean {
    return this.stickActive;
  }

  /** True while crouch is toggled on. */
  get crouching(): boolean {
    return this.crouch;
  }

  /** Current stick axes after the dead zone (x right, y forward). */
  get stick(): { x: number; y: number } {
    const len = Math.hypot(this.rawX, this.rawY);
    if (len <= this.deadZone) return { x: 0, y: 0 };
    // Rescale so output starts at 0 at the dead-zone edge and reaches 1 at full travel.
    const k = (len - this.deadZone) / (1 - this.deadZone) / len;
    return { x: this.rawX * k, y: this.rawY * k };
  }

  /** A finger touched the stick zone at screen point (x, y). The stick floats to it. */
  stickDown(x: number, y: number, timeMs: number): void {
    this.stickActive = true;
    this.stickStartMs = timeMs;
    this.originX = x;
    this.originY = y;
    this.rawX = this.rawY = this.peakX = this.peakY = 0;
  }

  /**
   * The stick finger moved to (x, y). Returns the knob offset in CSS pixels
   * from the stick centre, clamped to the radius (screen axes, y down).
   */
  stickMove(x: number, y: number): { dx: number; dy: number } {
    if (!this.stickActive) return { dx: 0, dy: 0 };
    let dx = x - this.originX;
    let dy = y - this.originY;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return { dx: 0, dy: 0 };
    const len = Math.hypot(dx, dy);
    if (len > this.stickRadius) {
      dx *= this.stickRadius / len;
      dy *= this.stickRadius / len;
    }
    this.rawX = dx / this.stickRadius;
    this.rawY = -dy / this.stickRadius;
    if (Math.hypot(this.rawX, this.rawY) > Math.hypot(this.peakX, this.peakY)) {
      this.peakX = this.rawX;
      this.peakY = this.rawY;
    }
    return { dx, dy };
  }

  /** The stick finger lifted. A short, far touch is a flick and queues a dodge. */
  stickUp(timeMs: number): void {
    if (!this.stickActive) return;
    const dt = timeMs - this.stickStartMs;
    if (
      dt >= 0 &&
      dt <= this.flickMaxMs &&
      Math.hypot(this.peakX, this.peakY) >= this.flickMinDeflection
    ) {
      this.dodge = flickDirection(this.peakX, this.peakY);
    }
    this.stickActive = false;
    this.rawX = this.rawY = this.peakX = this.peakY = 0;
  }

  /** Look drag in CSS pixels (x right, y down). */
  look(dx: number, dy: number): void {
    if (Number.isFinite(dx)) this.lookX += dx;
    if (Number.isFinite(dy)) this.lookY += dy;
  }

  /** A button went down. Crouch toggles; returns whether crouch is now on. */
  buttonDown(button: TouchButton): boolean {
    if (button === 'crouch') {
      this.crouch = !this.crouch;
      return this.crouch;
    }
    const held = HELD_BITS[button];
    if (held !== undefined) {
      this.held |= held;
      this.latched |= held;
    }
    const edge = EDGE_BITS[button];
    if (edge !== undefined) this.edges |= edge;
    return true;
  }

  buttonUp(button: TouchButton): void {
    const held = HELD_BITS[button];
    if (held !== undefined) this.held &= ~held;
  }

  /** Drop every held input, e.g. on blur or when the overlay unmounts. Crouch toggles off. */
  releaseAll(): void {
    this.stickActive = false;
    this.rawX = this.rawY = this.peakX = this.peakY = 0;
    this.held = this.latched = this.edges = 0;
    this.crouch = false;
    this.dodge = null;
    this.lookX = this.lookY = 0;
  }

  /** Return everything since the previous drain and start a new frame. */
  drain(): TouchFrame {
    const { x, y } = this.stick;
    const frame: TouchFrame = {
      moveX: x,
      moveY: y,
      lookX: this.lookX,
      lookY: this.lookY,
      buttons: this.held | this.latched | this.edges | (this.crouch ? Buttons.Crouch : 0),
      dodge: this.dodge,
    };
    this.latched = 0;
    this.edges = 0;
    this.dodge = null;
    this.lookX = this.lookY = 0;
    return frame;
  }
}
