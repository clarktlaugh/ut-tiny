/**
 * Pure menu data (docs/DESIGN.md §11): labels, option lists and the mapping
 * between persisted `Settings` and the match setup form. No DOM here.
 */
import { SKILL_NAMES } from '../../controllers/bot/skill';
import { sanitizeSetup, type MatchSetup } from '../matchFlow';
import type { Settings } from '../settings';
import type { ScoreboardRow } from '../../sim/rules/scoreboard';

export interface MapOption {
  key: string;
  name: string;
}

export const DEFAULT_MAPS: readonly MapOption[] = [{ key: 'laundry-room', name: 'Laundry Room' }];

export function skillName(level: number): string {
  return SKILL_NAMES[Math.min(SKILL_NAMES.length - 1, Math.max(0, Math.round(level)))] ?? 'Novice';
}

/** The setup form's starting values: the player's saved match defaults. */
export function setupFromSettings(settings: Readonly<Settings>, map: string): MatchSetup {
  return sanitizeSetup({
    map,
    bots: settings.botCount,
    botSkill: settings.botSkill,
    fragLimit: settings.fragLimit,
    timeLimit: settings.timeLimitMinutes * 60,
  });
}

/** Settings fields to save when a match starts, so the next setup remembers it. */
export function settingsFromSetup(setup: Readonly<MatchSetup>) {
  return {
    botCount: setup.bots,
    botSkill: setup.botSkill,
    fragLimit: setup.fragLimit,
    timeLimitMinutes: Math.round(setup.timeLimit / 60),
  };
}

export function limitLabel(value: number, unit: string): string {
  return value > 0 ? `${value} ${unit}` : 'Off';
}

export function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

export function scoreRowCells(row: Readonly<ScoreboardRow>): string[] {
  return [
    String(row.rank),
    row.isBot ? `${row.name} (bot)` : row.name,
    String(row.frags),
    String(row.kills),
    String(row.deaths),
    percent(row.efficiency),
    row.ping === null ? '–' : `${row.ping} ms`,
  ];
}

export const SCORE_HEADERS = ['#', 'Player', 'Frags', 'Kills', 'Deaths', 'Eff.', 'Ping'] as const;
