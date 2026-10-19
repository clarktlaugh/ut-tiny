/**
 * DOM HUD for the playable demo (docs/DESIGN.md §11, placeholder version):
 * crosshair, health / shield, ammo and weapon, frags, a kill feed, and a
 * centre overlay for "click to play" and death messages. Scaled by CSS so it
 * reads on a phone.
 */
import type { PawnState, SimEvent, WeaponId } from '../../sim/types';

export const WEAPON_NAMES: Readonly<Record<WeaponId, string>> = {
  teleporter: 'Translocator',
  assault: 'Assault Rifle',
  mines: 'Proximity Mines',
  rocket: 'Rocket Launcher',
  sniper: 'Sniper Rifle',
  shock: 'Super Shock Rifle',
  shockScoped: 'Super Shock Rifle (scoped)',
  redeemer: 'Redeemer',
};

const STYLE = /* css */ `
.hud { position: fixed; inset: 0; pointer-events: none; color: #eef2ff;
  font: 600 clamp(13px, 2.2vmin, 20px)/1.25 system-ui, -apple-system, Segoe UI, sans-serif;
  text-shadow: 0 1px 2px rgb(0 0 0 / 80%); }
.hud-cross { position: absolute; left: 50%; top: 50%; width: 22px; height: 22px; margin: -11px 0 0 -11px; }
.hud-cross::before, .hud-cross::after { content: ''; position: absolute; background: rgb(255 255 255 / 85%); }
.hud-cross::before { left: 10px; top: 0; width: 2px; height: 22px; }
.hud-cross::after { top: 10px; left: 0; width: 22px; height: 2px; }
.hud-stat { position: absolute; bottom: max(14px, env(safe-area-inset-bottom)); display: flex; gap: 1.2em; align-items: baseline; }
.hud-left { left: max(14px, env(safe-area-inset-left)); }
.hud-right { right: max(14px, env(safe-area-inset-right)); text-align: right; flex-direction: column; gap: 0.1em; align-items: flex-end; }
.hud.touch .hud-right { right: 190px; }
.hud.touch .hud-left { bottom: 150px; }
.hud-big { font-size: 2.2em; font-weight: 800; letter-spacing: -0.02em; }
.hud-label { opacity: 0.7; font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.08em; }
.hud-health.low { color: #ff6a5a; }
.hud-shield { color: #ffd23a; }
.hud-score { position: absolute; top: max(10px, env(safe-area-inset-top)); left: max(14px, env(safe-area-inset-left)); }
.hud-feed { position: absolute; top: max(10px, env(safe-area-inset-top)); right: max(14px, env(safe-area-inset-right)); text-align: right; font-size: 0.9em; }
.hud-feed div { opacity: 0; transition: opacity 0.3s; }
.hud-feed div.show { opacity: 1; }
.hud-overlay { position: absolute; inset: 0; display: grid; place-items: center; background: rgb(10 12 16 / 55%);
  pointer-events: auto; text-align: center; padding: 24px; cursor: pointer; }
.hud-overlay h1 { margin: 0 0 0.3em; font-size: 2.4em; font-weight: 800; }
.hud-overlay p { margin: 0.3em 0; max-width: 34em; font-weight: 500; }
.hud-overlay small { display: block; margin-top: 1.4em; opacity: 0.75; font-weight: 500; }
.hud-overlay a { color: #8fd6ff; }
.hud-overlay[hidden] { display: none; }
.hud-flash { position: absolute; inset: 0; background: #fff4dc; opacity: 0; }
.hud-hurt { position: absolute; inset: 0; box-shadow: inset 0 0 12vmin rgb(255 40 20 / 90%); opacity: 0; transition: opacity 0.4s; }
.hud-msg { position: absolute; left: 50%; top: 62%; transform: translateX(-50%); font-size: 1.4em; opacity: 0; transition: opacity 0.4s; white-space: nowrap; }
.hud-msg.show { opacity: 1; }
`;

const FEED_LINES = 5;
const FEED_SECONDS = 6;

export interface HudNames {
  nameOf(pawn: number): string;
}

export class Hud {
  readonly root: HTMLDivElement;
  private readonly health: HTMLSpanElement;
  private readonly shield: HTMLSpanElement;
  private readonly ammo: HTMLSpanElement;
  private readonly weapon: HTMLSpanElement;
  private readonly score: HTMLDivElement;
  private readonly feed: HTMLDivElement;
  private readonly overlay: HTMLDivElement;
  private readonly overlayTitle: HTMLHeadingElement;
  private readonly overlayBody: HTMLParagraphElement;
  private readonly flash: HTMLDivElement;
  private readonly hurt: HTMLDivElement;
  private readonly msg: HTMLDivElement;
  private readonly feedLines: { el: HTMLDivElement; until: number }[] = [];
  private hurtUntil = 0;
  private msgUntil = 0;
  private now = 0;

