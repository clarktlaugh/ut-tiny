/**
 * First-person view model (docs/DESIGN.md §8.3).
 *
 * The held weapon lives in its own scene with its own camera and is drawn in
 * a second pass after the world, with the depth buffer cleared in between.
 * World geometry therefore can never cover or cut into the weapon, however
 * close the player stands to a wall, and the weapon keeps a fixed field of
 * view when the world camera's FOV changes (zoom, settings).
 *
 * Per rendered frame:
 *   viewModel.handleEvents(eventsSinceLastFrame, localPawnId);
 *   viewModel.update(interpolatedLocalPawn, frameDt, viewTarget.showViewModel);
 *   renderer.render(world.scene, world.camera);
 *   viewModel.render(renderer);
 *
 * Bob, sway, roll, landing dip and recoil come from `ViewModelMotion`, driven
 * by the pawn's velocity and look angles. Weapon switches follow the pawn's
 * `pendingWeapon`: the current weapon lowers, swaps at the bottom, and the new
 * one raises, which together roughly match the 0.3 s switch time (§5).
 */
import {
  AmbientLight,
  DirectionalLight,
  Group,
  HemisphereLight,
  PerspectiveCamera,
  Scene,
  type Camera,
  type Object3D,
} from 'three';
import {
  NO_ENTITY,
  type PawnId,
  type PawnState,
  type SimEvent,
  type WeaponId,
} from '../../sim/types';
import { MuzzleFlash, flashStyleFor } from './muzzleFlash';
import { ViewModelMotion, type MotionConfig, type MotionInput, type RecoilImpulse } from './motion';
import { WeaponModelLibrary, type WeaponModel } from './weaponModels';

/** The subset of `WebGLRenderer` the view-model pass uses (kept small for tests). */
export interface ViewModelRenderer {
  autoClear: boolean;
  clearDepth(): void;
  render(scene: Object3D, camera: Camera): void;
}

/** Pawn fields the view model reads. `PawnState` satisfies it. */
export type ViewModelPawn = Pick<
  PawnState,
  | 'alive'
  | 'velocity'
  | 'yaw'
  | 'pitch'
  | 'grounded'
  | 'crouching'
  | 'weapon'
  | 'pendingWeapon'
  | 'zoom'
  | 'guiding'
  | 'viewingDisc'
>;

export interface ViewModelOptions {
  /** Vertical FOV of the view-model camera in degrees (default 58). */
  fov?: number;
  /** Initial aspect ratio (default 16 / 9). */
  aspect?: number;
  /** Override motion tuning. */
  motion?: Partial<MotionConfig>;
}

/** Rest position of the weapon grip in view-model camera space (right hand, below center). */
export const WEAPON_REST = Object.freeze({ x: 0.16, y: -0.15, z: -0.36 });

/** View-model camera clip planes. The rest pose and motion limits keep the weapon inside them. */
export const VIEWMODEL_NEAR = 0.01;
export const VIEWMODEL_FAR = 10;

/** Recoil per weapon and fire mode (§5). Unlisted modes do not kick. */
export const RECOIL: Readonly<
  Partial<Record<WeaponId, Partial<Record<'primary' | 'alt', RecoilImpulse>>>>
> = {
  teleporter: { primary: { back: 0.15, pitch: 0.6 } },
  assault: { primary: { back: 0.2, pitch: 0.5 }, alt: { back: 0.45, pitch: 1.6 } },
  mines: { primary: { back: 0.3, pitch: 1.2 } },
  rocket: { primary: { back: 0.7, pitch: 2.2 }, alt: { back: 0.7, pitch: 2.2 } },
  sniper: { primary: { back: 0.8, pitch: 2.8 } },
  shock: { primary: { back: 0.55, pitch: 1.8 }, alt: { back: 0.55, pitch: 1.8 } },
  shockScoped: { primary: { back: 0.55, pitch: 1.8 } },
  redeemer: { primary: { back: 1.0, pitch: 3 }, alt: { back: 1.0, pitch: 3 } },
};

/**
 * Whether the view model should be drawn for this pawn: alive, holding (or
 * switching to) a weapon, not scoped in, not guiding a warhead or watching
 * the disc cam, and the view target allows it.
 */
export function viewModelVisible(
  pawn: Readonly<ViewModelPawn> | undefined,
  targetAllows = true,
): boolean {
  if (!pawn || !targetAllows) return false;
  if (!pawn.alive) return false;
  if (pawn.weapon === null && pawn.pendingWeapon === null) return false;
  if (pawn.zoom > 1) return false;
  if (pawn.guiding !== NO_ENTITY || pawn.viewingDisc) return false;
  return true;
}

export class ViewModel {
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly motion: ViewModelMotion;
  readonly flash = new MuzzleFlash();

  /** Moves with bob/sway/recoil; parent of the current weapon. */
  private readonly rig = new Group();
  private readonly library = new WeaponModelLibrary();
  private current: WeaponModel | null = null;
  private shown = false;
  private disposed = false;
  private readonly motionInput: MotionInput = {
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    grounded: true,
    crouching: false,
  };

