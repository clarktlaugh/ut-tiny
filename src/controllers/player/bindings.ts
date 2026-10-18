/**
 * Key bindings for the local player (docs/DESIGN.md §11).
 *
 * A binding maps an action to the input codes that trigger it. Codes are
 * `KeyboardEvent.code` values (`'KeyW'`, `'Space'`, ...) plus the pseudo-codes
 * below for mouse buttons and the wheel, so one table covers every device and
 * serialises cleanly to localStorage.
 */

/** Mouse button `n` (`MouseEvent.button`): 0 left, 1 middle, 2 right, 3/4 side buttons. */
export function mouseButtonCode(button: number): string {
  return `Mouse${button}`;
}

export const WHEEL_UP = 'WheelUp';
export const WHEEL_DOWN = 'WheelDown';

export const ACTIONS = [
  'moveForward',
  'moveBack',
  'moveLeft',
  'moveRight',
  'jump',
  'crouch',
  'fire',
  'altFire',
  'use',
  'camView',
  'dodgeForward',
  'dodgeBack',
  'dodgeLeft',
  'dodgeRight',
  'nextWeapon',
  'prevWeapon',
  'lastWeapon',
  'weapon1',
  'weapon2',
  'weapon3',
  'weapon4',
  'weapon5',
  'weapon6',
  'weapon7',
  'weapon8',
] as const;

export type Action = (typeof ACTIONS)[number];

/** Action → input codes. An empty list means unbound. */
export type Bindings = Record<Action, string[]>;

/**
 * UT-style defaults: WASD, Space jump, Ctrl crouch, LMB/RMB fire, 1–8 slots,
 * wheel cycles, Q last weapon. Dedicated dodge keys and the disc-cam toggle
 * start unbound (double-tap and hold-primary are the primary paths, §5.1, §11).
 */
export const DEFAULT_BINDINGS: Readonly<Bindings> = Object.freeze({
  moveForward: ['KeyW', 'ArrowUp'],
  moveBack: ['KeyS', 'ArrowDown'],
  moveLeft: ['KeyA', 'ArrowLeft'],
  moveRight: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  crouch: ['ControlLeft', 'KeyC'],
  fire: [mouseButtonCode(0)],
  altFire: [mouseButtonCode(2)],
  use: ['KeyE'],
  camView: [],
  dodgeForward: [],
  dodgeBack: [],
  dodgeLeft: [],
  dodgeRight: [],
  nextWeapon: [WHEEL_UP],
  prevWeapon: [WHEEL_DOWN],
  lastWeapon: ['KeyQ'],
  weapon1: ['Digit1'],
  weapon2: ['Digit2'],
  weapon3: ['Digit3'],
  weapon4: ['Digit4'],
  weapon5: ['Digit5'],
  weapon6: ['Digit6'],
  weapon7: ['Digit7'],
  weapon8: ['Digit8'],
});

export function isAction(value: unknown): value is Action {
  return typeof value === 'string' && (ACTIONS as readonly string[]).includes(value);
}

/** A deep copy of the defaults that callers may mutate. */
export function defaultBindings(): Bindings {
  return cloneBindings(DEFAULT_BINDINGS);
}

export function cloneBindings(bindings: Readonly<Bindings>): Bindings {
  const out = {} as Bindings;
  for (const action of ACTIONS) out[action] = [...bindings[action]];
  return out;
}

/**
 * Coerce untrusted data (e.g. parsed localStorage) into a complete `Bindings`.
 * Unknown actions and non-string codes are dropped; missing actions get their
 * defaults, so a stored table from an older build gains new actions.
 */
export function sanitizeBindings(value: unknown): Bindings {
  const out = defaultBindings();
  if (typeof value !== 'object' || value === null) return out;
  for (const [action, codes] of Object.entries(value)) {
    if (!isAction(action) || !Array.isArray(codes)) continue;
    out[action] = [...new Set(codes.filter((c): c is string => typeof c === 'string' && c !== ''))];
  }
  return out;
}

/** Reverse lookup: input code → actions it triggers. */
export function codeToActions(bindings: Readonly<Bindings>): Map<string, Action[]> {
  const map = new Map<string, Action[]>();
  for (const action of ACTIONS) {
    for (const code of bindings[action]) {
      const list = map.get(code);
      if (list) list.push(action);
      else map.set(code, [action]);
    }
  }
  return map;
}

/**
 * Bind `code` to `action`, removing it from every other action so one key never
 * does two things. Returns a new table.
 */
export function rebind(bindings: Readonly<Bindings>, action: Action, code: string): Bindings {
  const out = cloneBindings(bindings);
  for (const a of ACTIONS) out[a] = out[a].filter((c) => c !== code);
  out[action] = [...out[action], code];
  return out;
}

/** Remove every code from `action`. Returns a new table. */
export function unbind(bindings: Readonly<Bindings>, action: Action): Bindings {
  const out = cloneBindings(bindings);
  out[action] = [];
  return out;
}
