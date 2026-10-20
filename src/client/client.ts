/**
 * Client shell (docs/DESIGN.md §8, §8.3, §8.4): the one reusable client every
 * demo and, later, the game runs on.
 *
 * `createClient` builds a `World` (P29) unless one is given, runs it in a
 * `LocalSession`, takes the local player's input from `PlayerController`
 * (keyboard and mouse with pointer lock) or, on touch devices, the P27 touch
 * controls, mirrors the world with `SceneView`, resolves the view target,
 * draws the first-person view model and plays audio from the tick events. It
 * handles resize, pause on blur and audio resume on the first gesture.
 *
 * Extra layers (FX, HUD, overlays, debug panels) mount through `use(plugin)`
 * without editing the shell; see `plugins.ts` for FX and HUD adapters.
 */
import { PCFShadowMap, WebGLRenderer, type PerspectiveCamera, type Scene } from 'three';
import { AudioSystem, ThreeAudioBackend, resumeOnGesture, type AudioBackend } from '../audio';
import { SettingsStore } from '../app/settings';
import { PlayerController } from '../controllers/player/playerController';
import { attachPlayerInput, type PlayerInputBinding } from '../controllers/player/pointerLock';
import { TouchController } from '../controllers/touch/touchController';
import { TouchInput } from '../controllers/touch/touchInput';
import { TouchOverlay } from '../controllers/touch/overlay';
import { loadTouchSettings, type TouchSettings } from '../controllers/touch/touchSettings';
import { PICKUPS } from '../data/pickups';
import { WEAPONS } from '../data/weapons';
import { LAUNDRY_ROOM } from '../maps/laundry-room';
import { LoopbackTransport } from '../net/loopback';
import type { Unsubscribe } from '../net/transport';
import { SceneView } from '../render/scene/sceneView';
import type { ViewTarget, ViewTargetResolver, ViewTargetSettings } from '../render/viewTarget';
import { ViewModel, type ViewModelRenderer } from '../render/viewmodel/viewModel';
import type { FrameScheduler, PauseReason } from '../session/gameLoop';
import { LocalSession } from '../session/localSession';
import { createWorld } from '../sim/world';
import type {
  Controller,
  MapDef,
  PawnId,
  PawnState,
  PlayerProfile,
  Pose,
  RulesConfig,
  SimEvent,
  World,
  WorldState,
} from '../sim/types';
import {
  DEFAULT_VIEW_TARGET_SETTINGS,
  DefaultViewTargetResolver,
  cameraPoseFor,
  findPawn,
} from './viewTarget';
import { cameraFov, defaultPixelRatio, wantsTouch } from './viewport';

/** Rules for a free-play client: no limits, weapon stay, the §6 defaults otherwise. */
export const CLIENT_RULES: Readonly<RulesConfig> = Object.freeze({
  fragLimit: 0,
  timeLimit: 0,
  weaponStay: true,
  spawnProtection: 2,
  respawnDelay: 1,
  udamageEnabled: true,
});

/** What the client needs from a renderer (`WebGLRenderer` satisfies it; tests pass a fake). */
export interface ClientRenderer extends ViewModelRenderer {
  setPixelRatio(ratio: number): void;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  dispose(): void;
}

/** Something that can be shown above the canvas (the touch controls). */
export interface ClientInputOverlay {
  mount(root: HTMLElement): void;
  unmount(): void;
}

/** One rendered frame, as plugins see it. */
export interface ClientFrame {
  /** Seconds since the previous frame (clamped to 0.1). */
  readonly dt: number;
  /** Interpolation factor between `prev` and `state`. */
  readonly alpha: number;
  readonly prev: Readonly<WorldState> | null;
  readonly state: Readonly<WorldState>;
  readonly localPawn: PawnId;
  /** The local pawn in `state`, if it exists. */
  readonly pawn: Readonly<PawnState> | undefined;
  readonly target: Readonly<ViewTarget>;
  readonly pose: Readonly<Pose>;
  readonly camera: PerspectiveCamera;
}

/**
 * A layer mounted on the client. Every hook is optional. `tick` runs after
 * each simulation tick with its events; `frame` runs each frame after the
 * camera is placed and before drawing; `afterRender` after the world and the
 * view model are drawn; `resize` with the new drawing size.
 */
export interface ClientPlugin {
  tick?(events: readonly SimEvent[], state: Readonly<WorldState>): void;
  frame?(frame: ClientFrame): void;
  afterRender?(frame: ClientFrame): void;
  resize?(width: number, height: number): void;
  /** Called when the plugin is removed or the client disposed. */
  dispose?(): void;
}

/** Minimal window the client listens to (resize, blur, visibility, gestures). */
export type ClientWindow = Pick<
  Window,
  | 'addEventListener'
  | 'removeEventListener'
  | 'dispatchEvent'
  | 'innerWidth'
  | 'innerHeight'
  | 'devicePixelRatio'
