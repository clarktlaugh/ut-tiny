/**
 * Free-fly debug camera (docs/DESIGN.md §8.3, §18.3).
 *
 * The motion model (`stepDebugCamera`) is pure so it can be tested in Node.
 * `DebugCameraControls` binds it to keyboard and mouse:
 * - WASD move, E / Space up, Q / C down, Shift ×4 speed, mouse wheel changes base speed;
 * - hold the right mouse button (or use pointer lock) to look around;
 * - `[` / `]` cycle the map's named cameras (`MapDef.cameras`), `M` toggles markers.
 *
 * Angles: yaw 0 looks toward −Z, positive yaw turns left (toward −X); positive
 * pitch looks up. Matches `Pose` and pawn yaw/pitch.
 */
import type { PerspectiveCamera } from 'three';
import type { CameraDef, Pose } from '../../sim/types';

export interface DebugCameraInput {
  /** −1..1, forward along the view direction. */
  forward: number;
  /** −1..1, strafe right. */
  right: number;
  /** −1..1, world up. */
  up: number;
  /** Speed multiplier this frame (e.g. 4 while Shift is held). */
  boost: number;
  /** Mouse delta in pixels since the last step. */
  lookDX: number;
  lookDY: number;
}

export interface DebugCameraSettings {
  /** Base speed in m/s. */
  speed: number;
  /** Radians per pixel of mouse motion. */
  sensitivity: number;
}

export const DEFAULT_DEBUG_CAMERA_SETTINGS: Readonly<DebugCameraSettings> = {
  speed: 20,
  sensitivity: 0.0025,
};

export const IDLE_INPUT: Readonly<DebugCameraInput> = {
  forward: 0,
  right: 0,
  up: 0,
  boost: 1,
  lookDX: 0,
  lookDY: 0,
};

const PITCH_LIMIT = Math.PI / 2 - 0.01;

/** Unit view direction for yaw/pitch. */
export function viewDirection(yaw: number, pitch: number): { x: number; y: number; z: number } {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}

/** Advance a pose by one frame of input. Returns a new pose. */
export function stepDebugCamera(
  pose: Readonly<Pose>,
  input: Readonly<DebugCameraInput>,
  dt: number,
  settings: Readonly<DebugCameraSettings> = DEFAULT_DEBUG_CAMERA_SETTINGS,
): Pose {
  const yaw = pose.yaw - input.lookDX * settings.sensitivity;
  const pitch = Math.max(
    -PITCH_LIMIT,
    Math.min(PITCH_LIMIT, pose.pitch - input.lookDY * settings.sensitivity),
  );
  const dist = settings.speed * input.boost * dt;
  const fwd = viewDirection(yaw, pitch);
  // Right vector is horizontal regardless of pitch.
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  const p = pose.position;
  return {
    yaw,
    pitch,
    position: {
      x: p.x + (fwd.x * input.forward + rx * input.right) * dist,
      y: p.y + (fwd.y * input.forward + input.up) * dist,
      z: p.z + (fwd.z * input.forward + rz * input.right) * dist,
    },
  };
}

/** Put a Three.js camera at a pose. */
export function applyPoseToCamera(camera: PerspectiveCamera, pose: Readonly<Pose>): void {
  camera.position.set(pose.position.x, pose.position.y, pose.position.z);
  camera.rotation.order = 'YXZ';
  camera.rotation.set(pose.pitch, pose.yaw, 0);
  camera.updateMatrixWorld();
}

/** A pose looking from `eye` at `target`. */
export function lookAtPose(
  eye: { x: number; y: number; z: number },
  target: { x: number; y: number; z: number },
): Pose {
  const dx = target.x - eye.x;
  const dy = target.y - eye.y;
  const dz = target.z - eye.z;
  const horiz = Math.hypot(dx, dz);
  return {
    position: { ...eye },
    yaw: Math.atan2(-dx, -dz),
    pitch: Math.atan2(dy, horiz),
  };
}

export interface DebugCameraControlsOptions {
  /** Element that receives mouse input (usually the canvas). */
  element: HTMLElement;
  /** Target for keyboard events (default `window`). */
  keyTarget?: EventTarget;
  cameras?: readonly CameraDef[];
  initialPose?: Pose;
  settings?: Partial<DebugCameraSettings>;
  /** Called when `M` is pressed. */
  onToggleMarkers?: () => void;
  /** Called when a named camera is selected. */
  onSelectCamera?: (camera: CameraDef) => void;
}

