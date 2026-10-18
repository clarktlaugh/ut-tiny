/**
 * Laundry Room: the first map, grey-boxed (docs/DESIGN.md §7.1, P9).
 *
 * Real room 3.0 × 2.5 × 2.4 m at S = 40 → 120 × 100 × 96 m. Meters, +Y up,
 * floor top at y = 0, origin at the room's center. The long axis runs along
 * X; the back wall is at z = −50 and the front wall at z = +50.
 *
 * Layout (top-down):
 *
 *   back wall z = −50 ─────────────────────────────────────────────────
 *     shelf (y 72) above the machines, Redeemer         hose tunnel slot
 *     washer x 8..32   dryer x 36..60   (z −44..−20)    behind machines
 *   clothes pile (left)      drain (0,0)      clothespin pads
 *     sink (front-left)   ironing board → table + basket (front)   door
 *   front wall z = +50 ────────────────────────────────────────────────
 *
 * Conventions (shared with `src/sim/physics/shapes.ts` and the scene view):
 * boxes use full extents, cylinders stand on Y with `size.x` the diameter,
 * ramps climb toward local +Z, `yaw` rotates about +Y (positive turns +X
 * toward −Z). Poses face −Z at yaw 0, so yaw −π/2 faces +X and yaw π faces +Z;
 * positive pitch looks up. Spawn positions are feet-on-surface.
 *
 * Vertical traversal with the §4 movement numbers (jump 1.2 m, double jump
 * 2.4 m, dodge 12 m/s + 3.2 m/s up, 19 m/s² gravity): every platform is far
 * taller than a jump, so the big lifts are jump pads (clothespins on the
 * floor, detergent-cap trampolines on the machines) and the safe ways down
 * are the ironing board ramp, the hose tunnel, and short drops. Drops over
 * ~10.5 m deal fall damage and over ~32 m are lethal with the current
 * tuning, so a fall from a machine top, the shelf or the clothesline kills.
 * Pad launches are computed from `DEFAULT_MOVEMENT.gravity` so the pad apex
 * lands exactly where the comments say.
 *
 * Routes (the checklist on issue #10 is verified by simulation against this
 * file with `CharacterMover`):
 *  R1 floor → clothespin pad → washer left rim / dryer top.
 *  R2 washer rim ↔ dryer top across the 4 m gap with a running jump or dodge.
 *  R3 floor → hose tunnel (behind the washer) up the 40 m ramp → vent landing
 *     → drop 6 m onto the dryer top.
 *  R4 dryer top → cap trampoline in the back-right corner → straight up the
 *     corner → wall dodge off the right wall onto the shelf end → Redeemer.
 *     Missing the dodge drops you back onto the pad, which bounces you up
 *     again (the pad fires before the pawn lands, so no fall damage).
 *  R5 washer front rim → cap trampoline → towel draped over the clothesline,
 *     then along the 1.2 m beam at y 60.6.
 *  R6 floor → ironing board ramp (35°) → table top; iron plate burns 10 dps.
 *  R7 floor → clothespin pad → sink basin; hop 1 m out onto the rim; dodge
 *     from the right rim 8 m across and 4 m down onto the table.
 *  R8 floor → bottom-hinged dryer door ramp → drum room → Super Shield.
 *  R9 floor → clothes pile steps (1 m each) for cover and a 5 m perch.
 *  Translocator: clothesline (60 m) → shelf (72 m), within the disc's reach.
 */
import { DEFAULT_MOVEMENT } from '../sim/movement/config';
import type {
  Brush,
  CameraDef,
  JumpPadDef,
  MapDef,
  NavLinkDef,
  PickupPlacement,
  Pose,
  Vec3,
  VolumeDef,
} from '../sim/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

/** Box brush from center and full extents. */
function box(material: string, center: Vec3, size: Vec3, yaw?: number): Brush {
  return {
    shape: 'box',
    position: center,
    size,
    material,
    ...(yaw === undefined ? {} : { yaw }),
  };
}

