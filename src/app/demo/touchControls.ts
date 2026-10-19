/**
 * Touch controls for the playable demo, so it can be played from a phone:
 * a virtual move stick on the left part of the screen, drag-to-look on the
 * rest, and Fire / Alt / Jump / Weapon buttons. Produces plain numbers that
 * the demo merges into the `PlayerController`'s commands each tick; nothing
 * here knows about the sim.
 */
import { Buttons } from '../../sim/types';

/** Fraction of the screen width, from the left, that acts as the move stick. */
const STICK_ZONE = 0.42;
/** Stick travel in CSS pixels for full deflection. */
const STICK_RADIUS = 56;
/** Radians of look per CSS pixel of drag. */
export const TOUCH_LOOK_RADIANS_PER_PX = 0.0045;

const STYLE = /* css */ `
/* Lift the HUD's bottom readouts clear of the buttons and the stick zone. */
.touch-ui .hud-vitals { bottom: 150px; }
.touch-ui .hud-ammo { bottom: 150px; right: 16px; }
.touch-ui .hud-bar { bottom: 120px; }
.touch-ui .hud-power { bottom: 220px; }
.tc-stick { position: fixed; width: 120px; height: 120px; margin: -60px 0 0 -60px; border-radius: 50%;
  border: 2px solid rgb(255 255 255 / 45%); background: rgb(0 0 0 / 20%); pointer-events: none; }
.tc-knob { position: absolute; left: 50%; top: 50%; width: 52px; height: 52px; border-radius: 50%;
  background: rgb(255 255 255 / 70%); transform: translate(-50%, -50%); }
.tc-pad { position: fixed; right: 12px; bottom: 18px; display: grid; gap: 10px;
  grid-template-columns: 64px 64px; grid-template-rows: 64px 64px; pointer-events: none; }
.tc-btn { pointer-events: auto; border: 2px solid rgb(255 255 255 / 55%); border-radius: 50%;
  background: rgb(20 24 30 / 55%); color: #eef; font: 600 13px/1 system-ui, sans-serif;
  touch-action: none; user-select: none; -webkit-user-select: none; -webkit-tap-highlight-color: transparent; }
.tc-btn.on { background: rgb(255 170 60 / 70%); }
.tc-fire { grid-column: 2; grid-row: 2; width: 84px; height: 84px; margin: -20px 0 0 -20px; font-size: 15px; }
.tc-alt { grid-column: 1; grid-row: 2; }
.tc-jump { grid-column: 2; grid-row: 1; }
.tc-weapon { grid-column: 1; grid-row: 1; }
`;

export class TouchControls {
  /** True on coarse-pointer devices; the controls are only built then. */
  readonly enabled: boolean;
  /** Move stick: x right, y forward, each in −1..1. */
  readonly stick = { x: 0, y: 0 };

  private held = 0;
  /** Buttons pressed since the last `takeButtons`, so a tap between ticks is never lost. */
  private latched = 0;
  private edges = 0;
  private lookDX = 0;
  private lookDY = 0;
  private stickId: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  private readonly lookIds = new Map<number, { x: number; y: number }>();
  private readonly base: HTMLDivElement | null = null;
  private readonly knob: HTMLDivElement | null = null;
  private readonly nodes: HTMLElement[] = [];

