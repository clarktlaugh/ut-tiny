/**
 * Player settings and their localStorage persistence (docs/DESIGN.md §11).
 *
 * Everything the settings screen edits lives here: look and input, view,
 * audio, quality and match defaults, plus the key bindings. Stored data is
 * untrusted (older builds, hand edits, other tabs), so loading always
 * sanitises: out-of-range numbers are clamped, wrong types fall back to the
 * defaults, unknown keys are dropped.
 */
import { sanitizeBindings, cloneBindings, defaultBindings } from '../controllers/player/bindings';
import type { Bindings } from '../controllers/player/bindings';

export const SETTINGS_STORAGE_KEY = 'ut-tiny.settings.v1';

export const QUALITY_PRESETS = ['low', 'medium', 'high'] as const;
export type QualityPreset = (typeof QUALITY_PRESETS)[number];

export interface VolumeSettings {
  /** All volumes are linear gain, 0..1. */
  master: number;
  sfx: number;
  music: number;
  announcer: number;
}

export interface Settings {
  /** Mouse sensitivity multiplier (1 = default speed). */
  sensitivity: number;
  /** Horizontal field of view in degrees, 80–110. */
  fov: number;
  invertY: boolean;
  /** Dodge by double-tapping a movement key (dedicated dodge binds always work). */
  doubleTapDodge: boolean;
  autoSwitchOnPickup: boolean;
  volume: VolumeSettings;
  quality: QualityPreset;
  /** Render resolution multiplier. */
  renderScale: number;
  botCount: number;
  /** Bot skill 0–7 (Novice..Godlike, §9). */
  botSkill: number;
  /** Frags to win; 0 disables. */
  fragLimit: number;
  /** Minutes; 0 disables. */
  timeLimitMinutes: number;
  bindings: Bindings;
}

interface NumberRange {
  min: number;
  max: number;
  integer?: boolean;
}

export const SETTING_RANGES = {
  sensitivity: { min: 0.05, max: 10 },
  fov: { min: 80, max: 110 },
  volume: { min: 0, max: 1 },
  renderScale: { min: 0.25, max: 2 },
  botCount: { min: 0, max: 15, integer: true },
  botSkill: { min: 0, max: 7, integer: true },
  fragLimit: { min: 0, max: 999, integer: true },
  timeLimitMinutes: { min: 0, max: 120, integer: true },
} as const satisfies Record<string, NumberRange>;

export function defaultSettings(): Settings {
  return {
    sensitivity: 1,
    fov: 100,
    invertY: false,
    doubleTapDodge: true,
    autoSwitchOnPickup: true,
    volume: { master: 0.8, sfx: 1, music: 0.5, announcer: 1 },
    quality: 'medium',
    renderScale: 1,
    botCount: 3,
    botSkill: 3,
    fragLimit: 25,
    timeLimitMinutes: 10,
    bindings: defaultBindings(),
  };
}

export function cloneSettings(settings: Readonly<Settings>): Settings {
  return {
    ...settings,
    volume: { ...settings.volume },
    bindings: cloneBindings(settings.bindings),
  };
}

function num(value: unknown, fallback: number, range: NumberRange): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const v = range.integer ? Math.round(value) : value;
  return Math.min(range.max, Math.max(range.min, v));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Coerce untrusted data into complete, in-range `Settings`. */
export function sanitizeSettings(value: unknown): Settings {
  const d = defaultSettings();
  const v = record(value);
  const vol = record(v.volume);
  const r = SETTING_RANGES;
  return {
    sensitivity: num(v.sensitivity, d.sensitivity, r.sensitivity),
    fov: num(v.fov, d.fov, r.fov),
    invertY: bool(v.invertY, d.invertY),
    doubleTapDodge: bool(v.doubleTapDodge, d.doubleTapDodge),
    autoSwitchOnPickup: bool(v.autoSwitchOnPickup, d.autoSwitchOnPickup),
    volume: {
      master: num(vol.master, d.volume.master, r.volume),
      sfx: num(vol.sfx, d.volume.sfx, r.volume),
      music: num(vol.music, d.volume.music, r.volume),
      announcer: num(vol.announcer, d.volume.announcer, r.volume),
    },
    quality: (QUALITY_PRESETS as readonly unknown[]).includes(v.quality)
      ? (v.quality as QualityPreset)
      : d.quality,
    renderScale: num(v.renderScale, d.renderScale, r.renderScale),
    botCount: num(v.botCount, d.botCount, r.botCount),
    botSkill: num(v.botSkill, d.botSkill, r.botSkill),
    fragLimit: num(v.fragLimit, d.fragLimit, r.fragLimit),
    timeLimitMinutes: num(v.timeLimitMinutes, d.timeLimitMinutes, r.timeLimitMinutes),
    bindings: v.bindings === undefined ? d.bindings : sanitizeBindings(v.bindings),
  };
}

/** The subset of `Storage` the store uses, so tests and private-mode fallbacks can supply their own. */
export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** In-memory storage, used when localStorage is missing or throws (private mode, sandboxed iframes). */
export class MemoryStorage implements StorageLike {
  private readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, String(value));
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

/** `globalThis.localStorage` if it exists and is usable, else a `MemoryStorage`. */
export function browserStorage(): StorageLike {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    if (storage) {
      const probe = `${SETTINGS_STORAGE_KEY}.probe`;
      storage.setItem(probe, '1');
      storage.removeItem(probe);
      return storage;
    }
  } catch {
    // Access denied or quota exhausted: fall through to memory.
  }
  return new MemoryStorage();
}

/** Read settings; anything missing or unreadable falls back to defaults. */
export function loadSettings(storage: StorageLike = browserStorage()): Settings {
  let raw: string | null;
  try {
    raw = storage.getItem(SETTINGS_STORAGE_KEY);
  } catch {
    return defaultSettings();
  }
  if (raw === null) return defaultSettings();
  try {
    return sanitizeSettings(JSON.parse(raw));
  } catch {
    return defaultSettings();
  }
}

/** Write settings. Returns false if storage refused (quota, access denied). */
export function saveSettings(
  settings: Readonly<Settings>,
  storage: StorageLike = browserStorage(),
): boolean {
  try {
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(sanitizeSettings(settings)));
    return true;
  } catch {
    return false;
  }
}

/** A partial update; `volume` may itself be partial. */
export type SettingsPatch = Partial<Omit<Settings, 'volume'>> & {
  volume?: Partial<VolumeSettings>;
};

export type SettingsListener = (settings: Readonly<Settings>) => void;

/**
 * Live settings shared by the app, controllers, renderer and audio. Every
 * change is sanitised, persisted and broadcast.
 */
export class SettingsStore {
  private current: Settings;
  private readonly listeners = new Set<SettingsListener>();

  constructor(private readonly storage: StorageLike = browserStorage()) {
    this.current = loadSettings(storage);
  }

  get(): Readonly<Settings> {
    return this.current;
  }

  update(patch: SettingsPatch): Readonly<Settings> {
    const next = sanitizeSettings({
      ...this.current,
      ...patch,
      volume: { ...this.current.volume, ...patch.volume },
    });
    return this.commit(next);
  }

  setBindings(bindings: Readonly<Bindings>): Readonly<Settings> {
    return this.update({ bindings: cloneBindings(bindings) });
  }

  reset(): Readonly<Settings> {
    return this.commit(defaultSettings());
  }

  subscribe(listener: SettingsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private commit(next: Settings): Readonly<Settings> {
    this.current = next;
    saveSettings(next, this.storage);
    for (const listener of [...this.listeners]) listener(next);
    return next;
  }
}
