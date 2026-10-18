/**
 * A rough laundry-room sketch (docs/DESIGN.md §7.1) used by the scene view's
 * tests and its dev demo page. It is not the game map: P9 owns
 * `src/maps/laundry-room.ts`. Room is 120 × 100 × 96 m, floor at y = 0,
 * back wall at z = −50, long axis along X.
 */
import type { Brush, MapDef } from '../../../sim/types';

const box = (
  material: string,
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  yaw?: number,
): Brush => ({
  shape: 'box',
  position: { x, y, z },
  size: { x: sx, y: sy, z: sz },
  material,
  ...(yaw === undefined ? {} : { yaw }),
});

const cyl = (material: string, x: number, y: number, z: number, d: number, h: number): Brush => ({
  shape: 'cylinder',
  position: { x, y, z },
  size: { x: d, y: h, z: d },
  material,
});

// Ironing board: 35° ramp from the floor up to the table top (30 m), climbing toward +Z.
const RAMP_RISE = 30;
const RAMP_RUN = RAMP_RISE / Math.tan((35 * Math.PI) / 180);
const TABLE_NEAR_Z = 30;

const tableLegs: Brush[] = [
  [12, 32],
  [48, 32],
  [12, 48],
  [48, 48],
].map(([x, z]) => cyl('wood-leg', x ?? 0, 14, z ?? 0, 2, 28));