  constructor(
    private readonly surface: HTMLElement,
    root: HTMLElement,
  ) {
    // `?touch=1` forces the controls on (for testing them on a desktop).
    const forced = new URLSearchParams(location.search).get('touch') === '1';
    this.enabled =
      forced || (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
    if (!this.enabled) return;

    const style = document.createElement('style');
    style.textContent = STYLE;
    root.append(style);
    this.nodes.push(style);

    this.base = el('div', 'tc-stick');
    this.knob = el('div', 'tc-knob');
    this.base.append(this.knob);
    this.base.hidden = true;
    root.append(this.base);
    this.nodes.push(this.base);

    const pad = el('div', 'tc-pad');
    pad.append(
      this.holdButton('FIRE', 'tc-fire', Buttons.Fire),
      this.holdButton('ALT', 'tc-alt', Buttons.AltFire),
      this.holdButton('JUMP', 'tc-jump', Buttons.Jump),
      this.tapButton('WPN', 'tc-weapon', Buttons.NextWeapon),
    );
    root.append(pad);
    this.nodes.push(pad);
    this.bindSurface();
  }

  /** Buttons held now, or tapped since the last call (`Buttons` bits). Call once per tick. */
  takeButtons(): number {
    const b = this.held | this.latched;
    this.latched = 0;
    return b;
  }

  /** One-tick button edges since the last call (weapon switch). */
  takeEdges(): number {
    const e = this.edges;
    this.edges = 0;
    return e;
  }

  /** Look drag in CSS pixels since the last call. */
  takeLook(): { dx: number; dy: number } {
    const out = { dx: this.lookDX, dy: this.lookDY };
    this.lookDX = 0;
    this.lookDY = 0;
    return out;
  }

  dispose(): void {
    for (const n of this.nodes) n.remove();
  }

  private bindSurface(): void {
    const target = this.surface;
    target.addEventListener('pointerdown', (p) => {
      if (p.pointerType === 'mouse') return;
      try {
        target.setPointerCapture(p.pointerId);
      } catch {
        // Capture is a nicety; drags still work without it.
      }
      if (this.stickId === null && p.clientX < window.innerWidth * STICK_ZONE) {
        this.stickId = p.pointerId;
        this.stickOrigin = { x: p.clientX, y: p.clientY };
        if (this.base && this.knob) {
          this.base.style.left = `${p.clientX}px`;
          this.base.style.top = `${p.clientY}px`;
          this.knob.style.transform = 'translate(-50%, -50%)';
          this.base.hidden = false;
        }
      } else {
        this.lookIds.set(p.pointerId, { x: p.clientX, y: p.clientY });
      }
    });
    target.addEventListener('pointermove', (p) => {
      if (p.pointerId === this.stickId) {
        let dx = p.clientX - this.stickOrigin.x;
        let dy = p.clientY - this.stickOrigin.y;
        const d = Math.hypot(dx, dy);
        if (d > STICK_RADIUS) {
          dx *= STICK_RADIUS / d;
          dy *= STICK_RADIUS / d;
        }
        this.stick.x = dx / STICK_RADIUS;
        this.stick.y = -dy / STICK_RADIUS;
        if (this.knob) {
          this.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
        }
        return;
      }
      const last = this.lookIds.get(p.pointerId);
      if (!last) return;
      this.lookDX += p.clientX - last.x;
      this.lookDY += p.clientY - last.y;
      last.x = p.clientX;
      last.y = p.clientY;
    });
    const end = (p: PointerEvent): void => {
      if (p.pointerId === this.stickId) {
        this.stickId = null;
        this.stick.x = 0;
        this.stick.y = 0;
        if (this.base) this.base.hidden = true;
      }
      this.lookIds.delete(p.pointerId);
    };
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  }

  private holdButton(text: string, cls: string, bit: number): HTMLButtonElement {
    const b = el('button', `tc-btn ${cls}`);
    b.type = 'button';
    b.textContent = text;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        b.setPointerCapture(e.pointerId);
      } catch {
        // See above.
      }
      b.classList.add('on');
      this.held |= bit;
      this.latched |= bit;
    });
    const up = (e: PointerEvent): void => {
      e.stopPropagation();
      b.classList.remove('on');
      this.held &= ~bit;
    };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    return b;
  }

  private tapButton(text: string, cls: string, bit: number): HTMLButtonElement {
    const b = el('button', `tc-btn ${cls}`);
    b.type = 'button';
    b.textContent = text;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.edges |= bit;
      b.classList.add('on');
    });
    const up = (e: PointerEvent): void => {
      e.stopPropagation();
      b.classList.remove('on');
    };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    return b;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  return e;
}
