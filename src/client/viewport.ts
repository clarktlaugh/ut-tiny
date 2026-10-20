/**
 * Pure viewport helpers for the client shell: field of view, pixel ratio and
 * the touch-controls choice.
 */

/** Widest vertical field of view the main camera uses (portrait phones), in degrees. */
export const MAX_VERTICAL_FOV = 110;

/** Vertical FOV in degrees that gives `horizontalDeg` across a view of `aspect`. */
export function verticalFov(horizontalDeg: number, aspect: number): number {
  const h = (horizontalDeg * Math.PI) / 180;
  return (2 * Math.atan(Math.tan(h / 2) / Math.max(0.1, aspect)) * 180) / Math.PI;
}

/**
 * Main camera vertical FOV for the settings' horizontal FOV (§11) at `aspect`,
 * capped so a portrait screen does not turn into a fisheye.
 */
export function cameraFov(horizontalDeg: number, aspect: number): number {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  return Math.min(MAX_VERTICAL_FOV, verticalFov(horizontalDeg, a));
}

/** Highest device pixel ratio drawn at before render scale (§12). */
export const MAX_PIXEL_RATIO = 2;

/** `min(dpr, 2) × renderScale`, never below 0.25. */
export function defaultPixelRatio(devicePixelRatio: number, renderScale: number): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const scale = Number.isFinite(renderScale) && renderScale > 0 ? renderScale : 1;
  return Math.max(0.25, Math.min(dpr, MAX_PIXEL_RATIO) * scale);
}

/** Touch controls are on for coarse pointers, forced with `?touch=1`, off with `?touch=0`. */
export function wantsTouch(coarsePointer: boolean, search: string): boolean {
  const param = new URLSearchParams(search).get('touch');
  if (param === '1') return true;
  if (param === '0') return false;
  return coarsePointer;
}