/** Box brush from axis-aligned min/max corners. */
function span(material: string, min: Vec3, max: Vec3): Brush {
  return box(
    material,
    v((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2),
    v(max.x - min.x, max.y - min.y, max.z - min.z),
  );
}

/** Cylinder brush standing on Y: `base` is the center of the bottom face. */
function cyl(material: string, base: Vec3, diameter: number, height: number): Brush {
  return {
    shape: 'cylinder',
    position: v(base.x, base.y + height / 2, base.z),
    size: v(diameter, height, diameter),
    material,
  };
}

/** Ramp brush from the center of its footprint; climbs toward local +Z before `yaw`. */
function ramp(
  material: string,
  footprintCenter: Vec3,
  width: number,
  rise: number,
  run: number,
  yaw = 0,
): Brush {
  return {
    shape: 'ramp',
    position: v(footprintCenter.x, footprintCenter.y + rise / 2, footprintCenter.z),
    size: v(width, rise, run),
    material,
    yaw,
  };
}

/** Pose at `eye` looking at `target` (same convention as the scene view's debug camera). */
function lookAt(eye: Vec3, target: Vec3): Pose {
  const dx = target.x - eye.x;
  const dy = target.y - eye.y;
  const dz = target.z - eye.z;
  return {
    position: eye,
    yaw: Math.atan2(-dx, -dz),
    pitch: Math.atan2(dy, Math.hypot(dx, dz)),
  };
}

/** Spawn standing at `feet`, facing along `yaw`. */
const spawn = (feet: Vec3, yaw: number): Pose => ({ position: feet, yaw, pitch: 0 });

/** Gravity the pads are tuned against (§4: 19 m/s²). */
const GRAVITY = DEFAULT_MOVEMENT.gravity;

/**
 * Jump pad whose launch is a ballistic arc from `padFeet` to `apexFeet`. The
 * pawn keeps its horizontal speed through the apex, so it lands a little past
 * `apexFeet` on whatever is just below; the apex is placed with that in mind.
 */
function jumpPad(padFeet: Vec3, apexFeet: Vec3, size: Vec3 = v(3, 1, 3)): JumpPadDef {
  const rise = apexFeet.y - padFeet.y;
  if (!(rise > 0)) throw new Error('jump pad apex must be above the pad');
  const vy = Math.sqrt(2 * GRAVITY * rise);
  const t = vy / GRAVITY;
  return {
    position: v(padFeet.x, padFeet.y + size.y / 2, padFeet.z),
    size,
    launch: v((apexFeet.x - padFeet.x) / t, vy, (apexFeet.z - padFeet.z) / t),
  };
}

const pick = (
  type: PickupPlacement['type'],
  position: Vec3,
  weapon?: PickupPlacement['weapon'],
): PickupPlacement => (weapon ? { type, weapon, position } : { type, position });

const link = (kind: NavLinkDef['kind'], from: Vec3, to: Vec3): NavLinkDef => ({ from, to, kind });

// ---------------------------------------------------------------------------
// Dimensions (meters at S = 40)
// ---------------------------------------------------------------------------

/** Room interior: x ±60, z ±50, y 0..96. */
const ROOM = { hx: 60, hz: 50, height: 96 };
const WALL = 1;

/** Washer and dryer: 24 × 24 × 34 m towers, 6 m off the back wall, 4 m apart. */
const MACHINE = { size: 24, height: 34, back: -44, front: -20 };
const WASHER = { minX: 8, maxX: 32, cx: 20 };
const DRYER = { minX: 36, maxX: 60, cx: 48 };
/** Washer drum opening (the open lid), 12 × 12 m, water below the rim. */
const DRUM = { minX: 14, maxX: 26, minZ: -38, maxZ: -26, floorY: 20, waterTop: 30 };
/** Dryer drum: a 12 m wide room inside the dryer, floor 6 m up, open at the front. */
const DRYER_ROOM = { minX: 42, maxX: 54, floorY: 6, ceilY: 30, backZ: -40 };

/** Shelf 72 m up along the back wall, ending 3 m short of the right wall. */
const SHELF = { minX: -30, maxX: 57, topY: 72, thick: 1.5, depth: 10 };

/** Hose tunnel: the 6 m slot behind the machines, ramp from x 10 to 58, up 40 m. */
const HOSE = { startX: 10, endX: 58, rise: 40, width: 6, cz: -47 };
const HOSE_RUN = HOSE.endX - HOSE.startX;
/** Floor height of the hose ramp at world x (clamped to the ramp). */
function hoseFloorY(x: number): number {
  const s = Math.min(Math.max(x - HOSE.startX, 0), HOSE_RUN);
  return (HOSE.rise * s) / HOSE_RUN;
}

/** Folding table: 60 × 24 m top, 30 m tall, 2 m from the front wall. */
const TABLE = { minX: -28, maxX: 32, minZ: 24, maxZ: 48, topY: 30, thick: 2 };
/** Laundry basket on the table: 20 × 16 m cage, 12 m tall, doorway on the room side. */
const BASKET = { minX: 12, maxX: 32, minZ: 28, maxZ: 44, height: 12, doorMinX: 20, doorMaxX: 24 };

/** Ironing board: a 35° ramp, 12 m wide, from the floor to the table's near edge. */
const BOARD_X = -18;
const BOARD_WIDTH = 12;
const BOARD_ANGLE = (35 * Math.PI) / 180;
const BOARD_RUN = TABLE.topY / Math.tan(BOARD_ANGLE);
const BOARD_FOOT_Z = TABLE.minZ - BOARD_RUN;
/** Surface height of the ironing board at world z. */
function boardY(z: number): number {
  return (TABLE.topY * (z - BOARD_FOOT_Z)) / BOARD_RUN;
}

/** Utility sink in the front-left corner: 24 × 20 m, rim 34 m up, basin 1 m deep. */
const SINK = { minX: -60, maxX: -36, minZ: 30, maxZ: 50, rimY: 34, basinY: 33, cx: -48, cz: 40 };
const SINK_RIM = 2;
/** Drain hole in the basin floor, 4 × 4 m, dropping to a sump. */
const SUMP = { half: 2, bottomY: 20 };

/** Clothesline: a 1.2 m beam across the room at y 60. */
const LINE = { y: 60, size: 1.2 };
const LINE_TOP = LINE.y + LINE.size / 2;
/** Towel folded over the line above the washer: the 16 × 6 m landing for the cap trampoline. */
const TOWEL = { cx: 20, width: 16, depth: 6, thick: 1.2 };
const TOWEL_TOP = LINE.y + TOWEL.thick;

// ---------------------------------------------------------------------------
// Brushes
// ---------------------------------------------------------------------------

const shell: Brush[] = [
  span(
    'floor-concrete',
    v(-ROOM.hx - WALL, -WALL, -ROOM.hz - WALL),
    v(ROOM.hx + WALL, 0, ROOM.hz + WALL),
  ),
  span(
    'ceiling-drywall',
    v(-ROOM.hx - WALL, ROOM.height, -ROOM.hz - WALL),
    v(ROOM.hx + WALL, ROOM.height + WALL, ROOM.hz + WALL),
  ),
  span(
    'wall-back',
    v(-ROOM.hx - WALL, 0, -ROOM.hz - WALL),
    v(ROOM.hx + WALL, ROOM.height, -ROOM.hz),
  ),
  span(
    'wall-front',
    v(-ROOM.hx - WALL, 0, ROOM.hz),
    v(ROOM.hx + WALL, ROOM.height, ROOM.hz + WALL),
  ),
  span('wall-left', v(-ROOM.hx - WALL, 0, -ROOM.hz), v(-ROOM.hx, ROOM.height, ROOM.hz)),
  span('wall-right', v(ROOM.hx, 0, -ROOM.hz), v(ROOM.hx + WALL, ROOM.height, ROOM.hz)),
  // Closed door on the right wall (the "room entrance"), flush with the wall.
  span('wood-door', v(ROOM.hx - 0.5, 0, 10), v(ROOM.hx, 84, 46)),
];

const washer: Brush[] = [
  // Solid base up to the drum floor.
  span(
    'enamel-washer',
    v(WASHER.minX, 0, MACHINE.back),
    v(WASHER.maxX, DRUM.floorY, MACHINE.front),
  ),
  // Rim around the open drum, up to the top at 34 m.
  span(
    'enamel-washer',
    v(WASHER.minX, DRUM.floorY, MACHINE.back),
    v(DRUM.minX, MACHINE.height, MACHINE.front),
  ),
  span(
    'enamel-washer',
    v(DRUM.maxX, DRUM.floorY, MACHINE.back),
    v(WASHER.maxX, MACHINE.height, MACHINE.front),
  ),
  span(
    'enamel-washer',
    v(DRUM.minX, DRUM.floorY, MACHINE.back),
    v(DRUM.maxX, MACHINE.height, DRUM.minZ),
  ),
  span(
    'enamel-washer',
    v(DRUM.minX, DRUM.floorY, DRUM.maxZ),
    v(DRUM.maxX, MACHINE.height, MACHINE.front),
  ),
  // Open lid standing up along the back edge of the top.
  span(
    'enamel-lid',
    v(WASHER.minX, MACHINE.height, MACHINE.back),
    v(WASHER.maxX, MACHINE.height + 20, MACHINE.back + 1.5),
  ),
];

const dryer: Brush[] = [
  // Base under the drum room.
  span(
    'enamel-dryer',
    v(DRYER.minX, 0, MACHINE.back),
    v(DRYER.maxX, DRYER_ROOM.floorY, MACHINE.front),
  ),
  // Side pillars, back wall and top slab around the drum room.
  span(
    'enamel-dryer',
    v(DRYER.minX, DRYER_ROOM.floorY, MACHINE.back),
    v(DRYER_ROOM.minX, MACHINE.height, MACHINE.front),
  ),
  span(
    'enamel-dryer',
    v(DRYER_ROOM.maxX, DRYER_ROOM.floorY, MACHINE.back),
    v(DRYER.maxX, MACHINE.height, MACHINE.front),
  ),
  span(
    'enamel-dryer',
    v(DRYER_ROOM.minX, DRYER_ROOM.floorY, MACHINE.back),
    v(DRYER_ROOM.maxX, DRYER_ROOM.ceilY, DRYER_ROOM.backZ),
  ),
  span(
    'enamel-dryer',
    v(DRYER_ROOM.minX, DRYER_ROOM.ceilY, MACHINE.back),
    v(DRYER_ROOM.maxX, MACHINE.height, MACHINE.front),
  ),
  // Bottom-hinged door, sagging open to a 38.7° ramp up into the drum.
  ramp('enamel-door', v(DRYER.cx, 0, MACHINE.front + 3.75), 12, DRYER_ROOM.floorY, 7.5, Math.PI),
];

const shelf: Brush[] = [
  span(
    'wood-shelf',
    v(SHELF.minX, SHELF.topY - SHELF.thick, -ROOM.hz),
    v(SHELF.maxX, SHELF.topY, -ROOM.hz + SHELF.depth),
  ),
  // Bottles and a box of dryer sheets standing on the shelf.
  box('plastic-detergent', v(-20, SHELF.topY + 6, -45), v(6, 12, 4)),
  box('cardboard-sheets', v(-4, SHELF.topY + 4, -45), v(10, 8, 6)),
  box('plastic-bleach', v(45, SHELF.topY + 6, -45), v(6, 12, 4)),
  // Shelf brackets.
  box('metal-bracket', v(-20, SHELF.topY - SHELF.thick - 3, -47), v(1, 6, 6)),
  box('metal-bracket', v(20, SHELF.topY - SHELF.thick - 3, -47), v(1, 6, 6)),
];

/** Rib roof segments over the hose slot, with gaps between them for light. */
const hoseRibs: Brush[] = [0, 1, 2, 3, 4].map((k) => {
  const cx = 16 + 10 * k;
  const clearance = hoseFloorY(cx + 3) + 7;
  return box('metal-hose', v(cx, clearance + 1.5, HOSE.cz), v(6, 3, HOSE.width));
});

const hose: Brush[] = [
  ramp(
    'metal-hose',
    v((HOSE.startX + HOSE.endX) / 2, 0, HOSE.cz),
    HOSE.width,
    HOSE.rise,
    HOSE_RUN,
    Math.PI / 2,
  ),
  // Landing at the top, against the right wall, below the wall vent.
  span('metal-hose', v(HOSE.endX, 0, -ROOM.hz), v(ROOM.hx, HOSE.rise, MACHINE.back)),
  span(
    'metal-vent',
    v(HOSE.endX - 6, HOSE.rise + 0.5, -ROOM.hz),
    v(ROOM.hx, HOSE.rise + 8, -ROOM.hz + 0.5),
  ),
  ...hoseRibs,
];

const tableLegs: Brush[] = [
  v(TABLE.minX + 3, 0, TABLE.minZ + 3),
  v(TABLE.maxX - 3, 0, TABLE.minZ + 3),
  v(TABLE.minX + 3, 0, TABLE.maxZ - 3),
  v(TABLE.maxX - 3, 0, TABLE.maxZ - 3),
].map((base) => cyl('metal-leg', base, 2, TABLE.topY - TABLE.thick));

const basketSlat = (min: Vec3, max: Vec3): Brush[] => [
  // Lower and upper slats with a 3 m weave gap between them for rockets.
  span('fabric-basket', v(min.x, TABLE.topY, min.z), v(max.x, TABLE.topY + 4, max.z)),
  span(
    'fabric-basket',
    v(min.x, TABLE.topY + 7, min.z),
    v(max.x, TABLE.topY + BASKET.height, max.z),
  ),
];

const basket: Brush[] = [
  ...basketSlat(v(BASKET.minX, 0, BASKET.maxZ - 1), v(BASKET.maxX, 0, BASKET.maxZ)),
  ...basketSlat(v(BASKET.minX, 0, BASKET.minZ), v(BASKET.minX + 1, 0, BASKET.maxZ)),
  ...basketSlat(v(BASKET.maxX - 1, 0, BASKET.minZ), v(BASKET.maxX, 0, BASKET.maxZ)),
  // Front wall split around the doorway.
  ...basketSlat(v(BASKET.minX, 0, BASKET.minZ), v(BASKET.doorMinX, 0, BASKET.minZ + 1)),
  ...basketSlat(v(BASKET.doorMaxX, 0, BASKET.minZ), v(BASKET.maxX, 0, BASKET.minZ + 1)),
];

const table: Brush[] = [
  span(
    'wood-table',
    v(TABLE.minX, TABLE.topY - TABLE.thick, TABLE.minZ),
    v(TABLE.maxX, TABLE.topY, TABLE.maxZ),
  ),
  ...tableLegs,
  ...basket,
  // Ironing board leaning on the table's near edge, and the iron on the table at its top.
  ramp(
    'fabric-ironing-board',
    v(BOARD_X, 0, (BOARD_FOOT_Z + TABLE.minZ) / 2),
    BOARD_WIDTH,
    TABLE.topY,
    BOARD_RUN,
  ),
  box('metal-iron', v(BOARD_X, TABLE.topY + 0.75, TABLE.minZ + 5), v(6, 1.5, 9)),
];

const sink: Brush[] = [
  span('porcelain-sink', v(SINK.minX, 0, SINK.minZ), v(SINK.maxX, SUMP.bottomY, SINK.maxZ)),
  // Basin floor around the drain hole.
  span(
    'porcelain-sink',
    v(SINK.minX, SUMP.bottomY, SINK.minZ),
    v(SINK.cx - SUMP.half, SINK.basinY, SINK.maxZ),
  ),
  span(
    'porcelain-sink',
    v(SINK.cx + SUMP.half, SUMP.bottomY, SINK.minZ),
    v(SINK.maxX, SINK.basinY, SINK.maxZ),
  ),
  span(
    'porcelain-sink',
    v(SINK.cx - SUMP.half, SUMP.bottomY, SINK.minZ),
    v(SINK.cx + SUMP.half, SINK.basinY, SINK.cz - SUMP.half),
  ),
  span(
    'porcelain-sink',
    v(SINK.cx - SUMP.half, SUMP.bottomY, SINK.cz + SUMP.half),
    v(SINK.cx + SUMP.half, SINK.basinY, SINK.maxZ),
  ),
  // Rim, 1 m above the basin floor.
  span(
    'porcelain-rim',
    v(SINK.minX, SINK.basinY, SINK.minZ),
    v(SINK.minX + SINK_RIM, SINK.rimY, SINK.maxZ),
  ),
  span(
    'porcelain-rim',
    v(SINK.maxX - SINK_RIM, SINK.basinY, SINK.minZ),
    v(SINK.maxX, SINK.rimY, SINK.maxZ),
  ),
  span(
    'porcelain-rim',
    v(SINK.minX, SINK.basinY, SINK.minZ),
    v(SINK.maxX, SINK.rimY, SINK.minZ + SINK_RIM),
  ),
  span(
    'porcelain-rim',
    v(SINK.minX, SINK.basinY, SINK.maxZ - SINK_RIM),
    v(SINK.maxX, SINK.rimY, SINK.maxZ),
  ),
  // Faucet on the back rim and the drain pipe at floor level in front.
  cyl('chrome-faucet', v(SINK.cx, SINK.rimY, SINK.maxZ - 1), 3, 12),
  box('metal-pipe', v(-40, 1.5, SINK.minZ - 2), v(3, 3, 4)),
];

/** Clothes pile: five lumps stepping up 1 m each toward a 5 m perch. */
const clothesPile: Brush[] = [
  box('fabric-clothes', v(-44, 0.5, -6), v(20, 1, 24), 0.15),
  box('fabric-clothes', v(-42, 1, -4), v(16, 2, 18), -0.25),
  box('fabric-clothes', v(-40, 1.5, -2), v(12, 3, 14), 0.35),
  box('fabric-clothes', v(-38, 2, 0), v(9, 4, 10), -0.1),
  box('fabric-clothes', v(-36, 2.5, 2), v(6, 5, 7), 0.4),
];

const clothesline: Brush[] = [
  box('rubber-clothesline', v(0, LINE.y, 0), v(2 * ROOM.hx, LINE.size, LINE.size)),
  // Hanging laundry: thin slabs below the line that block sight lines.
  box('fabric-shirt', v(-30, LINE.y - 14, 0), v(24, 28, 1)),
  box('fabric-sock', v(-10, LINE.y - 8, 0), v(6, 16, 1)),
  box('fabric-shirt', v(12, LINE.y - 14, 0), v(24, 28, 1)),
  box('fabric-sock', v(34, LINE.y - 8, 0), v(6, 16, 1)),
  box('fabric-towel', v(50, LINE.y - 16, 0), v(16, 32, 1)),
  // Towel folded over the line: the landing from the washer's cap trampoline.
  box(
    'fabric-towel',
    v(TOWEL.cx, LINE.y + TOWEL.thick / 2, 0),
    v(TOWEL.width, TOWEL.thick, TOWEL.depth),
  ),
];

const drain: Brush[] = [cyl('steel-drain', v(0, 0, 0), 6, 0.3)];

// ---------------------------------------------------------------------------
// Pads, volumes, placements
// ---------------------------------------------------------------------------

const PAD_FLOOR = 0;

const pads = {
  /** Clothespin in front of the washer → its left rim (clears the front face by 1 m). */
  washer: jumpPad(v(11, PAD_FLOOR, -8), v(11, 40, -24)),
  /** Clothespin in front of the dryer → the dryer top. */
  dryer: jumpPad(v(38, PAD_FLOOR, -8), v(38, 40, -26)),
  /** Clothespin in front of the sink → over the front rim into the basin, clear of the sump. */
  sink: jumpPad(v(-42, PAD_FLOOR, 24), v(-42, 40, 33)),
  /** Detergent cap on the washer's front rim → the towel draped over the clothesline. */
  clothesline: jumpPad(v(WASHER.cx, MACHINE.height, -22), v(WASHER.cx, TOWEL_TOP + 0.5, -2.5)),
  /**
   * Detergent cap in the dryer's back-right corner → straight up the corner to
   * just above the shelf top, beside the 3 m gap between the shelf end and the
   * right wall. Wall dodge left off the wall at the apex to land on the shelf.
   */
  shelf: jumpPad(v(59.2, MACHINE.height, -42.5), v(59.2, SHELF.topY + 0.6, -42.5), v(1.6, 1, 3)),
};

const volumes: VolumeDef[] = [
  {
    kind: 'water',
    box: { min: v(DRUM.minX, DRUM.floorY, DRUM.minZ), max: v(DRUM.maxX, DRUM.waterTop, DRUM.maxZ) },
    deathMessage: 'washed',
  },
  {
    kind: 'damage',
    box: {
      min: v(BOARD_X - 3, TABLE.topY + 1.5, TABLE.minZ + 0.5),
      max: v(BOARD_X + 3, TABLE.topY + 3.5, TABLE.minZ + 9.5),
    },
    damagePerSecond: 10,
  },
  {
    kind: 'kill',
    box: {
      min: v(SINK.cx - SUMP.half, SUMP.bottomY, SINK.cz - SUMP.half),
      max: v(SINK.cx + SUMP.half, SUMP.bottomY + 4, SINK.cz + SUMP.half),
    },
    deathMessage: 'sumped',
  },
];

const spawns: Pose[] = [
  spawn(v(-50, 0, -40), -Math.PI / 2), // back-left floor, facing +X
  spawn(v(50, 0, -8), Math.PI / 2), // in front of the dryer, facing −X
  spawn(v(-50, 0, 16), -Math.PI / 2), // left floor between the pile and the sink
  spawn(v(48, 0, 40), Math.PI / 2), // front-right floor by the door
  spawn(v(11, MACHINE.height, -32), -Math.PI / 2), // washer left rim
  spawn(v(48, MACHINE.height, -30), Math.PI), // dryer top, facing the room
  spawn(v(-8, TABLE.topY, 40), 0), // table top, facing the room
  spawn(v(30, 0, 8), Math.PI / 2), // floor, center-right
];

const pickups: PickupPlacement[] = [
  // Weapons (§7.1).
  pick('weapon', v(-44, 1, -34), 'assault'),
  pick('weapon', v(44, 1, 34), 'assault'),
  pick('weapon', v(-34, 1, 26), 'mines'),
  pick('weapon', v(22, TABLE.topY + 1, 36), 'rocket'),
  pick('weapon', v(SINK.maxX - 1, SINK.rimY + 1, SINK.cz), 'sniper'),
  pick('weapon', v(DRYER.cx, MACHINE.height + 1, -26), 'shock'),
  pick('weapon', v(0, LINE_TOP + 1, 0), 'shockScoped'),
  pick('weapon', v(54, 1, 28), 'teleporter'),
  pick('weapon', v(14, SHELF.topY + 1, -44), 'redeemer'),
  // Armor and health.
  pick('shieldPack', v(0, 1.3, 0)),
  pick('superShield', v(DRYER.cx, DRYER_ROOM.floorY + 1, -37)),
  pick('healthVial', v(-54, SINK.basinY + 1, 35)),
  pick('healthVial', v(-42, SINK.basinY + 1, 35)),
  pick('healthVial', v(-54, SINK.basinY + 1, 45)),
  pick('healthVial', v(-42, SINK.basinY + 1, 45)),
  pick('healthVial', v(BOARD_X, boardY(-10) + 1, -10)),
  pick('healthVial', v(BOARD_X, boardY(0) + 1, 0)),
  pick('healthVial', v(BOARD_X, boardY(10) + 1, 10)),
  pick('healthPack', v(0, 1, 36)),
  pick('healthPack', v(32, hoseFloorY(32) + 1, HOSE.cz)),
  // Ammo near, not at, its weapon.
  pick('ammo', v(-30, 1, -40), 'assault'),
  pick('ammo', v(36, 1, 10), 'assault'),
  pick('ammo', v(-56, 1, 26), 'mines'),
  pick('ammo', v(20, hoseFloorY(20) + 1, HOSE.cz), 'rocket'),
  pick('ammo', v(-4, TABLE.topY + 1, 44), 'rocket'),
  pick('ammo', v(44, hoseFloorY(44) + 1, HOSE.cz), 'sniper'),
  pick('ammo', v(29, MACHINE.height + 1, -32), 'sniper'),
];

const navLinks: NavLinkDef[] = [
  link('pad', v(11, 0, -8), v(11, MACHINE.height, -28)),
  link('pad', v(38, 0, -8), v(38, MACHINE.height, -31)),
  link('pad', v(-42, 0, 24), v(-42, SINK.basinY, 37)),
  link('pad', v(WASHER.cx, MACHINE.height, -22), v(WASHER.cx, TOWEL_TOP, 0)),
  link('pad', v(59.2, MACHINE.height, -42.5), v(55, SHELF.topY, -42.5)),
  link('jump', v(30, MACHINE.height, -32), v(38, MACHINE.height, -32)),
  link('jump', v(38, MACHINE.height, -32), v(30, MACHINE.height, -32)),
  link('jump', v(SINK.maxX - 1, SINK.rimY, 40), v(TABLE.minX + 2, TABLE.topY, 40)),
  link('jump', v(SINK.cx, SINK.basinY, 36), v(SINK.cx, SINK.rimY, SINK.minZ + 1)),
  link('doubleJump', v(BOARD_X, TABLE.topY, 36), v(BOARD_X, TABLE.topY + 1.5, TABLE.minZ + 5)),
  link('drop', v(59, HOSE.rise, -45), v(59, MACHINE.height, -42)),
  link('drop', v(-36, 5, 2), v(-30, 0, 2)),
  link('translocate', v(10, LINE_TOP, 0), v(14, SHELF.topY, -44)),
];

const cameras: CameraDef[] = [
  { name: 'overview', pose: lookAt(v(56, 88, 46), v(0, 20, -10)) },
  { name: 'machines', pose: lookAt(v(-4, 26, 22), v(30, 34, -32)) },
  { name: 'shelf', pose: lookAt(v(10, 80, -4), v(14, 72, -45)) },
  { name: 'table', pose: lookAt(v(-46, 46, 6), v(4, 30, 36)) },
  { name: 'sink', pose: lookAt(v(-20, 46, 12), v(-48, 33, 40)) },
  { name: 'hose', pose: lookAt(v(30, hoseFloorY(30) + 1.6, -47), v(4, 1, -47)) },
];

// ---------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------

/** Named positions other packets and tests can refer to (feet-on-surface). */
export const LAUNDRY_LANDMARKS: Readonly<Record<string, Vec3>> = Object.freeze({
  drain: v(0, 0.3, 0),
  washerRim: v(11, MACHINE.height, -32),
  dryerTop: v(48, MACHINE.height, -32),
  dryerRoom: v(48, DRYER_ROOM.floorY, -30),
  ventLanding: v(59, HOSE.rise, -47),
  hoseEntrance: v(6, 0, HOSE.cz),
  shelf: v(14, SHELF.topY, -45),
  tableTop: v(0, TABLE.topY, 36),
  basket: v(22, TABLE.topY, 36),
  boardFoot: v(BOARD_X, 0, BOARD_FOOT_Z - 1),
  sinkBasin: v(-54, SINK.basinY, 36),
  sinkRim: v(SINK.maxX - 1, SINK.rimY, 40),
  clotheslineMid: v(0, LINE_TOP, 0),
  pileTop: v(-36, 5, 2),
});

export const LAUNDRY_ROOM: MapDef = {
  name: 'laundry-room',
  scale: 40,
  brushes: [
    ...shell,
    ...washer,
    ...dryer,
    ...shelf,
    ...hose,
    ...table,
    ...sink,
    ...clothesPile,
    ...clothesline,
    ...drain,
  ],
  props: [],
  spawns,
  pickups,
  jumpPads: [pads.washer, pads.dryer, pads.sink, pads.clothesline, pads.shelf],
  volumes,
  lights: [
    // One bare bulb, warm, hard shadow (§7.1).
    { kind: 'point', position: v(0, 90, 0), temperatureK: 2700, intensity: 1.4, castShadow: true },
    // Daylight slit from the small window above the shelf.
    {
      kind: 'directional',
      direction: v(0.15, -0.55, 0.8),
      temperatureK: 5500,
      intensity: 1.2,
      castShadow: true,
    },
    { kind: 'ambient', temperatureK: 6500, intensity: 0.3 },
  ],
  navLinks,
  cameras,
  ambience: { loops: ['dryer-tumble', 'washer-slosh', 'pipe-tick'], reverb: 'small-room' },
};

export default LAUNDRY_ROOM;
