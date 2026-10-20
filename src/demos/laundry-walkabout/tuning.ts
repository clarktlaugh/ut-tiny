/**
 * Touch-friendly movement tuning for the walkabout (P31; docs/DESIGN.md §4,
 * §18.8). The pure part (defaults, overrides, persistence, the Copy-feedback
 * summary) is DOM-free and tested; `mountTuningSheet` builds the panel: one
 * row per `MOVEMENT_TUNABLES` entry with a wide slider and −/+ steppers, and
 * presets. Edits apply in place to the `MovementConfig` the world runs on, so
 * every change is felt on the next tick.
 */
import { parseTuning } from '../../app/devTuning';
import {
  DEFAULT_MOVEMENT,
  MOVEMENT_TUNABLES,
  type MovementConfig,
  type MovementKey,
  type MovementTunable,
} from '../../sim/movement';
import { createSheet, el, type Sheet } from './sheet';

/** localStorage key for the demo's own overrides (kept apart from the dev panel's). */
export const TUNING_STORAGE_KEY = 'ut-tiny.laundry-walkabout.movement.v1';

/**
 * The demo's defaults are §4 as written: `routes.test.ts` proves every §7.1
 * route survives them, so nothing is overridden out of the box.
 */
export const WALKABOUT_DEFAULTS: Readonly<MovementConfig> = DEFAULT_MOVEMENT;

export interface TuningPreset {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  /** Applied over the defaults. */
  readonly values: Readonly<Partial<MovementConfig>>;
}

export const PRESETS: readonly TuningPreset[] = [
  {
    id: 'spec',
    label: '§4 defaults',
    hint: 'The design numbers. Every route in the Go-to panel works with these.',
    values: {},
  },
  {
    id: 'soft',
    label: 'Soft landings',
    hint: 'Fall damage from 30 m/s, lethal at 45: a machine-top drop hurts but does not kill.',
    values: { fallDamageMinSpeed: 30, fallDamageLethalSpeed: 45 },
  },
  {
    id: 'snappy',
    label: 'Snappy',
    hint: 'Quicker acceleration, a faster dodge and more air control.',
    values: { groundAccelTime: 0.08, dodgeSpeed: 14, airControl: 0.5 },
  },
];

/** Values that differ from the demo defaults. */
export function overrides(config: Readonly<MovementConfig>): Partial<MovementConfig> {
  const out: Partial<MovementConfig> = {};
  for (const t of MOVEMENT_TUNABLES) {
    if (config[t.key] !== WALKABOUT_DEFAULTS[t.key]) out[t.key] = config[t.key];
  }
  return out;
}

/** Set the given values (others untouched). Returns the keys that changed. */
export function applyTuning(
  config: MovementConfig,
  values: Readonly<Partial<MovementConfig>>,
): MovementKey[] {
  const changed: MovementKey[] = [];
  for (const t of MOVEMENT_TUNABLES) {
    const v = values[t.key];
    if (v !== undefined && Number.isFinite(v) && config[t.key] !== v) {
      config[t.key] = v;
      changed.push(t.key);
    }
  }
  return changed;
}

/** Defaults, then `preset.values`. Returns the keys that changed. */
export function applyPreset(config: MovementConfig, preset: TuningPreset): MovementKey[] {
  const target: Partial<MovementConfig> = { ...WALKABOUT_DEFAULTS, ...preset.values };
  return applyTuning(config, target);
}

/** Clamp `value` to the tunable's range and snap it to its step. */
export function snapValue(t: MovementTunable, value: number): number {
  if (!Number.isFinite(value)) return t.min;
  const clamped = Math.min(t.max, Math.max(t.min, value));
  const steps = Math.round((clamped - t.min) / t.step);
  return Number((t.min + steps * t.step).toFixed(decimalsOf(t.step)));
}

