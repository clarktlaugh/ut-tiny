/**
 * Live movement tuning panel behind a dev flag (docs/DESIGN.md §4, P7).
 *
 * The panel edits a `MovementConfig` in place, so a `CharacterMover` built on
 * that object picks up every slider change on its next tick. Nothing here is
 * imported by the simulation; the app mounts it when `isDevTuningEnabled()`:
 *
 *   const config = createMovementConfig();
 *   if (isDevTuningEnabled()) {
 *     loadTuning(config);                // restore the last session's values
 *     mountDevTuning(config);            // sliders in the top-right corner
 *   }
 *
 * Enabled in Vite dev builds, and in any build with `?tuning=1` in the URL
 * (`?tuning=0` turns it off). Values persist in localStorage.
 */
import {
  DEFAULT_MOVEMENT,
  MOVEMENT_TUNABLES,
  type MovementConfig,
  type MovementKey,
  type MovementTunable,
} from '../sim/movement/config';

/** URL query parameter that forces the panel on (`1`) or off (`0`). */
export const DEV_TUNING_PARAM = 'tuning';
/** localStorage key holding the saved overrides as JSON. */
export const DEV_TUNING_STORAGE_KEY = 'ut-tiny.devTuning.movement';

const STYLE_ID = 'ut-tiny-dev-tuning-style';
const CLASS = 'ut-dev-tuning';

/**
 * Whether the panel should be shown: `?tuning=1` forces it on, `?tuning=0`
 * off, otherwise it follows the Vite dev flag.
 */
export function isDevTuningEnabled(
  search: string = typeof location === 'undefined' ? '' : location.search,
  dev: boolean = import.meta.env.DEV,
): boolean {
  const params = new URLSearchParams(search);
  const flag = params.get(DEV_TUNING_PARAM);
  if (flag !== null) return flag !== '0' && flag !== 'false';
  return dev;
}

/** Finite numeric overrides for known tunables found in `json`; anything else is dropped. */
export function parseTuning(json: string | null | undefined): Partial<MovementConfig> {
  if (!json) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object') return {};
  const out: Partial<MovementConfig> = {};
  for (const t of MOVEMENT_TUNABLES) {
    const v = (raw as Record<string, unknown>)[t.key];
    if (typeof v === 'number' && Number.isFinite(v)) out[t.key] = v;
  }
  return out;
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
    json = store.getItem(DEV_TUNING_STORAGE_KEY);
  } catch {
    return [];
  }
  const saved = parseTuning(json);
  const changed: MovementKey[] = [];
  for (const key of Object.keys(saved) as MovementKey[]) {
    const v = saved[key];
    if (v !== undefined && config[key] !== v) {
      config[key] = v;
      changed.push(key);
    }
  }
  return changed;
}

/** Save the values that differ from the defaults; clears the entry when none do. */
export function saveTuning(config: Readonly<MovementConfig>, storage?: Storage | null): void {
  const store = storageOrNull(storage);
  if (!store) return;
  const diff: Partial<MovementConfig> = {};
  for (const t of MOVEMENT_TUNABLES) {
    if (config[t.key] !== DEFAULT_MOVEMENT[t.key]) diff[t.key] = config[t.key];
  }
  try {
    if (Object.keys(diff).length === 0) store.removeItem(DEV_TUNING_STORAGE_KEY);
    else store.setItem(DEV_TUNING_STORAGE_KEY, JSON.stringify(diff));
  } catch {
    // Storage may be full or disabled; tuning still works for this session.
  }
}

/** Restore every tunable to its §4 default. Returns the keys that changed. */
export function resetTuning(config: MovementConfig): MovementKey[] {
  const changed: MovementKey[] = [];
  for (const t of MOVEMENT_TUNABLES) {
    if (config[t.key] !== DEFAULT_MOVEMENT[t.key]) {
      config[t.key] = DEFAULT_MOVEMENT[t.key];
      changed.push(t.key);
    }
  }
  return changed;
}

export interface DevTuningOptions {
  /** Element to append the panel to. Defaults to `document.body`. */
  container?: HTMLElement;
  /** Storage for persistence; `null` disables it. Defaults to `localStorage`. */
  storage?: Storage | null;
  /** Called after any value changes (slider, reset, or restore). */
  onChange?: (key: MovementKey, value: number, config: Readonly<MovementConfig>) => void;
  /** Panel heading. */
  title?: string;
  /** Start expanded. Default true. */
  open?: boolean;
}

export interface DevTuningPanel {
  readonly element: HTMLElement;
  /** Re-read `config` into the controls (after the game changed it). */
  refresh(): void;
  /** Restore defaults. */
  reset(): void;
  /** Remove the panel from the DOM. */
  dispose(): void;
}