>;

export interface ClientOptions {
  canvas: HTMLCanvasElement;
  /** Map to load when no `world` is given (default the laundry room). */
  map?: MapDef;
  seed?: number;
  rules?: RulesConfig;
  /** A world to run instead of building one with `createWorld`. */
  world?: World;
  /** The local player's profile. */
  profile?: PlayerProfile;
  /** Shared settings; defaults to a store backed by localStorage. */
  settings?: SettingsStore;
  /** Touch controls on or off; defaults to a coarse pointer, overridden by `?touch=1` / `?touch=0`. */
  touch?: boolean;
  touchSettings?: Readonly<TouchSettings>;
  /**
   * Where input overlays go. A demo shell passes its `setInputOverlay`; by
   * default the overlay mounts into `overlayRoot`.
   */
  mountInputOverlay?: (overlay: ClientInputOverlay | null) => void;
  /** Parent for input overlays when `mountInputOverlay` is not given (default `document.body`). */
  overlayRoot?: HTMLElement;
  /** Defaults to a `WebGLRenderer` on `canvas`. */
  renderer?: ClientRenderer;
  /** Shadows on the default renderer (default true). */
  shadows?: boolean;
  /** Antialiasing on the default renderer (default true). */
  antialias?: boolean;
  /** Device pixel ratio to draw at; default `min(dpr, 2) × settings.renderScale`. */
  pixelRatio?: () => number;
  /** Drawing size in CSS pixels; default the window's inner size. */
  size?: () => { width: number; height: number };
  /** Audio backend, or false for none; defaults to a `ThreeAudioBackend`. */
  audio?: AudioBackend | false;
  viewTargetResolver?: ViewTargetResolver;
  viewTargetSettings?: Readonly<ViewTargetSettings>;
  window?: ClientWindow;
  document?: Document;
  /** Frame scheduler for the loop (default `requestAnimationFrame`). */
  scheduler?: FrameScheduler;
  /** Pause while the window is blurred or the page hidden (default true). */
  pauseOnBlur?: boolean;
  /** Start the loop right away (default true). */
  autoStart?: boolean;
  /** Called when pointer lock is gained or lost on desktop. */
  onLockChange?: (locked: boolean) => void;
}

export interface Client {
  readonly world: World;
  readonly session: LocalSession;
  readonly settings: SettingsStore;
  readonly localPawn: PawnId;
  readonly player: PlayerController;
  /** The touch controller when touch controls are on, else null. */
  readonly touch: TouchController | null;
  /** The controller feeding the local pawn (touch or player). */
  readonly controller: Controller;
  readonly view: SceneView;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly viewModel: ViewModel;
  readonly renderer: ClientRenderer;
  readonly audio: AudioSystem | null;
  /** Pointer-lock binding (desktop only). */
  readonly pointer: PlayerInputBinding | null;
  /** The view target of the last frame. */
  readonly target: Readonly<ViewTarget> | null;
  /** Resolves after the first frame is drawn. */
  readonly firstFrame: Promise<void>;
  /** Mount a layer. Returns a function that removes it (and calls its `dispose`). */
  use(plugin: ClientPlugin): Unsubscribe;
  /** Re-measure and resize the drawing buffer and cameras. */
  resize(): void;
  start(): void;
  pause(reason?: PauseReason): void;
  resume(reason?: PauseReason): void;
  dispose(): void;
}

function globalWindow(): ClientWindow | undefined {
  return typeof window === 'undefined' ? undefined : window;
}

function globalDocument(): Document | undefined {
  return typeof document === 'undefined' ? undefined : document;
}

