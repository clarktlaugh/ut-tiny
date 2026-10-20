/**
 * The §7.1 routes of the laundry room as the walkabout demo presents them
 * (P31): where to stand to try each one, what to do, and a script that does
 * it headlessly so `routes.test.ts` can prove every route is reachable with
 * the live movement tuning (docs/DESIGN.md §4, §7.1; route list in
 * `src/maps/laundry-room.ts`).
 *
 * Coordinates are the map's (meters, +Y up, floor at y = 0, feet-on-surface
 * positions); the few dimensions needed are repeated here with the map's
 * names, since the map file does not export them.
 */
import { LAUNDRY_LANDMARKS, LAUNDRY_ROOM } from '../../maps/laundry-room';
import type { DamageType, PickupType, Pose, Vec3 } from '../../sim/types';
import {
  dodge,
  face,
  feetY,
  hold,
  runAndJump,
  waitLanding,
  waitUntil,
  walkTo,
  walkUntilAirborne,
  type RouteStep,
} from './routeDriver';

/** Facing constants: poses face −Z at yaw 0, yaw −π/2 faces +X, yaw π faces +Z. */
export const FACE_NEG_Z = 0;
export const FACE_POS_X = -Math.PI / 2;
export const FACE_POS_Z = Math.PI;
export const FACE_NEG_X = Math.PI / 2;

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const pose = (position: Vec3, yaw: number, pitch = 0): Pose => ({ position, yaw, pitch });

// Dimensions from src/maps/laundry-room.ts.
const MACHINE_TOP = 34;
const SHELF_TOP = 72;
const TABLE_TOP = 30;
const DRUM_FLOOR = 20;
const DRYER_ROOM_FLOOR = 6;
const SINK_BASIN = 33;
const SINK_RIM = 34;
const LINE_TOP = 60.6;
const IRON_TOP = TABLE_TOP + 1.5;
const HOSE_TOP = 40;
const BOARD_FOOT_Z = 24 - TABLE_TOP / Math.tan((35 * Math.PI) / 180);

/** Feet position on a map jump pad (pads are listed washer, dryer, sink, clothesline, shelf). */
function padFeet(index: number): Vec3 {
  const pad = LAUNDRY_ROOM.jumpPads[index];
  if (!pad) throw new Error(`laundry room has no jump pad ${index}`);
  return v(pad.position.x, pad.position.y - pad.size.y / 2, pad.position.z);
}
const PAD = {
  washer: padFeet(0),
  dryer: padFeet(1),
  sink: padFeet(2),
  clothesline: padFeet(3),
  shelf: padFeet(4),
};

/** What a scripted run must show. */
export interface RouteExpect {
  /** Stand within `radius` (horizontal) of `near` with feet at `feetY` ± 0.6 m. */
  arrive?: { near: Vec3; radius: number; feetY: number };
  alive: boolean;
  /** No `fall` damage along the way (pad landings and short drops). */
  noFallDamage?: boolean;
  /** The run ends with this death. */
  death?: { damageType: DamageType; message?: string };
  /** A `dodge` event with `wall: true`. */
  wallDodge?: boolean;
  /** A `jump` event with `double: true`. */
  doubleJump?: boolean;
  /** A `jumpPad` event. */
  jumpPad?: boolean;
  /** A `pickupTaken` of this type. */
  pickup?: PickupType;
  /** `damage` events of this type were dealt. */
  hurtBy?: DamageType;
  /** `world.inWater(pawn)` at the end. */
  inWater?: boolean;
}

export type RouteGroup = 'route' | 'hazard';

export interface RouteDef {
  /** `R1`, `R4`, `H2`. */
  readonly id: string;
  readonly group: RouteGroup;
  readonly title: string;
  /** Where to stand to try it: feet on the surface, facing the first move. */
  readonly start: Pose;
  /** One line for the teleport panel. */
  readonly howTo: string;
  /** The headless script. */
  readonly steps: readonly RouteStep[];
  readonly expect: RouteExpect;
}

const SECOND = 60;

