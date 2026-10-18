/**
 * Movement tunables (docs/DESIGN.md §4). Values are UT2004 numbers converted
 * at 50 UU = 1 m and are meant to be tuned by feel through the dev panel
 * (`src/app/devTuning.ts`), so everything here is a plain mutable record.
 *
 * Units: meters, seconds, m/s, m/s², degrees where noted.
 */

export interface MovementConfig {
  /** Top ground speed, m/s (§4: 8.8). */
  groundSpeed: number;
  /** Seconds to reach `groundSpeed` from rest; also the time to brake to a stop (§4: ~0.15). */
  groundAccelTime: number;
  /** Downward acceleration, m/s² (§4: 19, about twice Earth). */
  gravity: number;
  /** Vertical speed given by a jump, m/s (§4: 6.8 → ~1.2 m apex). */
  jumpSpeed: number;
  /**
   * Vertical speed the double jump sets, m/s. §4 words this as "adds 4.5 m/s"
   * but also asks for ~2.4 m total height; near the apex the pawn has no
   * upward speed left to add to, so the controller sets the vertical speed
   * outright and 6.8 m/s gives a second ~1.2 m hop for ~2.4 m in all.
   */
  doubleJumpSpeed: number;
  /** Seconds after the first jump's apex during which a second Jump press still double jumps (§4: 0.75). */
  doubleJumpWindow: number;
  /**
   * Jump presses while still rising faster than this (m/s) are ignored rather
   * than wasted, so mashing Jump at takeoff does not spend the double jump.
   * UT2004 uses the same near-apex rule.
   */
  doubleJumpRiseLimit: number;
  /** Horizontal speed set by a dodge, m/s (§4: 12). */
  dodgeSpeed: number;
  /** Vertical speed set by a dodge, m/s (§4: 3.2). */
  dodgeUpSpeed: number;
  /** Seconds after a dodge before the next one, ground or wall (§4: 0.5). */
  dodgeCooldown: number;
  /** A wall dodge needs a wall within this distance behind the dodge direction, m (§4: 0.6). */
  wallDodgeDistance: number;
  /** Fraction of ground acceleration available while airborne (§4: 0.35). */
  airControl: number;
  /** Capsule height while crouched as a fraction of standing height (§4: 0.5). */
  crouchHeightScale: number;
  /** Ground speed while crouched as a fraction of `groundSpeed` (§4: 0.5). */
  crouchSpeedScale: number;
  /** Tallest ledge the pawn walks up without jumping, m (§4: 0.45). */
  stepHeight: number;
  /** How far below the feet the ground may be and still hold the pawn, m. */
  groundSnap: number;
  /** Steepest walkable surface, degrees from horizontal; steeper is a wall or a slide. */
  walkableSlope: number;
  /** Impact speed below which landing does no damage, m/s (§4: 20). */
  fallDamageMinSpeed: number;
  /** Impact speed that deals `fallDamageLethal` damage, m/s (§4: 35). Damage keeps rising linearly past it. */
  fallDamageLethalSpeed: number;
  /** Damage dealt at `fallDamageLethalSpeed`; 100 kills a freshly spawned pawn. */
  fallDamageLethal: number;
  /** Meters of ground travel between `footstep` events. */
  footstepDistance: number;
}

/** §4 defaults. Copy with `{ ...DEFAULT_MOVEMENT }` before tuning. */
export const DEFAULT_MOVEMENT: Readonly<MovementConfig> = Object.freeze({
  groundSpeed: 8.8,
  groundAccelTime: 0.15,
  gravity: 19,
  jumpSpeed: 6.8,
  doubleJumpSpeed: 6.8,
  doubleJumpWindow: 0.75,
  doubleJumpRiseLimit: 2,
  dodgeSpeed: 12,
  dodgeUpSpeed: 3.2,
  dodgeCooldown: 0.5,
  wallDodgeDistance: 0.6,
  airControl: 0.35,
  crouchHeightScale: 0.5,
  crouchSpeedScale: 0.5,
  stepHeight: 0.45,
  groundSnap: 0.45,
  walkableSlope: 46,
  fallDamageMinSpeed: 20,
  fallDamageLethalSpeed: 35,
  fallDamageLethal: 100,
  footstepDistance: 2.2,
});

/** Fresh mutable copy of the defaults. */
export function createMovementConfig(overrides: Partial<MovementConfig> = {}): MovementConfig {
  return { ...DEFAULT_MOVEMENT, ...overrides };
}

export type MovementKey = keyof MovementConfig;

/** Slider metadata for one tunable, consumed by the dev panel. */
export interface MovementTunable {
  key: MovementKey;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
}

/** Every tunable in panel order, with slider ranges wide enough to explore but not break the sim. */
export const MOVEMENT_TUNABLES: readonly MovementTunable[] = Object.freeze([
  { key: 'groundSpeed', label: 'Ground speed', min: 2, max: 20, step: 0.1, unit: 'm/s' },
  { key: 'groundAccelTime', label: 'Accel time', min: 0.02, max: 1, step: 0.01, unit: 's' },
  { key: 'gravity', label: 'Gravity', min: 5, max: 40, step: 0.5, unit: 'm/s²' },
  { key: 'jumpSpeed', label: 'Jump speed', min: 2, max: 15, step: 0.1, unit: 'm/s' },
  { key: 'doubleJumpSpeed', label: 'Double jump speed', min: 0, max: 15, step: 0.1, unit: 'm/s' },
  { key: 'doubleJumpWindow', label: 'Double jump window', min: 0, max: 2, step: 0.05, unit: 's' },
  {
    key: 'doubleJumpRiseLimit',
    label: 'Double jump rise limit',
    min: 0,
    max: 8,
    step: 0.1,
    unit: 'm/s',
  },
  { key: 'dodgeSpeed', label: 'Dodge speed', min: 4, max: 25, step: 0.1, unit: 'm/s' },
  { key: 'dodgeUpSpeed', label: 'Dodge up speed', min: 0, max: 8, step: 0.1, unit: 'm/s' },
  { key: 'dodgeCooldown', label: 'Dodge cooldown', min: 0, max: 2, step: 0.05, unit: 's' },
  {
    key: 'wallDodgeDistance',
    label: 'Wall dodge distance',
    min: 0.1,
    max: 2,
    step: 0.05,
    unit: 'm',
  },
  { key: 'airControl', label: 'Air control', min: 0, max: 1, step: 0.01, unit: '×' },
  { key: 'crouchHeightScale', label: 'Crouch height', min: 0.3, max: 1, step: 0.05, unit: '×' },
  { key: 'crouchSpeedScale', label: 'Crouch speed', min: 0.1, max: 1, step: 0.05, unit: '×' },
  { key: 'stepHeight', label: 'Step height', min: 0, max: 1, step: 0.01, unit: 'm' },
  { key: 'groundSnap', label: 'Ground snap', min: 0, max: 1, step: 0.01, unit: 'm' },
  { key: 'walkableSlope', label: 'Walkable slope', min: 10, max: 80, step: 1, unit: '°' },
  { key: 'fallDamageMinSpeed', label: 'Fall damage from', min: 5, max: 50, step: 0.5, unit: 'm/s' },
  {
    key: 'fallDamageLethalSpeed',
    label: 'Fall lethal at',
    min: 5,
    max: 80,
    step: 0.5,
    unit: 'm/s',
  },
  { key: 'fallDamageLethal', label: 'Fall lethal damage', min: 0, max: 500, step: 5, unit: 'hp' },
  { key: 'footstepDistance', label: 'Footstep distance', min: 0.5, max: 5, step: 0.1, unit: 'm' },
]);