/** Build the panel, attach it, and bind it to `config`. */
export function mountDevTuning(
  config: MovementConfig,
  options: DevTuningOptions = {},
): DevTuningPanel {
  if (typeof document === 'undefined') throw new Error('mountDevTuning needs a DOM');
  const storage = storageOrNull(options.storage);
  const container = options.container ?? document.body;
  ensureStyle();

  const root = document.createElement('details');
  root.className = CLASS;
  root.open = options.open ?? true;
  const summary = document.createElement('summary');
  summary.textContent = options.title ?? 'Movement tuning';
  root.append(summary);

  const rows = new Map<MovementKey, { range: HTMLInputElement; number: HTMLInputElement }>();
  const emit = (key: MovementKey) => {
    saveTuning(config, storage);
    options.onChange?.(key, config[key], config);
  };

  const grid = document.createElement('div');
  grid.className = `${CLASS}-grid`;
  for (const t of MOVEMENT_TUNABLES) {
    const label = document.createElement('label');
    label.textContent = t.label;
    label.title = t.key;
    const range = makeInput('range', t);
    const number = makeInput('number', t);
    const unit = document.createElement('span');
    unit.textContent = t.unit;
    const set = (raw: string) => {
      const v = Number(raw);
      if (!Number.isFinite(v)) return;
      config[t.key] = v;
      range.value = String(v);
      number.value = String(v);
      emit(t.key);
    };
    range.addEventListener('input', () => set(range.value));
    number.addEventListener('change', () => set(number.value));
    grid.append(label, range, number, unit);
    rows.set(t.key, { range, number });
  }
  root.append(grid);

  const actions = document.createElement('div');
  actions.className = `${CLASS}-actions`;
  const resetButton = document.createElement('button');
  resetButton.type = 'button';
  resetButton.textContent = 'Reset to §4 defaults';
  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.textContent = 'Copy JSON';
  copyButton.addEventListener('click', () => {
    const diff: Partial<MovementConfig> = {};
    for (const t of MOVEMENT_TUNABLES) {
      if (config[t.key] !== DEFAULT_MOVEMENT[t.key]) diff[t.key] = config[t.key];
    }
    void navigator.clipboard?.writeText(JSON.stringify(diff, null, 2));
  });
  actions.append(resetButton, copyButton);
  root.append(actions);

  // Keys typed into the panel must not reach the game's input handlers.
  const swallow = (e: Event) => e.stopPropagation();
  root.addEventListener('keydown', swallow);
  root.addEventListener('keyup', swallow);

  const refresh = () => {
    for (const [key, row] of rows) {
      row.range.value = String(config[key]);
      row.number.value = String(config[key]);
    }
  };
  const reset = () => {
    const changed = resetTuning(config);
    refresh();
    saveTuning(config, storage);
    for (const key of changed) options.onChange?.(key, config[key], config);
  };
  resetButton.addEventListener('click', reset);

  refresh();
  container.append(root);
  return {
    element: root,
    refresh,
    reset,
    dispose: () => {
      root.remove();
    },
  };
}

function makeInput(type: 'range' | 'number', t: MovementTunable): HTMLInputElement {
  const input = document.createElement('input');
  input.type = type;
  input.min = String(t.min);
  input.max = String(t.max);
  input.step = String(t.step);
  input.name = t.key;
  return input;
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.${CLASS} {
  position: fixed; top: 8px; right: 8px; z-index: 1000; max-height: calc(100vh - 16px);
  overflow: auto; padding: 6px 10px; border-radius: 6px;
  background: rgba(10, 12, 16, 0.85); color: #d8dde6;
  font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
}
.${CLASS} summary { cursor: pointer; font-weight: 600; user-select: none; }
.${CLASS}-grid {
  display: grid; grid-template-columns: auto 120px 64px auto; gap: 2px 8px;
  align-items: center; margin-top: 6px;
}
.${CLASS}-grid label { white-space: nowrap; }
.${CLASS}-grid input[type="number"] {
  width: 64px; background: #1b1f26; color: inherit; border: 1px solid #333a45; border-radius: 3px;
  font: inherit; padding: 1px 4px;
}
.${CLASS}-actions { display: flex; gap: 6px; margin-top: 8px; }
.${CLASS}-actions button {
  background: #2a3140; color: inherit; border: 1px solid #3c4557; border-radius: 3px;
  font: inherit; padding: 2px 8px; cursor: pointer;
}
.${CLASS}-actions button:hover { background: #364055; }
`;
  document.head.append(style);
}