function coarsePointer(win: ClientWindow | undefined): boolean {
  const mm = (win as Partial<Window> | undefined)?.matchMedia;
  if (typeof mm !== 'function') return false;
  try {
    return mm.call(win, '(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

function search(win: ClientWindow | undefined): string {
  return (win as Partial<Window> | undefined)?.location?.search ?? '';
}

export async function createClient(options: ClientOptions): Promise<Client> {
  const map = options.world?.options.map ?? options.map ?? LAUNDRY_ROOM;
  const world =
    options.world ??
    (await createWorld({
      map,
      seed: options.seed ?? 1,
      rules: options.rules ?? CLIENT_RULES,
      weapons: WEAPONS,
      pickups: PICKUPS,
    }));
  return new ClientImpl(options, world, map);
}

class ClientImpl implements Client {
  readonly world: World;
  readonly session: LocalSession;
  readonly settings: SettingsStore;
  readonly localPawn: PawnId;
  readonly player: PlayerController;
  readonly touch: TouchController | null;
  readonly controller: Controller;
  readonly view: SceneView;
  readonly viewModel: ViewModel;
  readonly renderer: ClientRenderer;
  readonly audio: AudioSystem | null;
  readonly pointer: PlayerInputBinding | null;
  readonly firstFrame: Promise<void>;

  private readonly win: ClientWindow | undefined;
  private readonly options: ClientOptions;
  private readonly plugins = new Set<ClientPlugin>();
  private readonly resolver: ViewTargetResolver;
  private readonly vtSettings: Readonly<ViewTargetSettings>;
  private readonly cleanups: (() => void)[] = [];
  private readonly ownsRenderer: boolean;
  private prev: Readonly<WorldState> | null = null;
  private curr: Readonly<WorldState>;
  private pose: Pose | null = null;
  private lastFrameMs: number | null = null;
  private currentTarget: Readonly<ViewTarget> | null = null;
  private resolveFirstFrame!: () => void;
  private framesDrawn = 0;
  private disposed = false;

  constructor(options: ClientOptions, world: World, map: MapDef) {
    this.options = options;
    this.world = world;
    this.win = options.window ?? globalWindow();
    const doc = options.document ?? globalDocument();
    this.settings = options.settings ?? new SettingsStore();
    this.resolver = options.viewTargetResolver ?? new DefaultViewTargetResolver();
    this.vtSettings = options.viewTargetSettings ?? DEFAULT_VIEW_TARGET_SETTINGS;
    this.firstFrame = new Promise((resolve) => {
      this.resolveFirstFrame = resolve;
    });

    // Session and the local participant.
    this.session = new LocalSession({
      world,
      transport: new LoopbackTransport({
        profile: options.profile ?? { name: 'Player', isBot: false },
      }),
      ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    });
    this.localPawn = this.session.localPawnId;
    this.curr = world.getState();

    // Input: keyboard + mouse, with touch merged in on touch devices.
    this.player = new PlayerController({ pawnId: this.localPawn, settings: this.settings.get() });
    this.cleanups.push(this.settings.subscribe((s) => this.player.setSettings(s)));
    const touchOn = options.touch ?? wantsTouch(coarsePointer(this.win), search(this.win));
    if (touchOn) {
      const input = new TouchInput();
      this.touch = new TouchController({
        player: this.player,
        input,
        settings: options.touchSettings ?? loadTouchSettings(),
      });
      const overlay = new TouchOverlay({ input });
      if (options.mountInputOverlay) {
        const mount = options.mountInputOverlay;
        mount(overlay);
        this.cleanups.push(() => mount(null));
      } else {
        const root = options.overlayRoot ?? doc?.body;
        if (root) {
          overlay.mount(root);
          this.cleanups.push(() => overlay.unmount());
        }
      }
      this.pointer = null;
    } else {
      this.touch = null;
      this.pointer = doc
        ? attachPlayerInput(this.player.input, {
            element: options.canvas,
            document: doc,
            ...(this.win ? { window: this.win } : {}),
            ...(options.onLockChange ? { onLockChange: options.onLockChange } : {}),
          })
        : null;
      const pointer = this.pointer;
      if (pointer) this.cleanups.push(() => pointer.detach());
    }
    this.controller = this.touch ?? this.player;
    this.session.addController(this.controller);

    // Rendering.
    this.ownsRenderer = !options.renderer;
    this.renderer = options.renderer ?? this.createRenderer(options);
    this.view = new SceneView(map, { showMarkers: false, fov: 75 });
    this.viewModel = new ViewModel();

    // Audio.
    this.audio = this.createAudio(options);

    // Resize.
    const onResize = (): void => this.resize();
    if (this.win) {
      this.win.addEventListener('resize', onResize);
      this.win.addEventListener('orientationchange', onResize);
      const w = this.win;
      this.cleanups.push(() => {
        w.removeEventListener('resize', onResize);
        w.removeEventListener('orientationchange', onResize);
      });
    }
    this.cleanups.push(this.settings.subscribe(() => this.resize()));
    this.resize();

    // Loop.
    this.cleanups.push(
      this.session.onTick((events, state) => this.onTick(events, state)),
      this.session.onFrame((alpha) => this.onFrame(alpha)),
    );
    if (options.pauseOnBlur !== false && this.win && doc) {
      this.cleanups.push(this.session.pauseOnBlur(this.win, doc));
    }
    if (options.autoStart !== false) this.start();
  }

  get scene(): Scene {
    return this.view.scene;
  }

  get camera(): PerspectiveCamera {
    return this.view.camera;
  }

  get target(): Readonly<ViewTarget> | null {
    return this.currentTarget;
  }

  use(plugin: ClientPlugin): Unsubscribe {
    if (this.disposed) return () => {};
    this.plugins.add(plugin);
    plugin.resize?.(...this.measure());
    return () => {
      if (this.plugins.delete(plugin)) plugin.dispose?.();
    };
  }

  resize(): void {
    if (this.disposed) return;
    const [w, h] = this.measure();
    const s = this.settings.get();
    const ratio = this.options.pixelRatio
      ? this.options.pixelRatio()
      : defaultPixelRatio(this.win?.devicePixelRatio ?? 1, s.renderScale);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    this.view.resize(w, h);
    this.view.camera.fov = cameraFov(s.fov, w / h);
    this.view.camera.updateProjectionMatrix();
    this.viewModel.resize(w, h);
    for (const p of [...this.plugins]) p.resize?.(w, h);
  }

  start(): void {
    if (!this.disposed) this.session.start();
  }

  pause(reason?: PauseReason): void {
    this.session.pause(reason);
  }

  resume(reason?: PauseReason): void {
    this.session.resume(reason);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.session.close();
    for (const p of [...this.plugins]) p.dispose?.();
    this.plugins.clear();
    for (const c of this.cleanups.splice(0)) c();
    this.viewModel.dispose();
    this.view.dispose();
    this.audio?.dispose();
    if (this.ownsRenderer) this.renderer.dispose();
  }

  private measure(): [number, number] {
    const size = this.options.size?.();
    const w = size?.width ?? this.win?.innerWidth ?? 1280;
    const h = size?.height ?? this.win?.innerHeight ?? 720;
    return [Math.max(1, Math.round(w)), Math.max(1, Math.round(h))];
  }

  private createRenderer(options: ClientOptions): ClientRenderer {
    const renderer = new WebGLRenderer({
      canvas: options.canvas,
      antialias: options.antialias ?? true,
      powerPreference: 'high-performance',
    });
    renderer.shadowMap.enabled = options.shadows ?? true;
    renderer.shadowMap.type = PCFShadowMap;
    return renderer;
  }

  private createAudio(options: ClientOptions): AudioSystem | null {
    if (options.audio === false) return null;
    let backend: AudioBackend;
    if (options.audio) {
      backend = options.audio;
    } else {
      try {
        const three = new ThreeAudioBackend();
        this.view.camera.add(three.listener);
        this.view.scene.add(three.root);
        backend = three;
      } catch {
        // No Web Audio (old browser, some headless runs): play silently.
        return null;
      }
    }
    const audio = new AudioSystem(backend, { volume: this.settings.get().volume });
    this.cleanups.push(this.settings.subscribe((s) => audio.setVolume(s.volume)));
    if (this.win) {
      this.cleanups.push(resumeOnGesture(this.win, backend));
    }
    audio.preload();
    return audio;
  }

  private onTick(events: readonly SimEvent[], state: Readonly<WorldState>): void {
    this.prev = this.curr;
    this.curr = state;
    this.view.handleEvents(events);
    this.viewModel.handleEvents(events, this.localPawn);
    this.audio?.handleTick(events, state, this.localPawn);
    for (const p of [...this.plugins]) p.tick?.(events, state);
  }

  private onFrame(alpha: number): void {
    const now = typeof performance === 'undefined' ? Date.now() : performance.now();
    const dt = this.lastFrameMs === null ? 0 : Math.min(0.1, (now - this.lastFrameMs) / 1000);
    this.lastFrameMs = now;
    const state = this.curr;

    this.view.sync(this.prev, state, alpha);
    const pawn = findPawn(state, this.localPawn);
    const target = this.resolver.resolve(state, this.localPawn, this.vtSettings);
    this.currentTarget = target;

    // Hide our own body while looking through its eyes; show it from the disc or warhead.
    const body = this.view.objectFor(this.localPawn);
    if (body) body.visible = target.kind !== 'pawn';

    const look = this.player.view;
    const position = this.view.objectFor(target.entityId)?.position;
    const pose = cameraPoseFor({ target, state, position, look, previous: this.pose }) ??
      this.pose ?? { ...this.view.defaultPose() };
    this.pose = { position: { ...pose.position }, yaw: pose.yaw, pitch: pose.pitch };
    this.view.setCameraPose(this.pose);

    const frame: ClientFrame = {
      dt,
      alpha,
      prev: this.prev,
      state,
      localPawn: this.localPawn,
      pawn,
      target,
      pose: this.pose,
      camera: this.view.camera,
    };
    for (const p of [...this.plugins]) p.frame?.(frame);

    this.viewModel.update(pawn, dt, target.showViewModel);
    this.renderer.autoClear = true;
    this.renderer.render(this.view.scene, this.view.camera);
    this.viewModel.render(this.renderer);
    for (const p of [...this.plugins]) p.afterRender?.(frame);

    if (this.framesDrawn++ === 0) this.resolveFirstFrame();
  }
}