  constructor(options: ViewModelOptions = {}) {
    this.camera = new PerspectiveCamera(
      options.fov ?? 58,
      options.aspect ?? 16 / 9,
      VIEWMODEL_NEAR,
      VIEWMODEL_FAR,
    );
    this.motion = new ViewModelMotion(options.motion);
    this.scene.name = 'viewmodel';
    this.rig.name = 'viewmodelRig';
    this.scene.add(this.camera, this.rig, this.flash.object);

    // Lights fixed in view space: the weapon reads the same wherever you look.
    const key = new DirectionalLight(0xfff2e0, 2.2);
    key.position.set(0.6, 1, 0.8);
    const rim = new DirectionalLight(0xbcd4ff, 0.9);
    rim.position.set(-1, 0.4, -0.6);
    this.scene.add(
      key,
      rim,
      new HemisphereLight(0xdde6ff, 0x3a3226, 0.8),
      new AmbientLight(0xffffff, 0.15),
    );
    this.rig.visible = false;
  }

  /** Weapon currently drawn (may lag `pawn.weapon` during a switch). */
  get displayedWeapon(): WeaponId | null {
    return this.current?.id ?? null;
  }

  /** Whether the last `update` decided to draw the view model. */
  get visible(): boolean {
    return this.shown;
  }

  /** Muzzle socket of the displayed weapon, if any. */
  get muzzle(): Object3D | null {
    return this.current?.muzzle ?? null;
  }

  resize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /**
   * React to sim events for the local pawn: recoil and muzzle flash on
   * `shotFired`, landing dip on `land`, and a fresh draw on `respawn`.
   */
  handleEvents(events: readonly SimEvent[], localPawn: PawnId): void {
    for (const e of events) {
      switch (e.type) {
        case 'shotFired': {
          if (e.pawn !== localPawn) break;
          const kick = RECOIL[e.weapon]?.[e.mode];
          if (kick) this.motion.recoil(kick);
          if (this.shown) this.flash.trigger(flashStyleFor(e.weapon, e.mode));
          break;
        }
        case 'land':
          if (e.pawn === localPawn) this.motion.land(e.impactSpeed);
          break;
        case 'respawn':
          if (e.pawn === localPawn) {
            this.motion.reset();
            this.flash.stop();
            this.setWeapon(null);
          }
          break;
        default:
          break;
      }
    }
  }

  /**
   * Advance by `dt` seconds of render time for the local pawn (interpolated
   * between ticks by the caller). `targetAllows` is `ViewTarget.showViewModel`.
   */
  update(pawn: Readonly<ViewModelPawn> | undefined, dt: number, targetAllows = true): void {
    if (this.disposed) return;
    const show = viewModelVisible(pawn, targetAllows);
    if (!pawn || !show) {
      if (this.shown) this.flash.stop();
      this.shown = false;
      this.rig.visible = false;
      // Next time it is shown, start from the held weapon without animating a switch.
      if (pawn && pawn.alive) this.setWeapon(pawn.pendingWeapon ?? pawn.weapon);
      this.motion.setLowerTarget(0);
      this.motion.setLower(0);
      this.motion.reset();
      return;
    }

    const target = pawn.pendingWeapon ?? pawn.weapon;
    if (this.current === null) {
      // First draw (spawn, or first weapon): start lowered and raise it.
      this.setWeapon(target);
      this.motion.setLower(1);
    }
    if (this.current?.id !== target) {
      this.motion.setLowerTarget(1);
      if (this.motion.lower >= 1) this.setWeapon(target);
    }
    if (this.current?.id === target) this.motion.setLowerTarget(0);

    const input = this.motionInput;
    input.velocity = pawn.velocity;
    input.yaw = pawn.yaw;
    input.pitch = pawn.pitch;
    input.grounded = pawn.grounded;
    input.crouching = pawn.crouching;
    const o = this.motion.step(input, dt);

    this.rig.position.set(WEAPON_REST.x + o.x, WEAPON_REST.y + o.y, WEAPON_REST.z + o.z);
    this.rig.rotation.set(o.pitch, o.yaw, o.roll, 'YXZ');
    this.rig.visible = this.current !== null;
    this.shown = true;
    this.flash.update(dt, this.current?.muzzle ?? null);
  }

  /**
   * Draw the view model over whatever the renderer drew last. Clears depth
   * first so world geometry never occludes or intersects the weapon. Does
   * nothing while hidden.
   */
  render(renderer: ViewModelRenderer): void {
    if (this.disposed || !this.shown || !this.rig.visible) return;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = autoClear;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.setWeapon(null);
    this.flash.dispose();
    this.library.dispose();
    this.scene.clear();
  }

  private setWeapon(id: WeaponId | null): void {
    if (this.current?.id === id) return;
    if (this.current) this.current.root.removeFromParent();
    this.current = id === null ? null : this.library.get(id);
    if (this.current) this.rig.add(this.current.root);
  }
}
