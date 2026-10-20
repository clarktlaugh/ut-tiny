/**
 * Client shell (docs/DESIGN.md §8, §8.3, §8.4): one reusable client that runs
 * a `LocalSession` on a `World` and renders, plays and takes input for it.
 * See `README.md` for how demos use it.
 */
export {
  CLIENT_RULES,
  createClient,
  type Client,
  type ClientFrame,
  type ClientInputOverlay,
  type ClientOptions,
  type ClientPlugin,
  type ClientRenderer,
  type ClientWindow,
} from './client';
export { fxPlugin, hudPlugin, type FxLike, type HudLike } from './plugins';
export {
  DEFAULT_VIEW_TARGET_SETTINGS,
  DefaultViewTargetResolver,
  VELOCITY_LOOK_MIN_SPEED,
  cameraPoseFor,
  findEntity,
  findPawn,
  quatForward,
  type CameraInputs,
} from './viewTarget';
export {
  MAX_PIXEL_RATIO,
  MAX_VERTICAL_FOV,
  cameraFov,
  defaultPixelRatio,
  verticalFov,
  wantsTouch,
} from './viewport';
