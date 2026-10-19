/** FX system: pooled particles, beams, flashes, decals and gibs (docs/DESIGN.md §8.3). */
export {
  FxSystem,
  DEFAULT_CAPACITIES,
  pickupColor,
  type FxCapacities,
  type FxSystemOptions,
  type FxStats,
  type ScreenFlash,
} from './fxSystem';
export { ParticleLayer, FX_GRAVITY, type ParticleBlend, type ParticleSpawn } from './particles';
export { BeamPool, type BeamKind, type BeamSpawn } from './beams';
export { LightFlashPool, type FlashSpawn } from './flashes';
export { DecalPool, DECAL_OFFSET, DECAL_FADE, type DecalSpawn } from './decals';
export { GibPool, type GibSpawn } from './gibs';
export { SlotPool, RingPool, AllocationCounter } from './pool';
export {
  Frame,
  ATLAS_CELLS,
  ATLAS_CELL_PX,
  ATLAS_PX,
  cellAlpha,
  buildAtlasPixels,
  createAtlasTexture,
  frameUv,
  type FrameIndex,
} from './atlas';
export {
  NO_SURFACE,
  flatFloorProbe,
  raycastProbe,
  type SurfaceHit,
  type SurfaceProbe,
} from './surface';
export {
  MUZZLE_FX,
  TRACER_FX,
  BEAM_FX,
  IMPACT_FX,
  EXPLOSION_FX,
  TRAIL_FX,
  GIB_FX,
  DECAL_LIFE,
  type MuzzleFx,
  type TracerFx,
  type BeamFx,
  type ImpactFx,
  type ExplosionFx,
  type TrailFx,
} from './effects';
