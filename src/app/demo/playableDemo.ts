/**
 * The playable laundry-room demo: `DemoWorld` driven by a `LocalSession`,
 * the local player on keyboard + mouse (pointer lock) or touch, target
 * dummies, first-person camera and view model, FX, HUD and audio.
 *
 * This is the M2 "core combat" milestone on one page (docs/DESIGN.md §13),
 * built from the merged packets. The real match flow (menus, bots, rules)
 * replaces it later; nothing here is a contract.
 */
import { PCFShadowMap, WebGLRenderer } from 'three';
import { AudioSystem, ThreeAudioBackend, resumeOnGesture } from '../../audio';
import { PlayerController, attachPlayerInput } from '../../controllers/player';
import { LAUNDRY_ROOM } from '../../maps/laundry-room';
import { LoopbackTransport } from '../../net/loopback';
import { WEAPONS } from '../../data/weapons';
import { FxSystem, raycastProbe } from '../../render/fx';
import { Hud, injectHudStyle, type HudNode } from '../../render/hud';
import { SceneView } from '../../render/scene';
import { ViewModel } from '../../render/viewmodel';
import { LocalSession } from '../../session/localSession';
import {
  NULL_INPUT,
  type Controller,
  type InputCommand,
  type PawnId,
  type PawnState,
  type SimEvent,
  type Tick,
  type WorldState,
} from '../../sim/types';
import { eyePosition } from '../../sim/weapons/core';
import { SettingsStore } from '../settings';
import { DemoWorld } from './demoWorld';
import { DummyController } from './dummyController';
import { DemoOverlay } from './overlay';
import { TOUCH_LOOK_RADIANS_PER_PX, TouchControls } from './touchControls';

export interface PlayableDemoOptions {
  canvas: HTMLCanvasElement;
  /** Parent for the HUD and touch controls (usually `document.body`). */
  root: HTMLElement;
  seed?: number;
  dummies?: number;
}

export interface PlayableDemo {
  world: DemoWorld;
  session: LocalSession;
  localPawn: PawnId;
  dispose(): void;
}

const DUMMY_NAMES = ['Lint', 'Sock', 'Bleach', 'Dryer Sheet', 'Clothespin'];

/** The player's controller with touch input merged in when the device has it. */
class LocalController implements Controller {
  readonly pawnId: PawnId;
  constructor(
    private readonly player: PlayerController,
    private readonly touch: TouchControls,
  ) {
    this.pawnId = player.pawnId;
  }

  produce(tick: Tick, state: Readonly<WorldState>): InputCommand {
    if (this.touch.enabled) {
      const look = this.touch.takeLook();
      const v = this.player.view;
      this.player.setView(
        v.yaw - look.dx * TOUCH_LOOK_RADIANS_PER_PX,
        v.pitch - look.dy * TOUCH_LOOK_RADIANS_PER_PX,
      );
    }
    const cmd = this.player.produce(tick, state);
    if (this.touch.enabled) {
      const s = this.touch.stick;
      if (Math.abs(s.x) + Math.abs(s.y) > 0.05) {
        cmd.moveX = clamp(s.x);
        cmd.moveY = clamp(s.y);
      }
      cmd.buttons |= this.touch.takeButtons() | this.touch.takeEdges();
    }
    return cmd;
  }
}

function clamp(v: number): number {
  return Math.max(-1, Math.min(1, v));
}

/** Vertical FOV in degrees for a horizontal FOV at an aspect ratio. */
export function verticalFov(horizontalDeg: number, aspect: number): number {
  const h = (horizontalDeg * Math.PI) / 180;
  return (2 * Math.atan(Math.tan(h / 2) / Math.max(0.1, aspect)) * 180) / Math.PI;
}

function findPawn(state: Readonly<WorldState>, id: PawnId): PawnState | undefined {
  for (const e of state.entities) if (e.id === id && e.kind === 'pawn') return e;
  return undefined;
}

