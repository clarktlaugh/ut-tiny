/**
 * App-level match flow (docs/DESIGN.md §6, §8):
 *
 *   menu → setup (map / bots / limits) → loading → countdown → playing
 *        → ended (scoreboard, 10 s) → menu, or rematch → loading
 *
 * `countdown`, `playing` and `ended` follow the simulation: feed every
 * tick's events to `handleEvents` and the flow mirrors `matchPhase` (overtime
 * stays in `playing` with `overtime` set). The rest is driven by the app
 * calling `openSetup`, `start`, `loaded`, `rematch` and `toMenu`, and by
 * `update(dt)` for the end-screen timer.
 *
 * DOM-free and clock-free: callers pass elapsed seconds. Invalid transitions
 * are ignored and return false, so a double click cannot skip a state.
 * Input should only reach the sim while `inputEnabled` is true; send
 * `NULL_INPUT` otherwise (players hold still during the countdown and after
 * the end).
 */
import { DEATHMATCH_RULES } from '../sim/rules/config';
import { buildScoreboard, type Scoreboard } from '../sim/rules/scoreboard';
import type { MatchState, PlayerId, RulesConfig, Seconds, SimEvent } from '../sim/types';

export type FlowState = 'menu' | 'setup' | 'loading' | 'countdown' | 'playing' | 'ended';

/** Seconds the end-of-match scoreboard shows before returning to the menu (§6). */
export const END_SCREEN_SECONDS: Seconds = 10;

export interface MatchSetup {
  /** Map key, e.g. `'laundry-room'`. */
  map: string;
  bots: number;
  /** Bot skill 0–7 (§9). */
  botSkill: number;
  /** 0 disables. */
  fragLimit: number;
  /** Seconds; 0 disables. */
  timeLimit: Seconds;
}

export const DEFAULT_MATCH_SETUP: Readonly<MatchSetup> = Object.freeze({
  map: 'laundry-room',
  bots: 3,
  botSkill: 3,
  fragLimit: DEATHMATCH_RULES.fragLimit,
  timeLimit: DEATHMATCH_RULES.timeLimit,
});

/** Clamp a setup to sane values (whole numbers, non-negative, skill 0–7). */
export function sanitizeSetup(setup: Partial<MatchSetup>): MatchSetup {
  const int = (v: unknown, fallback: number, max = Infinity): number =>
    typeof v === 'number' && Number.isFinite(v)
      ? Math.min(max, Math.max(0, Math.round(v)))
      : fallback;
  return {
    map:
      typeof setup.map === 'string' && setup.map.length > 0 ? setup.map : DEFAULT_MATCH_SETUP.map,
    bots: int(setup.bots, DEFAULT_MATCH_SETUP.bots, 15),
    botSkill: int(setup.botSkill, DEFAULT_MATCH_SETUP.botSkill, 7),
    fragLimit: int(setup.fragLimit, DEFAULT_MATCH_SETUP.fragLimit),
    timeLimit: int(setup.timeLimit, DEFAULT_MATCH_SETUP.timeLimit),
  };
}

/** The `RulesConfig` for a setup: deathmatch defaults with its limits. */
export function rulesFor(
  setup: Readonly<MatchSetup>,
  base: Readonly<RulesConfig> = DEATHMATCH_RULES,
): RulesConfig {
  return { ...base, fragLimit: setup.fragLimit, timeLimit: setup.timeLimit };
}

export interface MatchResult {
  winner: PlayerId | null;
  scoreboard: Scoreboard;
}

export type FlowListener = (state: FlowState, previous: FlowState) => void;

export class MatchFlow {
  private current: FlowState = 'menu';
  private currentSetup: MatchSetup = { ...DEFAULT_MATCH_SETUP };
  private endTimer: Seconds = 0;
  private isOvertime = false;
  private lastResult: MatchResult | null = null;
  private readonly listeners = new Set<FlowListener>();

  get state(): FlowState {
    return this.current;
  }

  get setup(): Readonly<MatchSetup> {
    return this.currentSetup;
  }

  /** True while the sim is in overtime (the flow state stays `playing`). */
  get overtime(): boolean {
    return this.isOvertime;
  }

  /** Only `playing` lets controller input through. */
  get inputEnabled(): boolean {
    return this.current === 'playing';
  }

  /** Seconds left on the end screen, else 0. */
  get endScreenRemaining(): Seconds {
    return this.current === 'ended' ? this.endTimer : 0;
  }

  /** Result of the last finished match. */
  get result(): MatchResult | null {
    return this.lastResult;
  }

  onChange(listener: FlowListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** menu → setup. */
  openSetup(): boolean {
    return this.current === 'menu' && this.go('setup');
  }

  /** setup → loading with the chosen setup (also allowed from the menu for quick play). */
  start(setup: Partial<MatchSetup> = this.currentSetup): boolean {
    if (this.current !== 'setup' && this.current !== 'menu') return false;
    this.currentSetup = sanitizeSetup({ ...this.currentSetup, ...setup });
    return this.go('loading');
  }

  /** loading → countdown once the map and world are ready. */
  loaded(): boolean {
    return this.current === 'loading' && this.go('countdown');
  }

  /** Mirror the sim's `matchPhase` events. Pass `match` to capture the result on `ended`. */
  handleEvents(events: readonly SimEvent[], match?: Readonly<MatchState>): void {
    for (const ev of events) {
      if (ev.type !== 'matchPhase') continue;
      if (this.current !== 'countdown' && this.current !== 'playing') continue;
      switch (ev.phase) {
        case 'countdown':
          this.go('countdown');
          break;
        case 'playing':
          this.isOvertime = false;
          this.go('playing');
          break;
        case 'overtime':
          this.isOvertime = true;
          this.go('playing');
          break;
        case 'ended':
          this.endTimer = END_SCREEN_SECONDS;
          this.lastResult = match
            ? { winner: match.winner, scoreboard: buildScoreboard(match) }
            : null;
          this.go('ended');
          break;
        case 'warmup':
          break;
      }
    }
  }

  /** Advance the end-screen timer; returns to the menu when it runs out. */
  update(dt: Seconds): void {
    if (this.current !== 'ended') return;
    this.endTimer = Math.max(0, this.endTimer - dt);
    if (this.endTimer === 0) this.go('menu');
  }

  /** ended → loading with the same setup. */
  rematch(): boolean {
    return this.current === 'ended' && this.go('loading');
  }

  /** Back to the menu from anywhere (Esc, quit, end screen). */
  toMenu(): boolean {
    return this.go('menu');
  }

  private go(next: FlowState): boolean {
    const previous = this.current;
    if (next === previous) return false;
    this.current = next;
    // Keep the overtime flag on the end screen so it can say "won in overtime".
    if (next !== 'playing' && next !== 'ended') this.isOvertime = false;
    if (next !== 'ended') this.endTimer = 0;
    for (const l of this.listeners) l(next, previous);
    return true;
  }
}
