/**
 * On-screen touch controls (docs/DESIGN.md §11, §18.8): a floating move stick
 * on the left half of the screen, drag-to-look on the right half, buttons for
 * fire, alt fire, jump, crouch (toggle) and next/previous weapon, and a
 * rotate-to-landscape hint in portrait. Dragging from the Fire button also
 * looks, so you can aim while shooting with one thumb.
 *
 * It only translates DOM pointer events into `TouchInput` calls; everything
 * game-facing lives there and in `TouchController`. `mount`/`unmount` match the
 * demo shell's `InputOverlay`, so `src/demos/shell/input.ts` can hand it over.
 */
import { TouchInput, type TouchButton } from './touchInput';

/** Fraction of the screen width, from the left, that starts the move stick. */
export const STICK_ZONE = 0.5;

const STYLE = /* css */ `
.tc-surface { position: absolute; inset: 0; pointer-events: auto; touch-action: none;
  user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
.tc-stick { position: fixed; width: 120px; height: 120px; margin: -60px 0 0 -60px; border-radius: 50%;
  border: 2px solid rgb(255 255 255 / 45%); background: rgb(0 0 0 / 20%); pointer-events: none; }
.tc-knob { position: absolute; left: 50%; top: 50%; width: 52px; height: 52px; border-radius: 50%;
  background: rgb(255 255 255 / 70%); transform: translate(-50%, -50%); }
.tc-hint { position: fixed; left: calc(16px + env(safe-area-inset-left, 0px));
  top: calc(12px + env(safe-area-inset-top, 0px)); color: rgb(255 255 255 / 55%);
  font: 12px/1.3 system-ui, sans-serif; pointer-events: none; }
.tc-pad { position: fixed; right: calc(12px + env(safe-area-inset-right, 0px));
  bottom: calc(14px + env(safe-area-inset-bottom, 0px)); display: grid; gap: 10px;
  grid-template-columns: 52px 64px 84px; grid-template-rows: 52px 64px 84px;
  align-items: center; justify-items: center; pointer-events: none; }
.tc-btn { pointer-events: auto; width: 64px; height: 64px; padding: 0; border-radius: 50%;
  border: 2px solid rgb(255 255 255 / 55%); background: rgb(20 24 30 / 55%); color: #eef;
  font: 600 12px/1 system-ui, sans-serif; touch-action: none; user-select: none;
  -webkit-user-select: none; -webkit-tap-highlight-color: transparent; }
.tc-btn.on { background: rgb(255 170 60 / 70%); }
.tc-small { width: 52px; height: 52px; font-size: 16px; }
.tc-fire { grid-column: 3; grid-row: 3; width: 84px; height: 84px; font-size: 14px; }
.tc-alt { grid-column: 2; grid-row: 3; }
.tc-jump { grid-column: 3; grid-row: 2; }
.tc-crouch { grid-column: 1; grid-row: 3; }
.tc-next { grid-column: 3; grid-row: 1; }
.tc-prev { grid-column: 2; grid-row: 1; }
.tc-rotate { display: none; position: fixed; left: 50%; top: 40%; transform: translate(-50%, -50%);
  max-width: 80vw; padding: 14px 18px; border-radius: 12px; background: rgb(10 12 16 / 85%);
  color: #fff; font: 15px/1.4 system-ui, sans-serif; text-align: center; pointer-events: auto; }
@media (orientation: portrait) { .tc-rotate:not(.tc-dismissed) { display: block; } }
`;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function capture(target: Element, id: number): void {
  try {
    target.setPointerCapture(id);
  } catch {
    // Capture is a nicety; drags still work without it.
  }
}

export interface TouchOverlayOptions {
  input: TouchInput;
  /** Source of size, blur and visibility; defaults to the global window. */
  window?: Window;
}

export class TouchOverlay {
  readonly input: TouchInput;
  private readonly winOption: Window | undefined;
  private win!: Window;
  private nodes: HTMLElement[] = [];
  private cleanups: (() => void)[] = [];
  private stickId: number | null = null;
  private readonly lookIds = new Map<number, { x: number; y: number }>();
  private base: HTMLDivElement | null = null;
  private knob: HTMLDivElement | null = null;

  constructor(options: TouchOverlayOptions) {
    this.input = options.input;
    this.winOption = options.window;
  }

  get mounted(): boolean {
    return this.nodes.length > 0;
  }

