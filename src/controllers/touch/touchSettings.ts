/**
 * Touch-only settings (docs/DESIGN.md §11: touch look has its own
 * sensitivity) and their localStorage persistence. Stored data is untrusted,
 * so loading sanitises like `src/app/settings.ts` does.
 */

export const TOUCH_SETTINGS_STORAGE_KEY = 'ut-tiny.touch.v1';

export interface TouchSettings {
  /** Look-drag multiplier (1 = default speed). */
  lookSensitivity: number;
  /** Dragging down looks up. */
  invertY: boolean;
}

export const TOUCH_SENSITIVITY_RANGE = { min: 0.1, max: 5 } as const;

export const DEFAULT_TOUCH_SETTINGS: Readonly<TouchSettings> = Object.freeze({
  lookSensitivity: 1,
  invertY: false,
});

export function sanitizeTouchSettings(value: unknown): TouchSettings {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const d = DEFAULT_TOUCH_SETTINGS;
  const s = v.lookSensitivity;
  const { min, max } = TOUCH_SENSITIVITY_RANGE;
  return {
    lookSensitivity:
      typeof s === 'number' && Number.isFinite(s)
        ? Math.min(max, Math.max(min, s))
        : d.lookSensitivity,
    invertY: typeof v.invertY === 'boolean' ? v.invertY : d.invertY,
  };
}

/** The parts of `Storage` used here. */
export interface TouchSettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): TouchSettingsStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadTouchSettings(storage = defaultStorage()): TouchSettings {
  try {
    const raw = storage?.getItem(TOUCH_SETTINGS_STORAGE_KEY);
    return sanitizeTouchSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return sanitizeTouchSettings(null);
  }
}

export function saveTouchSettings(settings: TouchSettings, storage = defaultStorage()): void {
  try {
    storage?.setItem(TOUCH_SETTINGS_STORAGE_KEY, JSON.stringify(sanitizeTouchSettings(settings)));
  } catch {
    // Private mode or quota: settings just do not persist.
  }
}
