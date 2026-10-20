/**
 * Movement readout for the walkabout (P31): a small panel with health,
 * speed, height and state, the last landing (impact speed and the damage it
 * did), short flashes for the moves worth noticing (double jump, dodge, wall
 * dodge, jump pad, burning), a death line with the reason and how to respawn,
 * and a center dot. Mounted on the client as a plugin; DOM only here, the
 * numbers come from `ClientFrame`.
 */
import type { ClientFrame, ClientPlugin } from '../../client';
import { feetOffset, pawnCapsule, type MovementConfig } from '../../sim/movement';
import type { DamageType, PawnId, SimEvent } from '../../sim/types';
import { el } from './sheet';

export interface ReadoutOptions {
  root: HTMLElement;
  localPawn: PawnId;
  /** The config the world moves with (for the feet height while crouching). */
  movement: Readonly<MovementConfig>;
  inWater: (pawn: PawnId) => boolean;
  /** Touch controls are on (changes the respawn hint). */
  touch: boolean;
}

export interface Readout extends ClientPlugin {
  readonly element: HTMLElement;
}

/** How long a flash stays on screen, ms. */
export const FLASH_MS = 1100;
/** Readout refresh interval, ms. */
const REFRESH_MS = 100;

const DEATH_TEXT: Partial<Record<DamageType, string>> = {
  fall: 'the fall killed you',
  killVolume: 'a kill volume got you',
  damageVolume: 'the iron cooked you',
};

export function readoutPlugin(options: ReadoutOptions): Readout {
  const panel = el('div', 'lw-readout');
  const vitals = el('div', 'lw-vitals');
  const motion = el('div', 'lw-motion');
  const stateLine = el('div', 'lw-state');
  const landing = el('div', 'lw-landing', 'last landing: —');
  panel.append(vitals, motion, stateLine, landing);
  const flash = el('div', 'lw-flash');
  const dead = el('div', 'lw-dead');
  dead.hidden = true;
  const dot = el('div', 'lw-dot');
  options.root.append(panel, flash, dead, dot);

  let lastRefresh = -Infinity;
  let lastImpact: { speed: number; damage: number } | null = null;
  let landedTick = -1;
  let deathReason: string | null = null;
  const flashes: { node: HTMLElement; until: number }[] = [];

  function now(): number {
    return typeof performance === 'undefined' ? Date.now() : performance.now();
  }

  function show(text: string): void {
    const node = el('div', 'lw-flash-item', text);
    flash.append(node);
    flashes.push({ node, until: now() + FLASH_MS });
  }

  function tick(events: readonly SimEvent[]): void {
    for (const e of events) {
      switch (e.type) {
        case 'land':
          if (e.pawn === options.localPawn) {
            lastImpact = { speed: e.impactSpeed, damage: 0 };
            landedTick = e.tick;
          }
          break;
        case 'damage':
          if (e.target !== options.localPawn) break;
          if (e.damageType === 'fall' && lastImpact && e.tick === landedTick) {
            lastImpact.damage += e.amount;
          } else if (e.damageType === 'damageVolume') {
            show('Burning');
          }
          break;
        case 'jump':
          if (e.pawn === options.localPawn && e.double) show('Double jump');
          break;
        case 'dodge':
          if (e.pawn === options.localPawn) show(e.wall ? 'Wall dodge' : 'Dodge');
          break;
        case 'jumpPad':
          if (e.pawn === options.localPawn) show('Jump pad');
          break;
        case 'death':
          if (e.victim === options.localPawn) {
            deathReason =
              e.message !== undefined
                ? `you were ${e.message}`
                : (DEATH_TEXT[e.damageType] ?? 'you died');
          }
          break;
        case 'respawn':
          if (e.pawn === options.localPawn) deathReason = null;
          break;
      }
    }
  }

  function refresh(frame: ClientFrame): void {
    const t = now();
    for (let i = flashes.length - 1; i >= 0; i--) {
      const f = flashes[i];
      if (f && f.until <= t) {
        f.node.remove();
        flashes.splice(i, 1);
      }
    }
    if (t - lastRefresh < REFRESH_MS) return;
    lastRefresh = t;
    const pawn = frame.pawn;
    if (!pawn) {
      vitals.textContent = 'no pawn';
      return;
    }
    const shield = pawn.shield > 0 ? `  shield ${pawn.shield}` : '';
    vitals.textContent = `health ${Math.max(0, Math.round(pawn.health))}${shield}`;
    const speed = Math.hypot(pawn.velocity.x, pawn.velocity.z);
    const feet = pawn.position.y - feetOffset(pawnCapsule(pawn.crouching, options.movement));
    motion.textContent =
      `${speed.toFixed(1)} m/s  ${pawn.velocity.y >= 0 ? '↑' : '↓'}${Math.abs(pawn.velocity.y).toFixed(1)} m/s` +
      `  height ${Math.max(0, feet).toFixed(1)} m`;
    const flags = [
      pawn.grounded ? 'grounded' : 'airborne',
      pawn.crouching ? 'crouching' : null,
      options.inWater(pawn.id) ? 'in water' : null,
    ].filter((f): f is string => f !== null);
    stateLine.textContent = flags.join(' · ');
    if (lastImpact) {
      const dmg = lastImpact.damage > 0 ? `−${Math.round(lastImpact.damage)} health` : 'no damage';
      landing.textContent = `last landing: ${lastImpact.speed.toFixed(1)} m/s, ${dmg}`;
      landing.classList.toggle('lw-hurt', lastImpact.damage > 0);
    }
    const isDead = !pawn.alive;
    dead.hidden = !isDead;
    if (isDead) {
      const how = options.touch ? 'Tap FIRE' : 'Click';
      dead.textContent = `${deathReason ?? 'you died'}. ${how} to respawn, or wait a moment.`;
    }
    dot.hidden = isDead;
  }

  return {
    element: panel,
    tick,
    afterRender: refresh,
    dispose() {
      panel.remove();
      flash.remove();
      dead.remove();
      dot.remove();
    },
  };
}