  mount(root: HTMLElement): void {
    if (this.mounted) this.unmount();
    this.win = this.winOption ?? window;
    const style = el('style', '');
    style.textContent = STYLE;

    const surface = el('div', 'tc-surface');
    surface.dataset.touchSurface = '';
    this.base = el('div', 'tc-stick');
    this.knob = el('div', 'tc-knob');
    this.base.append(this.knob);
    this.base.hidden = true;

    const hint = el('div', 'tc-hint', 'Left: move (flick to dodge) · Right: look');

    const pad = el('div', 'tc-pad');
    const fire = this.button('FIRE', 'tc-fire', 'fire', true);
    pad.append(
      fire,
      this.button('ALT', 'tc-alt', 'altFire'),
      this.button('JUMP', 'tc-jump', 'jump'),
      this.button('CRCH', 'tc-crouch', 'crouch'),
      this.button('▶', 'tc-next tc-small', 'nextWeapon'),
      this.button('◀', 'tc-prev tc-small', 'prevWeapon'),
    );

    const rotate = el('div', 'tc-rotate', 'Turn your phone sideways to play. Tap to dismiss.');
    rotate.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      rotate.classList.add('tc-dismissed');
    });

    this.bindSurface(surface);
    root.append(style, surface, this.base, hint, pad, rotate);
    this.nodes = [style, surface, this.base, hint, pad, rotate];

    const release = (): void => this.releaseAll();
    const onVisibility = (): void => {
      if (this.win.document.visibilityState === 'hidden') release();
    };
    this.win.addEventListener('blur', release);
    this.win.document.addEventListener('visibilitychange', onVisibility);
    this.cleanups.push(
      () => this.win.removeEventListener('blur', release),
      () => this.win.document.removeEventListener('visibilitychange', onVisibility),
    );
  }

  unmount(): void {
    for (const c of this.cleanups) c();
    for (const n of this.nodes) n.remove();
    this.cleanups = [];
    this.nodes = [];
    this.base = this.knob = null;
    this.releaseAll();
  }

  private releaseAll(): void {
    this.stickId = null;
    this.lookIds.clear();
    this.input.releaseAll();
    if (this.base) this.base.hidden = true;
    for (const n of this.nodes) {
      for (const b of n.querySelectorAll('.tc-btn.on')) b.classList.remove('on');
    }
  }

  private bindSurface(surface: HTMLElement): void {
    surface.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      capture(surface, e.pointerId);
      if (this.stickId === null && e.clientX < this.win.innerWidth * STICK_ZONE) {
        this.stickId = e.pointerId;
        this.input.stickDown(e.clientX, e.clientY, e.timeStamp);
        if (this.base && this.knob) {
          this.base.style.left = `${e.clientX}px`;
          this.base.style.top = `${e.clientY}px`;
          this.knob.style.transform = 'translate(-50%, -50%)';
          this.base.hidden = false;
        }
      } else {
        this.lookIds.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }
    });
    surface.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.stickId) {
        const { dx, dy } = this.input.stickMove(e.clientX, e.clientY);
        if (this.knob) {
          this.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
        }
        return;
      }
      this.lookMove(e);
    });
    const end = (e: PointerEvent): void => {
      if (e.pointerId === this.stickId) {
        this.stickId = null;
        this.input.stickUp(e.timeStamp);
        if (this.base) this.base.hidden = true;
      }
      this.lookIds.delete(e.pointerId);
    };
    surface.addEventListener('pointerup', end);
    surface.addEventListener('pointercancel', end);
  }

  private lookMove(e: PointerEvent): void {
    const last = this.lookIds.get(e.pointerId);
    if (!last) return;
    this.input.look(e.clientX - last.x, e.clientY - last.y);
    last.x = e.clientX;
    last.y = e.clientY;
  }

  private button(text: string, cls: string, action: TouchButton, drags = false): HTMLButtonElement {
    const b = el('button', `tc-btn ${cls}`, text);
    b.type = 'button';
    b.dataset.touchButton = action;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      capture(b, e.pointerId);
      const on = this.input.buttonDown(action);
      if (action === 'crouch') b.classList.toggle('on', on);
      else b.classList.add('on');
      if (drags) this.lookIds.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    if (drags) {
      b.addEventListener('pointermove', (e) => {
        e.stopPropagation();
        this.lookMove(e);
      });
    }
    const up = (e: PointerEvent): void => {
      e.stopPropagation();
      this.input.buttonUp(action);
      if (action !== 'crouch') b.classList.remove('on');
      this.lookIds.delete(e.pointerId);
    };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    // Long presses on iOS would otherwise open the callout or select text.
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    return b;
  }
}