function decimalsOf(step: number): number {
  const s = String(step);
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

/** A value as the panel shows it, with the tunable's precision. */
export function formatValue(t: MovementTunable, value: number): string {
  return value.toFixed(decimalsOf(t.step));
}

function storageOrNull(storage: Storage | null | undefined): Storage | null {
  if (storage !== undefined) return storage;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Apply saved overrides to `config`. Returns the keys that changed. */
export function loadTuning(config: MovementConfig, storage?: Storage | null): MovementKey[] {
  const store = storageOrNull(storage);
  if (!store) return [];
  let json: string | null;
  try {
    json = store.getItem(TUNING_STORAGE_KEY);
  } catch {
    return [];
  }
  return applyTuning(config, parseTuning(json));
}

/** Save the overrides; clears the entry when the config is back at the defaults. */
export function saveTuning(config: Readonly<MovementConfig>, storage?: Storage | null): void {
  const store = storageOrNull(storage);
  if (!store) return;
  const diff = overrides(config);
  try {
    if (Object.keys(diff).length === 0) store.removeItem(TUNING_STORAGE_KEY);
    else store.setItem(TUNING_STORAGE_KEY, JSON.stringify(diff));
  } catch {
    // Storage full or disabled: the tuning still works for this session.
  }
}

/**
 * The movement section of Copy feedback: which preset or how many values
 * changed, then every changed value with its unit.
 */
export function tuningFeedback(config: Readonly<MovementConfig>): Record<string, unknown> {
  const diff = overrides(config);
  const keys = Object.keys(diff) as MovementKey[];
  const preset = PRESETS.find((p) => samePreset(diff, p));
  const out: Record<string, unknown> = {
    movement: preset
      ? preset.label
      : `custom (${keys.length} value${keys.length === 1 ? '' : 's'} changed)`,
  };
  for (const t of MOVEMENT_TUNABLES) {
    const v = diff[t.key];
    if (v !== undefined)
      out[`${t.key} (${t.unit})`] =
        `${formatValue(t, v)} (§4 ${formatValue(t, WALKABOUT_DEFAULTS[t.key])})`;
  }
  return out;
}

function samePreset(diff: Readonly<Partial<MovementConfig>>, preset: TuningPreset): boolean {
  const a = Object.keys(diff) as MovementKey[];
  const b = Object.keys(preset.values) as MovementKey[];
  if (a.length !== b.length) return false;
  return a.every((k) => diff[k] === preset.values[k]);
}

export interface TuningSheetOptions {
  root: HTMLElement;
  config: MovementConfig;
  /** `null` disables persistence; defaults to localStorage. */
  storage?: Storage | null;
  onChange?: (keys: readonly MovementKey[]) => void;
}

export interface TuningSheet {
  readonly sheet: Sheet;
  /** Re-read `config` into the controls. */
  refresh(): void;
  dispose(): void;
}

/** Build the tuning panel (closed) inside `root`. */
export function mountTuningSheet(options: TuningSheetOptions): TuningSheet {
  const { config } = options;
  const storage = storageOrNull(options.storage);
  const sheet = createSheet({ root: options.root, title: 'Movement tuning' });
  sheet.element.classList.add('lw-tuning');

  const summary = el('p', 'lw-summary');
  const presets = el('div', 'lw-presets');
  for (const preset of PRESETS) {
    const b = el('button', 'lw-preset', preset.label);
    b.type = 'button';
    b.title = preset.hint;
    b.dataset.preset = preset.id;
    b.addEventListener('click', () => {
      const changed = applyPreset(config, preset);
      commit(changed);
    });
    presets.append(b);
  }
  const presetHint = el(
    'p',
    'lw-preset-hint',
    PRESETS.map((p) => `${p.label}: ${p.hint}`).join(' '),
  );
  sheet.body.append(summary, presets, presetHint);

  const rows = new Map<MovementKey, { range: HTMLInputElement; value: HTMLSpanElement }>();
  const list = el('div', 'lw-rows');
  for (const t of MOVEMENT_TUNABLES) {
    const row = el('div', 'lw-row');
    row.dataset.key = t.key;
    const head = el('div', 'lw-row-head');
    const label = el('span', 'lw-row-label', t.label);
    label.title = t.key;
    const value = el('span', 'lw-row-value');
    head.append(label, value);
    const controls = el('div', 'lw-row-controls');
    const minus = el('button', 'lw-step', '−');
    minus.type = 'button';
    minus.setAttribute('aria-label', `${t.label} down`);
    const range = el('input', 'lw-range');
    range.type = 'range';
    range.min = String(t.min);
    range.max = String(t.max);
    range.step = String(t.step);
    range.name = t.key;
    range.setAttribute('aria-label', t.label);
    const plus = el('button', 'lw-step', '+');
    plus.type = 'button';
    plus.setAttribute('aria-label', `${t.label} up`);
    controls.append(minus, range, plus);
    row.append(head, controls);
    list.append(row);
    rows.set(t.key, { range, value });

    const set = (raw: number): void => {
      const v = snapValue(t, raw);
      if (config[t.key] === v) {
        refreshRow(t);
        return;
      }
      config[t.key] = v;
      commit([t.key]);
    };
    range.addEventListener('input', () => set(Number(range.value)));
    minus.addEventListener('click', () => set(config[t.key] - t.step));
    plus.addEventListener('click', () => set(config[t.key] + t.step));
  }
  sheet.body.append(list);

  function refreshRow(t: MovementTunable): void {
    const row = rows.get(t.key);
    if (!row) return;
    const v = config[t.key];
    row.range.value = String(v);
    row.value.textContent = `${formatValue(t, v)} ${t.unit}`;
    const changed = v !== WALKABOUT_DEFAULTS[t.key];
    row.value.classList.toggle('lw-changed', changed);
    row.value.title = changed ? `§4: ${formatValue(t, WALKABOUT_DEFAULTS[t.key])} ${t.unit}` : '';
  }
  function refresh(): void {
    for (const t of MOVEMENT_TUNABLES) refreshRow(t);
    const diff = overrides(config);
    const n = Object.keys(diff).length;
    const preset = PRESETS.find((p) => samePreset(diff, p));
    summary.textContent = preset
      ? `Preset: ${preset.label}.`
      : `${n} value${n === 1 ? '' : 's'} changed from §4.`;
    summary.append(' Changes apply at once and go into Copy feedback.');
    for (const b of presets.querySelectorAll<HTMLButtonElement>('.lw-preset')) {
      b.classList.toggle('lw-on', preset?.id === b.dataset.preset);
    }
  }
  function commit(changed: readonly MovementKey[]): void {
    refresh();
    if (changed.length === 0) return;
    saveTuning(config, storage);
    options.onChange?.(changed);
  }

  refresh();
  return {
    sheet,
    refresh,
    dispose: () => sheet.dispose(),
  };
}
