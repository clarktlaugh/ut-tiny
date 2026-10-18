/**
 * On-screen controls for the view model demo, so it can be driven from a
 * phone: chips to pick a test position and weapon, toggles for the
 * single-pass comparison and hiding the weapon, and on touch screens a
 * virtual move stick (left part of the screen), drag-to-look (the rest) and
 * Fire / Alt / Jump / Crouch buttons. Dev demo only.
 */
import type { WeaponId } from '../../sim/types';

export interface DemoControlsOptions {
  root: HTMLElement;
  positions: readonly string[];
  weapons: readonly WeaponId[];
  onPosition(index: number): void;
  onWeapon(id: WeaponId): void;
  onFire(mode: 'primary' | 'alt', down: boolean): void;
  onJump(): void;
  onToggleNaive(): boolean;
  onToggleHidden(): boolean;
}

/** Short labels for the weapon chips, in slot order. */
const WEAPON_LABELS: Record<WeaponId, string> = {
  teleporter: 'Transloc',
  assault: 'Assault',
  mines: 'Mines',
  rocket: 'Rocket',
  sniper: 'Sniper',
  shock: 'Shock',
  shockScoped: 'Shock+',
  redeemer: 'Redeemer',
};

/** Fraction of the screen width, from the left, that acts as the move stick. */
const STICK_ZONE = 0.4;
/** Stick travel in CSS pixels for full deflection. */
const STICK_RADIUS = 56;

export class DemoControls {
  /** Move stick: x right, y forward, each −1..1. */
  readonly stick = { x: 0, y: 0 };
  crouching = false;
  readonly touch: boolean;

  private lookDX = 0;
  private lookDY = 0;
  private stickId: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  private readonly lookIds = new Map<number, { x: number; y: number }>();
  private readonly positionChips: HTMLButtonElement[] = [];
  private readonly weaponChips = new Map<WeaponId, HTMLButtonElement>();
  private readonly knob: HTMLDivElement;
  private readonly base: HTMLDivElement;

  constructor(options: DemoControlsOptions) {
    this.touch = window.matchMedia('(pointer: coarse)').matches;
    const { root } = options;
    root.classList.toggle('touch', this.touch);

    const top = el('div', 'vm-bar vm-top');
    const posRow = el('div', 'vm-row');
    posRow.append(label('Test spot'));
    options.positions.forEach((name, i) => {
      const b = chip(name, () => options.onPosition(i));
      this.positionChips.push(b);
      posRow.append(b);
    });
    const weaponRow = el('div', 'vm-row');
    weaponRow.append(label('Weapon'));
    options.weapons.forEach((id, i) => {
      const b = chip(`${i + 1} ${WEAPON_LABELS[id]}`, () => options.onWeapon(id));
      this.weaponChips.set(id, b);
      weaponRow.append(b);
    });
    const toggleRow = el('div', 'vm-row');
    toggleRow.append(label('Render'));
    const naive = chip('Single pass (clips)', () =>
      naive.classList.toggle('on', options.onToggleNaive()),
    );
    const hide = chip('Hide weapon', () => hide.classList.toggle('on', options.onToggleHidden()));
    toggleRow.append(naive, hide);
    top.append(posRow, weaponRow, toggleRow);
    root.append(top);

    this.base = el('div', 'vm-stick');
    this.knob = el('div', 'vm-knob');
    this.base.append(this.knob);
    this.base.hidden = true;
    root.append(this.base);

    if (this.touch) {
      const pad = el('div', 'vm-bar vm-pad');
      pad.append(
        holdButton('Fire', 'vm-fire', (d) => options.onFire('primary', d)),
        holdButton('Alt', '', (d) => options.onFire('alt', d)),
        holdButton('Jump', '', (d) => d && options.onJump()),
      );
      const crouch = chip('Crouch', () => {
        this.crouching = !this.crouching;
        crouch.classList.toggle('on', this.crouching);
      });
      crouch.classList.add('vm-btn');
      pad.append(crouch);
      root.append(pad);
      this.bindTouch(root);
    }
  }

  /** Take the look drag (CSS pixels) accumulated since the last call. */
  takeLook(): { dx: number; dy: number } {
    const out = { dx: this.lookDX, dy: this.lookDY };
    this.lookDX = 0;
    this.lookDY = 0;
    return out;
  }

  /** Highlight the current position and weapon chips. */
  sync(positionIndex: number, weapon: WeaponId | null): void {
    this.positionChips.forEach((b, i) => b.classList.toggle('on', i === positionIndex));
    for (const [id, b] of this.weaponChips) b.classList.toggle('on', id === weapon);
  }

  private bindTouch(surface: HTMLElement): void {
    const target = surface.querySelector('canvas') ?? surface;
    target.addEventListener('pointerdown', (e) => {
      const p = e as PointerEvent;
      if (p.pointerType === 'mouse') return;
      try {
        (target as HTMLElement).setPointerCapture(p.pointerId);
      } catch {
        // Capture is a nicety; drags still work without it.
      }
      if (this.stickId === null && p.clientX < window.innerWidth * STICK_ZONE) {
        this.stickId = p.pointerId;
        this.stickOrigin = { x: p.clientX, y: p.clientY };
        this.base.style.left = `${p.clientX}px`;
        this.base.style.top = `${p.clientY}px`;
        this.knob.style.transform = 'translate(-50%, -50%)';
        this.base.hidden = false;
      } else {
        this.lookIds.set(p.pointerId, { x: p.clientX, y: p.clientY });
      }
    });
    target.addEventListener('pointermove', (e) => {
      const p = e as PointerEvent;
      if (p.pointerId === this.stickId) {
        let dx = p.clientX - this.stickOrigin.x;
        let dy = p.clientY - this.stickOrigin.y;
        const len = Math.hypot(dx, dy);
        if (len > STICK_RADIUS) {
          dx *= STICK_RADIUS / len;
          dy *= STICK_RADIUS / len;
        }
        this.stick.x = dx / STICK_RADIUS;
        this.stick.y = -dy / STICK_RADIUS;
        this.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
        return;
      }
      const last = this.lookIds.get(p.pointerId);
      if (!last) return;
      // Touch look is a little faster than the mouse: screens are small.
      this.lookDX += (p.clientX - last.x) * 1.6;
      this.lookDY += (p.clientY - last.y) * 1.6;
      last.x = p.clientX;
      last.y = p.clientY;
    });
    const end = (e: Event): void => {
      const p = e as PointerEvent;
      if (p.pointerId === this.stickId) {
        this.stickId = null;
        this.stick.x = 0;
        this.stick.y = 0;
        this.base.hidden = true;
      }
      this.lookIds.delete(p.pointerId);
    };
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

function label(text: string): HTMLSpanElement {
  const s = el('span', 'vm-label');
  s.textContent = text;
  return s;
}

function chip(text: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', 'vm-chip');
  b.type = 'button';
  b.textContent = text;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function holdButton(
  text: string,
  extra: string,
  onChange: (down: boolean) => void,
): HTMLButtonElement {
  const b = el('button', `vm-chip vm-btn ${extra}`.trim());
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
    onChange(true);
  });
  const up = (e: PointerEvent): void => {
    e.stopPropagation();
    b.classList.remove('on');
    onChange(false);
  };
  b.addEventListener('pointerup', up);
  b.addEventListener('pointercancel', up);
  return b;
}
