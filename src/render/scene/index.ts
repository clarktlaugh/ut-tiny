/** Scene view: `MapDef` → Three.js scene, entity mirroring, debug camera (docs/DESIGN.md §8.3). */
export { SceneView, type SceneViewOptions } from './sceneView';
export { MapView, mapBounds, DEFAULT_LIGHTS, MARKER_COLORS, type MapViewStats } from './mapView';
export { brushGeometry, rampGeometry } from './brushGeometry';
export {
  MaterialLibrary,
  PLACEHOLDER_COLORS,
  placeholderColor,
  kelvinToRgb,
  kelvinToColor,
} from './materials';
export {
  EntityAssets,
  createEntityView,
  placeEntityView,
  lerpAngle,
  playerColor,
  PAWN_HEIGHT,
  PAWN_RADIUS,
  PAWN_EYE_HEIGHT,
  type EntityView,
} from './entityViews';
export {
  DebugCameraControls,
  stepDebugCamera,
  applyPoseToCamera,
  lookAtPose,
  viewDirection,
  type DebugCameraInput,
  type DebugCameraSettings,
} from './debugCamera';