  constructor(
    parent: HTMLElement,
    private readonly names: HudNames,
    private readonly localPawn: number,
    touch = false,
  ) {
    const style = document.createElement('style');
    style.textContent = STYLE;
    parent.append(style);
    this.root = el('div', touch ? 'hud touch' : 'hud');

    this.flash = el('div', 'hud-flash');
    this.hurt = el('div', 'hud-hurt');
    const cross = el('div', 'hud-cross');

    const left = el('div', 'hud-stat hud-left');
    this.health = el('span', 'hud-big hud-health');
    this.shield = el('span', 'hud-big hud-shield');
    left.append(labelled('Health', this.health), labelled('Shield', this.shield));

    const right = el('div', 'hud-stat hud-right');
    this.ammo = el('span', 'hud-big');
    this.weapon = el('span', 'hud-label');
    right.append(this.ammo, this.weapon);

    this.score = el('div', 'hud-score');
    this.feed = el('div', 'hud-feed');
    for (let i = 0; i < FEED_LINES; i++) {
      const line = el('div', '');
      this.feed.append(line);
      this.feedLines.push({ el: line, until: 0 });
    }
    this.msg = el('div', 'hud-msg');

    this.overlay = el('div', 'hud-overlay');
    this.overlayTitle = el('h1', '');
    this.overlayBody = el('p', '');
    this.overlay.append(this.overlayTitle, this.overlayBody);

    this.root.append(
      this.flash,
      this.hurt,
      cross,
      left,
      right,
      this.score,
      this.feed,
      this.msg,
      this.overlay,
    );
    parent.append(this.root);
  }

  /** Show the centre overlay. `html` may contain links; it is author-controlled text. */
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

  /** React to a tick's events: kill feed, hurt vignette, pickup messages. */
  onEvents(events: readonly SimEvent[], time: number): void {
    this.now = time;
    for (const e of events) {
      switch (e.type) {
        case 'death': {
          const victim = this.names.nameOf(e.victim);
          if (e.killer === 0 || e.killer === e.victim) {
            const how =
              e.damageType === 'killVolume'
                ? (e.message ?? 'fell')
                : e.damageType === 'fall'
                  ? 'fell to their death'
                  : 'blew up';
            this.pushFeed(`${victim} ${how}`);
            if (e.victim === this.localPawn) this.message(`You ${how}.`, 2.5);
          } else {
            const killer = this.names.nameOf(e.killer);
            this.pushFeed(`${killer} killed ${victim}`);
            if (e.killer === this.localPawn) this.message(`You killed ${victim}`, 2);
            if (e.victim === this.localPawn) this.message(`Killed by ${killer}`, 2.5);
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

  /** Refresh the numbers from the local pawn's state. */
  update(pawn: Readonly<PawnState> | undefined, frags: number, deaths: number, time: number): void {
    this.now = time;
    const alive = pawn?.alive ?? false;
    const health = alive ? Math.max(0, Math.round(pawn!.health)) : 0;
    this.health.textContent = String(health);
    this.health.classList.toggle('low', health <= 30);
    this.shield.textContent = String(alive ? Math.round(pawn!.shield) : 0);
    const weapon = pawn?.pendingWeapon ?? pawn?.weapon ?? null;
    if (alive && weapon) {
      const ammo = pawn!.ammo[weapon];
      this.ammo.textContent = ammo === undefined ? '∞' : String(ammo);
      this.weapon.textContent = WEAPON_NAMES[weapon];
    } else {
      this.ammo.textContent = '';
      this.weapon.textContent = '';
    }
    this.score.textContent = `${frags} frags · ${deaths} deaths`;
    this.hurt.style.opacity = this.hurtUntil > time ? '1' : '0';
    this.msg.classList.toggle('show', this.msgUntil > time);
    for (const line of this.feedLines) line.el.classList.toggle('show', line.until > time);
  }

  message(text: string, seconds: number): void {
    this.msg.textContent = text;
    this.msgUntil = this.now + seconds;
  }

  pushFeed(text: string): void {
    const last = this.feedLines[this.feedLines.length - 1]!;
    // Scroll up: drop the oldest line.
    for (let i = 0; i < this.feedLines.length - 1; i++) {
      const next = this.feedLines[i + 1]!;
      this.feedLines[i]!.el.textContent = next.el.textContent;
      this.feedLines[i]!.until = next.until;
    }
    last.el.textContent = text;
    last.until = this.now + FEED_SECONDS;
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

function labelled(label: string, value: HTMLElement): HTMLDivElement {
  const d = el('div', '');
  const l = el('div', 'hud-label');
  l.textContent = label;
  d.append(value, l);
  return d;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}
