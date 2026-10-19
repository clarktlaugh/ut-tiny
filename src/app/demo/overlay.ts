/**
 * Demo-only screen layer on top of the HUD (P19, `src/render/hud`): the
 * start / pause overlay, the Redeemer screen flash, a hurt vignette and short
 * centre messages ("You killed Lint", pickups). Scaled by CSS so it reads on
 * a phone.
 */
import type { SimEvent } from '../../sim/types';

const STYLE = /* css */ `
.demo-layer { position: fixed; inset: 0; pointer-events: none; color: #eef2ff;
  font: 600 clamp(13px, 2.2vmin, 20px)/1.25 system-ui, -apple-system, Segoe UI, sans-serif;
  text-shadow: 0 1px 2px rgb(0 0 0 / 80%); }
.demo-overlay { position: absolute; inset: 0; display: grid; place-items: center; background: rgb(10 12 16 / 55%);
  pointer-events: auto; text-align: center; padding: 24px; cursor: pointer; }
.demo-overlay h1 { margin: 0 0 0.3em; font-size: 2.4em; font-weight: 800; }
.demo-overlay p { margin: 0.3em 0; max-width: 34em; font-weight: 500; }
.demo-overlay small { display: block; margin-top: 1.4em; opacity: 0.75; font-weight: 500; }
.demo-overlay a { color: #8fd6ff; }
.demo-overlay[hidden] { display: none; }
.demo-flash { position: absolute; inset: 0; background: #fff4dc; opacity: 0; }
.demo-hurt { position: absolute; inset: 0; box-shadow: inset 0 0 12vmin rgb(255 40 20 / 90%); opacity: 0; transition: opacity 0.4s; }
.demo-msg { position: absolute; left: 50%; top: 64%; transform: translateX(-50%); font-size: 1.3em; opacity: 0; transition: opacity 0.4s; white-space: nowrap; }
.demo-msg.show { opacity: 1; }
`;

export interface OverlayNames {
  nameOf(pawn: number): string;
}

export class DemoOverlay {
  readonly root: HTMLDivElement;
  private readonly overlay: HTMLDivElement;
  private readonly overlayTitle: HTMLHeadingElement;
  private readonly overlayBody: HTMLParagraphElement;
  private readonly flash: HTMLDivElement;
  private readonly hurt: HTMLDivElement;
  private readonly msg: HTMLDivElement;
  private hurtUntil = 0;
  private msgUntil = 0;
  private now = 0;

  constructor(
    parent: HTMLElement,
    private readonly names: OverlayNames,
    private readonly localPawn: number,
  ) {
    const style = document.createElement('style');
    style.textContent = STYLE;
    parent.append(style);
    this.root = el('div', 'demo-layer');
    this.flash = el('div', 'demo-flash');
    this.hurt = el('div', 'demo-hurt');
    this.msg = el('div', 'demo-msg');
    this.overlay = el('div', 'demo-overlay');
    this.overlayTitle = el('h1', '');
    this.overlayBody = el('p', '');
    this.overlay.append(this.overlayTitle, this.overlayBody);
    this.root.append(this.flash, this.hurt, this.msg, this.overlay);
    parent.append(this.root);
  }

  /** Show the centre overlay. `html` is author-controlled text and may contain links. */
  showOverlay(title: string, html: string): void {
    this.overlayTitle.textContent = title;
    this.overlayBody.innerHTML = html;
    this.overlay.hidden = false;
  }

  hideOverlay(): void {
    this.overlay.hidden = true;
  }

  get overlayVisible(): boolean {
    return !this.overlay.hidden;
  }

  onOverlayClick(cb: () => void): void {
    this.overlay.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('a')) return;
      cb();
    });
  }

  /** Screen flash opacity (0..1), from the FX system's Redeemer flash. */
  setFlash(intensity: number): void {
    this.flash.style.opacity = intensity.toFixed(3);
  }

  /** React to a tick's events: hurt vignette and centre messages. */
  onEvents(events: readonly SimEvent[], time: number): void {
    this.now = time;
    for (const e of events) {
      switch (e.type) {
        case 'death': {
          const victim = this.names.nameOf(e.victim);
          if (e.killer === 0 || e.killer === e.victim) {
            if (e.victim === this.localPawn) this.message('You died.', 2.5);
          } else if (e.killer === this.localPawn) {
            this.message(`You killed ${victim}`, 2);
          } else if (e.victim === this.localPawn) {
            this.message(`Killed by ${this.names.nameOf(e.killer)}`, 2.5);
          }
          break;
        }
        case 'damage':
          if (e.target === this.localPawn && e.amount > 0) this.hurtUntil = time + 0.35;
          break;
        case 'pickupTaken':
          if (e.pawn === this.localPawn) this.message(pickupMessage(e.pickupType), 1.5);
          break;
        case 'respawn':
          if (e.pawn === this.localPawn) this.message('', 0);
          break;
        default:
          break;
      }
    }
  }

  /** Refresh timed elements. Call once per frame with sim time. */
  update(time: number): void {
    this.now = time;
    this.hurt.style.opacity = this.hurtUntil > time ? '1' : '0';
    this.msg.classList.toggle('show', this.msgUntil > time);
  }

  message(text: string, seconds: number): void {
    this.msg.textContent = text;
    this.msgUntil = this.now + seconds;
  }
}

function pickupMessage(type: string): string {
  switch (type) {
    case 'healthVial':
      return 'Health +5';
    case 'healthPack':
      return 'Health +25';
    case 'shieldPack':
      return 'Shield +50';
    case 'superShield':
      return 'Super Shield';
    case 'udamage':
      return 'Double Damage!';
    case 'ammo':
      return 'Ammo';
    default:
      return 'Weapon';
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