export const LAUNDRY_SKETCH: MapDef = {
  name: 'laundry-sketch',
  scale: 40,
  brushes: [
    // Shell (no ceiling, so overview cameras can see in).
    box('floor-tile', 0, -0.5, 0, 120, 1, 100),
    box('wall-back', 0, 48, -50.5, 122, 96, 1),
    box('wall-front', 0, 48, 50.5, 122, 96, 1),
    box('wall-left', -60.5, 48, 0, 1, 96, 100),
    box('wall-right', 60.5, 48, 0, 1, 96, 100),
    // Washer and dryer: 24 × 24 × 34 m towers with a 4 m gap.
    box('enamel-washer', -14, 17, -38, 24, 34, 24),
    box('enamel-dryer', 14, 17, -38, 24, 34, 24),
    // Shelf at 72 m with detergent bottles.
    box('wood-shelf', 0, 71.5, -45, 64, 1, 10),
    box('plastic-bleach', -20, 78, -45, 6, 12, 4),
    box('plastic-detergent', 22, 78, -45, 6, 12, 4),
    box('cardboard-sheets', 2, 76, -45, 10, 8, 6),
    // Folding table, 30 m tall, with a laundry basket on top.
    box('wood-table', 30, 29, 40, 40, 2, 20),
    ...tableLegs,
    box('fabric-basket', 36, 37, 41, 18, 14, 14),
    // Ironing board ramp and the iron at its top.
    {
      shape: 'ramp',
      position: { x: 20, y: RAMP_RISE / 2, z: TABLE_NEAR_Z - RAMP_RUN / 2 },
      size: { x: 8, y: RAMP_RISE, z: RAMP_RUN },
      material: 'fabric-ironing-board',
    },
    box('metal-iron', 20, 31.5, 34, 5, 3, 7),
    // Utility sink in the front-left corner.
    box('porcelain-sink', -48, 18, 40, 24, 36, 20),
    // Dryer vent hose up the back wall, clothesline, floor drain, clothes pile.
    cyl('metal-hose', 34, 20, -46, 6, 40),
    box('rubber-clothesline', 0, 60, 0, 120, 0.4, 0.4),
    cyl('steel-drain', 0, 0.15, 0, 6, 0.3),
    box('fabric-clothes', -20, 3, 20, 18, 6, 12, 0.4),
  ],
  props: [],
  spawns: [
    { position: { x: -50, y: 0, z: -40 }, yaw: -Math.PI / 4, pitch: 0 },
    { position: { x: 50, y: 0, z: -40 }, yaw: Math.PI / 4, pitch: 0 },
    { position: { x: -50, y: 0, z: 10 }, yaw: -Math.PI / 2, pitch: 0 },
    { position: { x: 0, y: 0, z: 40 }, yaw: 0, pitch: 0 },
    { position: { x: -14, y: 34, z: -38 }, yaw: 0, pitch: 0 },
    { position: { x: 14, y: 34, z: -38 }, yaw: 0, pitch: 0 },
    { position: { x: 30, y: 30, z: 36 }, yaw: Math.PI, pitch: 0 },
    { position: { x: 50, y: 0, z: 10 }, yaw: Math.PI / 2, pitch: 0 },
  ],
  pickups: [
    { type: 'weapon', weapon: 'assault', position: { x: -45, y: 1, z: -30 } },
    { type: 'weapon', weapon: 'assault', position: { x: 45, y: 1, z: -30 } },
    { type: 'weapon', weapon: 'rocket', position: { x: 36, y: 31, z: 41 } },
    { type: 'weapon', weapon: 'sniper', position: { x: -48, y: 37, z: 31 } },
    { type: 'weapon', weapon: 'shock', position: { x: 14, y: 35, z: -38 } },
    { type: 'weapon', weapon: 'redeemer', position: { x: 10, y: 73, z: -45 } },
    { type: 'shieldPack', position: { x: 0, y: 1, z: 0 } },
    { type: 'healthVial', position: { x: -48, y: 37, z: 46 } },
  ],
  jumpPads: [
    {
      position: { x: -30, y: 0.5, z: -20 },
      size: { x: 3, y: 1, z: 3 },
      launch: { x: 4, y: 26, z: -6 },
    },
    {
      position: { x: 30, y: 0.5, z: -20 },
      size: { x: 3, y: 1, z: 3 },
      launch: { x: -4, y: 26, z: -6 },
    },
  ],
  volumes: [
    {
      kind: 'water',
      box: { min: { x: -24, y: 26, z: -48 }, max: { x: -4, y: 34, z: -28 } },
      deathMessage: 'washed',
    },
    {
      kind: 'damage',
      box: { min: { x: 17.5, y: 33, z: 30.5 }, max: { x: 22.5, y: 35, z: 37.5 } },
      damagePerSecond: 10,
    },
  ],
  lights: [
    { kind: 'ambient', temperatureK: 7000, intensity: 0.35 },
    { kind: 'point', position: { x: 0, y: 88, z: 0 }, temperatureK: 2700, intensity: 1.4 },
    {
      kind: 'directional',
      direction: { x: 0.3, y: -1, z: 0.5 },
      temperatureK: 6500,
      intensity: 1.6,
      castShadow: true,
    },
  ],
  navLinks: [
    { from: { x: -30, y: 0, z: -20 }, to: { x: -14, y: 34, z: -38 }, kind: 'pad' },
    { from: { x: 30, y: 0, z: -20 }, to: { x: 14, y: 34, z: -38 }, kind: 'pad' },
  ],
  cameras: [
    {
      name: 'overview',
      pose: { position: { x: 55, y: 85, z: 48 }, yaw: 0.85, pitch: -0.55 },
    },
    { name: 'machines', pose: { position: { x: 0, y: 20, z: 20 }, yaw: 0, pitch: 0.15 } },
    { name: 'shelf', pose: { position: { x: 0, y: 78, z: -10 }, yaw: 0, pitch: -0.25 } },
    { name: 'table', pose: { position: { x: -10, y: 40, z: 0 }, yaw: -2.2, pitch: -0.3 } },
    { name: 'sink', pose: { position: { x: -20, y: 45, z: 10 }, yaw: 2.3, pitch: -0.45 } },
    { name: 'drain', pose: { position: { x: 0, y: 1.6, z: 35 }, yaw: 0, pitch: -0.05 } },
  ],
  ambience: { loops: [], reverb: 'small-room' },
};
