/**
 * Announcer line tables and the per-player kill streak tracker (§6).
 *
 * - Multi kills: kills less than `multiKillWindow` (3 s) apart chain; the
 *   2nd kill in a chain is a Double Kill, then Multi, Mega, Ultra, and
 *   Monster Kill for the 6th and every one after.
 * - Sprees: Killing Spree / Rampage / Dominating / Unstoppable / Godlike at
 *   exactly 5 / 10 / 15 / 20 / 25 kills without dying.
 * - Frags remaining: 3 / 2 / 1 as the leader approaches the frag limit.
 *
 * Pure data and arithmetic; `DeathmatchRules` decides who hears what.
 */
import type { AnnouncerLine, Seconds } from '../types';

/** Lines for the 2nd, 3rd, 4th, 5th and 6th+ kill of a chain. */
export const MULTI_KILL_LINES: readonly AnnouncerLine[] = [
  'doubleKill',
  'multiKill',
  'megaKill',
  'ultraKill',
  'monsterKill',
];

/** Spree length → line. */
export const SPREE_LINES: ReadonlyMap<number, AnnouncerLine> = new Map<number, AnnouncerLine>([
  [5, 'killingSpree'],
  [10, 'rampage'],
  [15, 'dominating'],
  [20, 'unstoppable'],
  [25, 'godlike'],
]);

/** Frags the leader still needs → line. */
export const FRAGS_LEFT_LINES: ReadonlyMap<number, AnnouncerLine> = new Map<number, AnnouncerLine>([
  [3, 'threeFragsLeft'],
  [2, 'twoFragsLeft'],
  [1, 'oneFragLeft'],
]);

/** Countdown seconds remaining → line. */
export const COUNTDOWN_LINES: ReadonlyMap<number, AnnouncerLine> = new Map<number, AnnouncerLine>([
  [3, 'countdown3'],
  [2, 'countdown2'],
  [1, 'countdown1'],
]);

/** Multi-kill line for a chain of `count` kills, or undefined below two. */
export function multiKillLine(count: number): AnnouncerLine | undefined {
  if (count < 2) return undefined;
  return MULTI_KILL_LINES[Math.min(count - 2, MULTI_KILL_LINES.length - 1)];
}

/** Spree line when a spree reaches exactly `spree` kills, else undefined. */
export function spreeLine(spree: number): AnnouncerLine | undefined {
  return SPREE_LINES.get(spree);
}

/** Tracks one player's multi-kill chain. */
export class MultiKillTracker {
  private lastKill: Seconds = -Infinity;
  private chain = 0;

  constructor(private readonly window: Seconds) {}

  /** Record a kill at `time`; returns the chain length including it. */
  kill(time: Seconds): number {
    this.chain = time - this.lastKill < this.window ? this.chain + 1 : 1;
    this.lastKill = time;
    return this.chain;
  }

  get length(): number {
    return this.chain;
  }
}