export const ROUTES: readonly RouteDef[] = [
  {
    id: 'R1',
    group: 'route',
    title: 'Clothespin pad to the washer',
    start: pose(v(11, 0, 2), FACE_NEG_Z),
    howTo: 'Walk onto the clothespin ahead; it throws you onto the washer rim with no fall damage.',
    steps: [walkUntilAirborne(PAD.washer, 'walk onto the washer pad'), waitLanding()],
    expect: {
      arrive: { near: v(11, MACHINE_TOP, -30), radius: 5, feetY: MACHINE_TOP },
      alive: true,
      noFallDamage: true,
      jumpPad: true,
    },
  },
  {
    id: 'R1b',
    group: 'route',
    title: 'Clothespin pad to the dryer',
    start: pose(v(38, 0, 2), FACE_NEG_Z),
    howTo: 'Walk onto the clothespin ahead to land on the dryer top.',
    steps: [walkUntilAirborne(PAD.dryer, 'walk onto the dryer pad'), waitLanding()],
    expect: {
      arrive: { near: v(38, MACHINE_TOP, -32), radius: 5, feetY: MACHINE_TOP },
      alive: true,
      noFallDamage: true,
      jumpPad: true,
    },
  },
  {
    id: 'R2',
    group: 'route',
    title: 'Washer to dryer across the gap',
    start: pose(v(27, MACHINE_TOP, -32), FACE_POS_X),
    howTo: 'Run right and jump at the edge to cross the 4 m gap to the dryer.',
    steps: [
      runAndJump(v(44, MACHINE_TOP, -32), (p) => p.position.x >= 31.4, 'run and jump the gap'),
    ],
    expect: {
      arrive: { near: v(38, MACHINE_TOP, -32), radius: 4, feetY: MACHINE_TOP },
      alive: true,
      noFallDamage: true,
    },
  },
  {
    id: 'R3',
    group: 'route',
    title: 'Hose tunnel to the vent, drop to the dryer',
    start: pose(v(4, 0, -47), FACE_POS_X),
    howTo:
      'Follow the ribbed hose up behind the machines to the vent landing, then step off the hose top onto the dryer. Mind the corner cap: it is a pad.',
    steps: [
      walkTo(v(59, HOSE_TOP, -46.5), {
        radius: 0.7,
        maxTicks: 25 * SECOND,
        name: 'climb to the vent',
      }),
      walkTo(v(56.5, HOSE_TOP - 1.3, -46.5), { radius: 0.5, name: 'back from the landing' }),
      walkUntilAirborne(v(56.5, MACHINE_TOP, -36), 'step off the hose top'),
      waitLanding(),
    ],
    expect: {
      arrive: { near: v(56.5, MACHINE_TOP, -42.5), radius: 4, feetY: MACHINE_TOP },
      alive: true,
      noFallDamage: true,
    },
  },
  {
    id: 'R4',
    group: 'route',
    title: 'Dryer corner cap, wall dodge onto the shelf',
    start: pose(v(50, MACHINE_TOP, -36), FACE_POS_X),
    howTo:
      'Hug the right wall and back into the detergent cap in the corner. At the top of the launch, dodge left off the wall onto the shelf: the Redeemer.',
    steps: [
      walkTo(v(59.5, MACHINE_TOP, -36), { radius: 0.4, name: 'to the right wall' }),
      walkUntilAirborne(v(59.5, MACHINE_TOP, -43), 'back into the corner cap'),
      waitUntil('rise to the shelf', (p) => p.velocity.y <= 0 && feetY(p) >= SHELF_TOP + 0.1),
      dodge('left', FACE_NEG_Z),
      waitLanding(),
    ],
    expect: {
      arrive: { near: v(54, SHELF_TOP, -41), radius: 5, feetY: SHELF_TOP },
      alive: true,
      noFallDamage: true,
      jumpPad: true,
      wallDodge: true,
    },
  },
  {
    id: 'R5',
    group: 'route',
    title: 'Washer cap to the towel, walk the clothesline',
    start: pose(v(12, MACHINE_TOP, -23), FACE_POS_X),
    howTo:
      'Walk along the washer’s front rim onto the detergent cap; land on the towel over the clothesline and walk the beam to the middle.',
    steps: [
      walkUntilAirborne(PAD.clothesline, 'walk onto the washer cap'),
      waitLanding(),
      walkTo(LAUNDRY_LANDMARKS.clotheslineMid ?? v(0, LINE_TOP, 0), {
        radius: 1.5,
        maxTicks: 12 * SECOND,
        name: 'walk the beam',
      }),
    ],
    expect: {
      arrive: { near: v(0, LINE_TOP, 0), radius: 2, feetY: LINE_TOP },
      alive: true,
      noFallDamage: true,
      jumpPad: true,
    },
  },
  {
    id: 'R6',
    group: 'route',
    title: 'Ironing board ramp to the table',
    start: pose(v(-23, 0, BOARD_FOOT_Z - 8), FACE_POS_Z),
    howTo:
      'Walk up the ironing board (35°) onto the folding table. Keep left: the iron at the top burns.',
    steps: [
      walkTo(v(-23, TABLE_TOP, 30), { radius: 2, maxTicks: 25 * SECOND, name: 'up the board' }),
    ],
    expect: {
      arrive: { near: v(-23, TABLE_TOP, 30), radius: 3, feetY: TABLE_TOP },
      alive: true,
      noFallDamage: true,
    },
  },
  {
    id: 'R6b',
    group: 'route',
    title: 'Double jump onto the iron',
    start: pose(v(-18, TABLE_TOP, 40), FACE_NEG_Z),
    howTo:
      'The iron is taller than a jump: jump, then jump again near the top to get onto its plate. Standing on it costs 10 health a second.',
    steps: [
      walkTo(v(-18, IRON_TOP, 29), { radius: 1.2, jump: 'double', name: 'onto the iron plate' }),
      hold(0, 90),
    ],
    expect: {
      arrive: { near: v(-18, IRON_TOP, 29), radius: 2.5, feetY: IRON_TOP },
      alive: true,
      doubleJump: true,
      hurtBy: 'damageVolume',
    },
  },
  {
    id: 'R7',
    group: 'route',
    title: 'Sink pad, rim hop, dodge to the table',
    start: pose(v(-42, 0, 12), FACE_POS_Z),
    howTo:
      'The clothespin ahead lands you in the sink basin. Jump onto the right rim, then dodge toward the table: 8 m across, 4 m down.',
    steps: [
      walkUntilAirborne(PAD.sink, 'walk onto the sink pad'),
      waitLanding(),
      walkTo(v(-36.6, SINK_RIM, 40), { radius: 0.5, jump: 'single', name: 'hop onto the rim' }),
      face(FACE_POS_X),
      dodge('forward', FACE_POS_X),
      waitLanding(),
    ],
    expect: {
      arrive: { near: v(-26.5, TABLE_TOP, 40), radius: 3, feetY: TABLE_TOP },
      alive: true,
      noFallDamage: true,
      jumpPad: true,
    },
  },
  {
    id: 'R8',
    group: 'route',
    title: 'Dryer door ramp into the drum',
    start: pose(v(48, 0, 0), FACE_NEG_Z),
    howTo: 'Walk up the sagging dryer door into the drum room; the Super Shield is at the back.',
    steps: [
      walkTo(v(48, DRYER_ROOM_FLOOR, -37), {
        radius: 1,
        maxTicks: 15 * SECOND,
        name: 'up the door into the drum',
      }),
    ],
    expect: {
      arrive: { near: v(48, DRYER_ROOM_FLOOR, -37), radius: 2, feetY: DRYER_ROOM_FLOOR },
      alive: true,
      noFallDamage: true,
      pickup: 'superShield',
    },
  },
  {
    id: 'R9',
    group: 'route',
    title: 'Clothes pile steps',
    start: pose(v(-56, 0, -3), FACE_POS_X),
    howTo:
      'From the left wall, keep jumping up the clothes pile, one metre a step, to the 5 m perch.',
    steps: [
      walkTo(v(-45, 3, -2), {
        radius: 1.5,
        jump: 'hop',
        maxTicks: 15 * SECOND,
        name: 'up the pile',
      }),
      walkTo(v(-36, 5, 0), {
        radius: 1.5,
        jump: 'hop',
        maxTicks: 15 * SECOND,
        name: 'to the perch',
      }),
    ],
    expect: {
      arrive: { near: v(-36, 5, 0), radius: 2.5, feetY: 5 },
      alive: true,
      noFallDamage: true,
    },
  },
  {
    id: 'H1',
    group: 'hazard',
    title: 'Sink sump (kill volume)',
    start: pose(v(-48, SINK_BASIN, 34), FACE_POS_Z),
    howTo: 'The drain hole in the sink basin drops into the sump. It kills; you respawn.',
    steps: [
      walkTo(v(-48, DRUM_FLOOR, 40), { radius: 0.5, maxTicks: 5 * SECOND, name: 'into the sump' }),
    ],
    expect: { alive: false, death: { damageType: 'killVolume', message: 'sumped' } },
  },
  {
    id: 'H2',
    group: 'hazard',
    title: 'Drop off the washer (fall damage)',
    start: pose(v(30, MACHINE_TOP, -21), FACE_POS_Z),
    howTo:
      'Step off the 34 m machine top: with the §4 numbers that fall is lethal. Use the pads and ramps to get down.',
    steps: [walkUntilAirborne(v(30, 0, -10), 'off the front edge'), waitLanding()],
    expect: { alive: false, death: { damageType: 'fall' } },
  },
  {
    id: 'H3',
    group: 'hazard',
    title: 'Washer drum (water trap)',
    start: pose(v(16, MACHINE_TOP, -23), FACE_NEG_Z),
    howTo: 'The open lid drops you 14 m into the drum water. There is no way out but a teleport.',
    steps: [walkUntilAirborne(v(16, DRUM_FLOOR, -32), 'into the drum'), waitLanding()],
    expect: {
      arrive: { near: v(16, DRUM_FLOOR, -32), radius: 6, feetY: DRUM_FLOOR },
      alive: true,
      inWater: true,
    },
  },
];

export function findRoute(id: string): RouteDef | undefined {
  return ROUTES.find((r) => r.id === id);
}
