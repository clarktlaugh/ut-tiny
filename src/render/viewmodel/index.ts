/** First-person view model: weapon meshes, bob/sway, muzzle flash (docs/DESIGN.md §8.3). */
export {
  ViewModel,
  viewModelVisible,
  fovForAspect,
  MIN_FOV_ASPECT,
  RECOIL,
  WEAPON_REST,
  VIEWMODEL_NEAR,
  VIEWMODEL_FAR,
  type ViewModelOptions,
  type ViewModelPawn,
  type ViewModelRenderer,
} from './viewModel';
export {
  ViewModelMotion,
  DEFAULT_MOTION,
  MOTION_LIMITS,
  angleDelta,
  type MotionConfig,
  type MotionInput,
  type MotionOffset,
  type RecoilImpulse,
} from './motion';
export { MuzzleFlash, FLASH_STYLES, flashStyleFor, type FlashStyle } from './muzzleFlash';
export {
  WeaponModelLibrary,
  WEAPON_MODELS,
  type WeaponModel,
  type WeaponModelDef,
  type WeaponPart,
} from './weaponModels';
export {
  VIEWMODEL_TEST_POSITIONS,
  testEyeHeight,
  type ViewModelTestPosition,
} from './testPositions';