export async function startPlayableDemo(options: PlayableDemoOptions): Promise<PlayableDemo> {
  const { canvas, root } = options;
  const settings = new SettingsStore();
  const map = LAUNDRY_ROOM;
  const world = await DemoWorld.create({ map, seed: options.seed ?? 7 });

  // Session and participants.
  const session = new LocalSession({
    world,
    transport: new LoopbackTransport({ profile: { name: 'You', isBot: false } }),
  });
  const localPawn = session.localPawnId;
  const dummies = Math.max(0, Math.min(DUMMY_NAMES.length, options.dummies ?? 3));
  for (let i = 0; i < dummies; i++) {
    const id = world.addPlayer(`bot:${i + 1}`, { name: DUMMY_NAMES[i]!, isBot: true });
    session.addController(new DummyController({ pawnId: id, phase: i * 1.7 }));
  }

  // Input.
  const player = new PlayerController({ pawnId: localPawn, settings: settings.get() });
  settings.subscribe((s) => player.setSettings(s));
  const touch = new TouchControls(canvas, root);
  session.addController(new LocalController(player, touch));
  injectHudStyle(document);
  const hudRoot = document.createElement('div');
  root.append(hudRoot);
  const hud = new Hud(hudRoot as unknown as HudNode, document, { weapons: WEAPONS, localPawn });
  const overlay = new DemoOverlay(root, world, localPawn);
  if (touch.enabled) document.body.classList.add('touch-ui');
  const binding = attachPlayerInput(player.input, {
    element: canvas,
    document,
    window,
    onLockChange: (locked) => {
      if (!locked && !touch.enabled && !overlay.overlayVisible) {
        showStart('Paused', 'Click to keep playing.');
      }
    },
  });

  // Rendering.
  const renderer = new WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  const view = new SceneView(map, { showMarkers: false, fov: 75 });
  const fx = new FxSystem({
    seed: options.seed ?? 7,
    surface: raycastProbe([view.mapView.brushes, view.mapView.props]),
  });
  view.scene.add(fx.root);
  const viewModel = new ViewModel();

  // Audio.
  const backend = new ThreeAudioBackend();
  view.camera.add(backend.listener);
  view.scene.add(backend.root);
  const audio = new AudioSystem(backend, { volume: settings.get().volume });
  settings.subscribe((s) => audio.setVolume(s.volume));
  resumeOnGesture(window, backend.listener.context);
  audio.preload();

  function resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const scale = settings.get().renderScale * (touch.enabled ? 0.85 : 1);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, touch.enabled ? 1.5 : 2) * scale);
    renderer.setSize(w, h, false);
    view.resize(w, h);
    view.camera.fov = verticalFov(settings.get().fov, w / h);
    view.camera.updateProjectionMatrix();
    viewModel.resize(w, h);
  }
  window.addEventListener('resize', resize);
  settings.subscribe(resize);
  resize();

  // Per tick: feed everyone the events.
  let prev: Readonly<WorldState> | null = null;
  let curr: Readonly<WorldState> = world.getState();
  session.onTick((events: readonly SimEvent[], state) => {
    prev = curr;
    curr = state;
    view.handleEvents(events);
    fx.handleEvents(events, state);
    viewModel.handleEvents(events, localPawn);
    audio.handleTick(events, state, localPawn);
    hud.handleEvents(events, state);
    overlay.onEvents(events, state.time);
  });

  // Per frame: interpolate, place the camera at the eyes, draw.
  const eye = { x: 0, y: 0, z: 0 };
  let lastFrame = performance.now();
  let deathCam: { x: number; y: number; z: number; yaw: number; pitch: number } | null = null;
  session.onFrame((alpha) => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;

    view.sync(prev, curr, alpha);
    const pawn = findPawn(curr, localPawn);
    const body = view.objectFor(localPawn);
    if (body) body.visible = false;

    if (pawn?.alive && body) {
      // Interpolated capsule center from the scene object; angles from the controller (smooth).
      const e = eyePosition({ position: body.position, crouching: pawn.crouching });
      eye.x = e.x;
      eye.y = e.y;
      eye.z = e.z;
      const v = player.view;
      view.setCameraPose({ position: eye, yaw: v.yaw, pitch: v.pitch });
      deathCam = null;
    } else {
      // Death cam: stay where the eyes were.
      if (!deathCam) deathCam = { ...eye, ...player.view };
      view.setCameraPose({
        position: deathCam,
        yaw: deathCam.yaw,
        pitch: deathCam.pitch,
      });
    }

    fx.update(dt, view.camera, curr);
    overlay.setFlash(fx.screenFlash.intensity);
    viewModel.update(pawn, dt, pawn?.alive ?? false);
    renderer.render(view.scene, view.camera);
    viewModel.render(renderer);

    hud.update(curr);
    overlay.update(curr.time);
    document.body.dataset.ready = '1';
  });

  // Start / pause overlay.
  const controlsHelp = touch.enabled
    ? 'Left side: move stick. Right side: drag to look. Buttons: FIRE, ALT, JUMP, WPN (next weapon).'
    : 'WASD move, mouse look, left / right click fire, Space jump, Ctrl crouch, double-tap a direction to dodge, 1–8 or wheel to switch weapons, Esc to pause.';
  const demoLinks =
    '<small>Dev demos: <a href="/src/render/scene/demo.html">scene</a> · ' +
    '<a href="/src/render/fx/demo.html">FX</a> · ' +
    '<a href="/src/render/viewmodel/demo.html">view model</a> · ' +
    '<a href="/src/audio/demo.html">audio</a></small>';
  function showStart(title: string, lead: string): void {
    overlay.showOverlay(title, `${lead}<br>${controlsHelp}${demoLinks}`);
    session.pause('menu');
  }
  overlay.onOverlayClick(() => {
    overlay.hideOverlay();
    session.resume('menu');
    if (!touch.enabled) binding.lock();
  });
  showStart(
    'ut-tiny: Laundry Room',
    `${touch.enabled ? 'Tap' : 'Click'} to play. Assault Rifle, Rocket Launcher and Super Shock Rifle against ${dummies} target dummies.`,
  );
  const detachBlur = session.pauseOnBlur(window, document);
  session.start();

  return {
    world,
    session,
    localPawn,
    dispose() {
      detachBlur();
      session.close();
      binding.detach();
      touch.dispose();
      viewModel.dispose();
      fx.dispose();
      view.dispose();
      audio.dispose();
      renderer.dispose();
      window.removeEventListener('resize', resize);
    },
  };
}

/** Exported for tests: a command with no input. */
export const IDLE: Readonly<InputCommand> = NULL_INPUT;