/** Keyboard + mouse binding for the debug camera. Call `update(dt)` once per frame. */
export class DebugCameraControls {
  pose: Pose;
  readonly settings: DebugCameraSettings;
  private readonly keys = new Set<string>();
  private lookDX = 0;
  private lookDY = 0;
  private dragging = false;
  private cameraIndex = -1;
  private readonly cleanups: (() => void)[] = [];

  constructor(private readonly options: DebugCameraControlsOptions) {
    this.settings = { ...DEFAULT_DEBUG_CAMERA_SETTINGS, ...options.settings };
    this.pose = options.initialPose ?? { position: { x: 0, y: 10, z: 30 }, yaw: 0, pitch: 0 };
    const el = options.element;
    const keyTarget = options.keyTarget ?? window;
    this.listen(keyTarget, 'keydown', (e) => this.onKey(e as KeyboardEvent, true));
    this.listen(keyTarget, 'keyup', (e) => this.onKey(e as KeyboardEvent, false));
    this.listen(keyTarget, 'blur', () => this.keys.clear());
    this.listen(el, 'contextmenu', (e) => e.preventDefault());
    this.listen(el, 'mousedown', (e) => {
      if ((e as MouseEvent).button === 2) this.dragging = true;
    });
    this.listen(window, 'mouseup', (e) => {
      if ((e as MouseEvent).button === 2) this.dragging = false;
    });
    this.listen(window, 'mousemove', (e) => {
      const m = e as MouseEvent;
      if (this.dragging || document.pointerLockElement === el) {
        this.lookDX += m.movementX;
        this.lookDY += m.movementY;
      }
    });
    this.listen(
      el,
      'wheel',
      (e) => {
        e.preventDefault();
        const factor = (e as WheelEvent).deltaY < 0 ? 1.25 : 0.8;
        this.settings.speed = Math.min(500, Math.max(1, this.settings.speed * factor));
      },
      { passive: false },
    );
  }

  /** Jump to a named camera by index (wraps). */
  selectCamera(index: number): void {
    const cams = this.options.cameras ?? [];
    if (cams.length === 0) return;
    this.cameraIndex = ((index % cams.length) + cams.length) % cams.length;
    const cam = cams[this.cameraIndex];
    if (!cam) return;
    this.pose = {
      position: { ...cam.pose.position },
      yaw: cam.pose.yaw,
      pitch: cam.pose.pitch,
    };
    this.options.onSelectCamera?.(cam);
  }

  /** Advance by `dt` seconds using the keys and mouse motion since the last call. */
  update(dt: number): Pose {
    const k = (code: string): number => (this.keys.has(code) ? 1 : 0);
    const input: DebugCameraInput = {
      forward: k('KeyW') - k('KeyS'),
      right: k('KeyD') - k('KeyA'),
      up: Math.min(1, k('KeyE') + k('Space')) - Math.min(1, k('KeyQ') + k('KeyC')),
      boost: this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 4 : 1,
      lookDX: this.lookDX,
      lookDY: this.lookDY,
    };
    this.lookDX = 0;
    this.lookDY = 0;
    this.pose = stepDebugCamera(this.pose, input, dt, this.settings);
    return this.pose;
  }

  dispose(): void {
    for (const off of this.cleanups) off();
    this.cleanups.length = 0;
    this.keys.clear();
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (down) {
      if (e.code === 'BracketRight') this.selectCamera(this.cameraIndex + 1);
      else if (e.code === 'BracketLeft') this.selectCamera(this.cameraIndex - 1);
      else if (e.code === 'KeyM') this.options.onToggleMarkers?.();
      this.keys.add(e.code);
    } else {
      this.keys.delete(e.code);
    }
  }

  private listen(
    target: EventTarget,
    type: string,
    fn: (e: Event) => void,
    opts?: AddEventListenerOptions,
  ): void {
    target.addEventListener(type, fn, opts);
    this.cleanups.push(() => target.removeEventListener(type, fn, opts));
  }
}
