/**
 * Worst-case first-person positions in the Laundry Room for the view-model
 * clipping check (P15 acceptance). Each one puts the pawn's capsule flush
 * against geometry (0.4 m radius, §3) and faces into it, so a view model
 * drawn in the world pass would poke through. The demo page renders these and
 * the tests check the poses really are flush.
 *
 * Positions are feet-on-floor; yaw 0 faces −Z, yaw −π/2 faces +X.
 */
import type { Vec3, WeaponId } from '../../sim/types';

export interface ViewModelTestPosition {
  name: string;
  /** Feet position (capsule bottom). */
  feet: Vec3;
  yaw: number;
  pitch: number;
  crouching?: boolean;
  /** Velocity to feed bob/sway (e.g. running into the wall). */
  velocity?: Vec3;
  weapon: WeaponId;
  /** Show a muzzle flash in the frozen frame. */
  firing?: boolean;
  note: string;
}

/** Capsule radius (§3); flush means the capsule touches the surface. */
const R = 0.4;

export const VIEWMODEL_TEST_POSITIONS: readonly ViewModelTestPosition[] = [
  {
    name: 'back-wall',
    feet: { x: -20, y: 0, z: -50 + R },
    yaw: 0,
    pitch: 0,
    velocity: { x: 0, y: 0, z: -8.8 },
    weapon: 'rocket',
    firing: true,
    note: 'Nose against the back wall, running into it and firing the longest-barrel heavy weapon.',
  },
  {
    name: 'washer-front',
    feet: { x: 20, y: 0, z: -20 + R },
    yaw: 0,
    pitch: 0.35,
    weapon: 'sniper',
    note: 'Flush against the washer front, looking slightly up; the sniper barrel is the longest.',
  },
  {
    name: 'right-wall-strafe',
    feet: { x: 60 - R, y: 0, z: -6 },
    yaw: -Math.PI / 2,
    pitch: 0,
    velocity: { x: 0, y: 0, z: 8.8 },
    weapon: 'assault',
    firing: true,
    note: 'Facing the right wall while strafing along it (max roll and bob), firing.',
  },
  {
    name: 'back-left-corner',
    feet: { x: -60 + R, y: 0, z: -50 + R },
    yaw: Math.PI / 4,
    pitch: -0.2,
    weapon: 'redeemer',
    note: 'Wedged into the back-left corner, facing it, with the fattest model.',
  },
  {
    name: 'floor-crouch',
    feet: { x: 6, y: 0, z: 6 },
    yaw: 0.6,
    pitch: -1.45,
    crouching: true,
    weapon: 'shock',
    firing: true,
    note: 'Crouched, looking straight down at the floor, firing.',
  },
  {
    name: 'dryer-side',
    feet: { x: 36 - R, y: 0, z: -30 },
    yaw: -Math.PI / 2,
    pitch: 0.1,
    weapon: 'mines',
    note: 'In the 4 m gap between washer and dryer, against the dryer side.',
  },
];

/** Eye height above the feet (§3: 1.6 m; crouch halves the capsule, §4). */
export function testEyeHeight(position: Readonly<ViewModelTestPosition>): number {
  return position.crouching ? 0.8 : 1.6;
}
