/**
 * First-person view model demo, built as `/demos/viewmodel.html`.
 *
 * Walks a fake local pawn around the Laundry Room (flat floor, no collision
 * beyond the room walls) so bob, sway, recoil, flashes and switches can be
 * judged by eye, and renders the clipping test positions.
 *
 * Controls: click to lock the mouse, WASD move, Space jump, Ctrl crouch, left
 * / right mouse fire primary / alt, 1–8 or wheel switch weapons, [ ] cycle the
 * test positions, N toggles the "naive" single-pass render (what the weapon
 * would look like without the second pass), H hides the view model.
 *
 * Query parameters (for screenshots): `pos=<name>` freezes the frame at a
 * test position (see `testPositions.ts`), `weapon=<id>` overrides its weapon,
 * `naive=1` uses the single-pass render, `t=<seconds>` sets how long the pawn
 * has been moving before the frame (default 1.3, minimum 0.2). When the first frame has
 * rendered, `document.body.dataset.ready` is `"1"`. With `pos=` the
 * What-to-check card stays closed so screenshots are clean.
 */
import { PCFShadowMap, WebGLRenderer } from 'three';
import { LAUNDRY_ROOM } from '../../maps/laundry-room';
import { SceneView } from '../../render/scene/sceneView';
import { applyPoseToCamera } from '../../render/scene/debugCamera';
import { NO_ENTITY, WeaponIds, type SimEvent, type WeaponId } from '../../sim/types';
import {
  VIEWMODEL_TEST_POSITIONS,
  testEyeHeight,
  type ViewModelTestPosition,
} from '../../render/viewmodel/testPositions';
import { DemoControls } from '../../render/viewmodel/demoControls';
import { ViewModel, fovForAspect, type ViewModelPawn } from '../../render/viewmodel/viewModel';
import { createDemoShell } from '../shell';

const canvas = document.querySelector<HTMLCanvasElement>('#scene');
const hud = document.querySelector<HTMLDivElement>('#hud');
if (!canvas || !hud) throw new Error('viewmodel.html is missing #scene or #hud');

const params = new URLSearchParams(location.search);
const frozenName = params.get('pos');
const weaponParam = params.get('weapon');
const weaponOverride = WeaponIds.find((w) => w === weaponParam);
let naive = params.get('naive') === '1';
let hidden = false;

const shell = createDemoShell({
  slug: 'viewmodel',
  showCardOnLoad: !frozenName,
  onReset: () => {
    naive = false;
    hidden = false;
    pawn.grounded = true;
    selectPosition(positionIndex);
  },
  tuning: () => ({
    position: VIEWMODEL_TEST_POSITIONS[positionIndex]?.name ?? '?',
    weapon: pawn.pendingWeapon ?? pawn.weapon ?? 'none',
    render: naive ? 'naive single pass' : 'two-pass',
    viewModelHidden: hidden,
  }),
});

const renderer = new WebGLRenderer({ canvas, antialias: shell.quality.antialias });
renderer.shadowMap.enabled = shell.quality.shadows;
// Two render passes per frame: count both in renderer.info.
renderer.info.autoReset = false;
shell.trackRenderer(renderer);
renderer.shadowMap.type = PCFShadowMap;
const WORLD_FOV = 75;
const world = new SceneView(LAUNDRY_ROOM, { showMarkers: false, fov: WORLD_FOV });
const viewModel = new ViewModel();
const LOCAL = 1;

const RUN = 8.8;
const GRAVITY = 19;
const JUMP = 6.8;
const SWITCH_TIME = 0.3;

interface DemoPawn extends ViewModelPawn {
  feet: { x: number; y: number; z: number };
}

const pawn: DemoPawn = {
  feet: { x: 0, y: 0, z: 0 },
  alive: true,
  velocity: { x: 0, y: 0, z: 0 },
  yaw: 0,
  pitch: 0,
  grounded: true,
  crouching: false,
  weapon: 'assault',
  pendingWeapon: null,
  zoom: 1,
  guiding: NO_ENTITY,
  viewingDisc: false,
};

let positionIndex = Math.max(
  0,
  VIEWMODEL_TEST_POSITIONS.findIndex((p) => p.name === frozenName),
);
let switchLeft = 0;
let tick = 0;
/** Held primary fire repeats at this many seconds per shot (§5, rough). */
const FIRE_RATE: Record<WeaponId, number> = {
  teleporter: 0.5,
  assault: 0.1,
  mines: 0.6,
  rocket: 0.9,
  sniper: 1.33,
  shock: 0.75,
  shockScoped: 0.75,
  redeemer: 2,
};
let holdingFire = false;
let fireCooldown = 0;

function placeAt(p: ViewModelTestPosition): void {
  pawn.feet = { ...p.feet };
  pawn.yaw = p.yaw;
  pawn.pitch = p.pitch;
  pawn.crouching = p.crouching ?? false;
  pawn.velocity = { x: 0, y: 0, z: 0 };
  pawn.weapon = weaponOverride ?? p.weapon;
  pawn.pendingWeapon = null;
  switchLeft = 0;
}

function eyeHeight(): number {
  return testEyeHeight({ crouching: pawn.crouching } as ViewModelTestPosition);
}

function fire(mode: 'primary' | 'alt'): void {
  const weapon = pawn.weapon;
  if (!weapon || pawn.pendingWeapon) return;
  fireCooldown = FIRE_RATE[weapon];
  const event: SimEvent = {
    type: 'shotFired',
    tick: tick++,
    pawn: LOCAL,
    weapon,
    mode,
    origin: { ...pawn.feet },
    direction: { x: 0, y: 0, z: -1 },
  };
  viewModel.handleEvents([event], LOCAL);
}

function requestWeapon(id: WeaponId): void {
  if (id === pawn.weapon || id === pawn.pendingWeapon) return;
  pawn.pendingWeapon = id;
  switchLeft = SWITCH_TIME;
}

function cycleWeapon(dir: 1 | -1): void {
  const current = WeaponIds.indexOf(pawn.pendingWeapon ?? pawn.weapon ?? 'assault');
  const next = WeaponIds[(current + dir + WeaponIds.length) % WeaponIds.length];
  if (next) requestWeapon(next);
}

// --- Input (interactive mode) ---------------------------------------------

const keys = new Set<string>();
let lookDX = 0;
let lookDY = 0;
let controls: DemoControls | null = null;

function jump(): void {
  if (!pawn.grounded) return;
  pawn.velocity.y = JUMP;
  pawn.grounded = false;
}

function selectPosition(index: number): void {
  const p = VIEWMODEL_TEST_POSITIONS[index];
  if (!p) return;
  positionIndex = index;
  placeAt(p);
}

if (!frozenName) {
  controls = new DemoControls({
    root: document.body,
    positions: VIEWMODEL_TEST_POSITIONS.map((p) => p.name),
    weapons: WeaponIds,
    onPosition: selectPosition,
    onWeapon: requestWeapon,
    onFire: (mode, down) => {
      if (mode === 'alt') {
        if (down) fire('alt');
        return;
      }
      holdingFire = down;
      if (down && fireCooldown <= 0) fire('primary');
    },
    onJump: jump,
    onToggleNaive: () => (naive = !naive),
    onToggleHidden: () => (hidden = !hidden),
  });
  window.addEventListener('keydown', (e) => {
    keys.add(e.code);
    if (e.code === 'Space') jump();
    const digit = /^Digit([1-8])$/.exec(e.code);
    if (digit) {
      const id = WeaponIds[Number(digit[1]) - 1];
      if (id) requestWeapon(id);
    }
    if (e.code === 'BracketRight' || e.code === 'BracketLeft') {
      const n = VIEWMODEL_TEST_POSITIONS.length;
      selectPosition((positionIndex + (e.code === 'BracketRight' ? 1 : n - 1)) % n);
    }
    if (e.code === 'KeyN') naive = !naive;
    if (e.code === 'KeyH') hidden = !hidden;
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());
  canvas.addEventListener('click', () => {
    if (controls?.touch || document.pointerLockElement === canvas) return;
    // Pointer lock is optional (unavailable in some embeds); ignore refusals.
    Promise.resolve(canvas.requestPointerLock()).catch(() => undefined);
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) holdingFire = false;
  });
  canvas.addEventListener('mousedown', (e) => {
    if (document.pointerLockElement !== canvas) return;
    if (e.button === 0) {
      holdingFire = true;
      if (fireCooldown <= 0) fire('primary');
    }
    if (e.button === 2) fire('alt');
  });
  window.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== canvas) return;
    lookDX += e.movementX;
    lookDY += e.movementY;
  });
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      cycleWeapon(e.deltaY > 0 ? 1 : -1);
    },
    { passive: false },
  );
}

// --- Fake movement ----------------------------------------------------------

const ROOM_HX = 60 - 0.4;
const ROOM_HZ = 50 - 0.4;

function stepPawn(dt: number): void {
  const sens = 0.0025;
  const touchLook = controls?.takeLook();
  if (touchLook) {
    lookDX += touchLook.dx;
    lookDY += touchLook.dy;
  }
  pawn.yaw -= lookDX * sens;
  pawn.pitch = Math.max(-1.55, Math.min(1.55, pawn.pitch - lookDY * sens));
  lookDX = 0;
  lookDY = 0;
  pawn.crouching = keys.has('ControlLeft') || keys.has('KeyC') || (controls?.crouching ?? false);

  const stick = controls?.stick ?? { x: 0, y: 0 };
  const fwd = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0) + stick.y;
  const right = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0) + stick.x;
  // Keys give full speed; the stick gives proportional speed up to full.
  const len = Math.max(1, Math.hypot(fwd, right));
  const speed = RUN * (pawn.crouching ? 0.5 : 1);
  const s = Math.sin(pawn.yaw);
  const c = Math.cos(pawn.yaw);
  // Forward is (−sin, −cos), right is (cos, −sin) for yaw about +Y.
  const wx = ((-s * fwd + c * right) / len) * speed;
  const wz = ((-c * fwd - s * right) / len) * speed;
  const blend = pawn.grounded ? 1 - Math.exp(-dt / 0.05) : 1 - Math.exp(-dt / 0.6);
  pawn.velocity.x += (wx - pawn.velocity.x) * blend;
  pawn.velocity.z += (wz - pawn.velocity.z) * blend;
  if (!pawn.grounded) pawn.velocity.y -= GRAVITY * dt;

  pawn.feet.x = Math.max(-ROOM_HX, Math.min(ROOM_HX, pawn.feet.x + pawn.velocity.x * dt));
  pawn.feet.z = Math.max(-ROOM_HZ, Math.min(ROOM_HZ, pawn.feet.z + pawn.velocity.z * dt));
  pawn.feet.y += pawn.velocity.y * dt;
  if (pawn.feet.y <= 0 && !pawn.grounded) {
    const impactSpeed = -pawn.velocity.y;
    pawn.feet.y = 0;
    pawn.velocity.y = 0;
    pawn.grounded = true;
    viewModel.handleEvents([{ type: 'land', tick: tick++, pawn: LOCAL, impactSpeed }], LOCAL);
  }
  fireCooldown = Math.max(0, fireCooldown - dt);
  if (holdingFire && fireCooldown <= 0) fire('primary');

  stepSwitch(dt);
}

function stepSwitch(dt: number): void {
  if (!pawn.pendingWeapon) return;
  switchLeft -= dt;
  if (switchLeft <= 0) {
    pawn.weapon = pawn.pendingWeapon;
    pawn.pendingWeapon = null;
  }
}

// --- Rendering ---------------------------------------------------------------

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setPixelRatio(shell.pixelRatio());
  renderer.setSize(w, h, false);
  world.resize(w, h);
  // Keep the world's horizontal view on a phone held upright, like the view model does.
  world.camera.fov = fovForAspect(WORLD_FOV, w / h);
  world.camera.updateProjectionMatrix();
  viewModel.resize(w, h);
}
window.addEventListener('resize', resize);
resize();

function placeCamera(): void {
  applyPoseToCamera(world.camera, {
    position: { x: pawn.feet.x, y: pawn.feet.y + eyeHeight(), z: pawn.feet.z },
    yaw: pawn.yaw,
    pitch: pawn.pitch,
  });
}

/** Draw the view model in the world's depth buffer with the world projection: shows clipping. */
function renderNaive(): void {
  const cam = viewModel.camera;
  const saved = { fov: cam.fov, near: cam.near, far: cam.far };
  cam.fov = world.camera.fov;
  cam.near = world.camera.near;
  cam.far = world.camera.far;
  cam.updateProjectionMatrix();
  const autoClear = renderer.autoClear;
  renderer.autoClear = false;
  renderer.render(viewModel.scene, cam);
  renderer.autoClear = autoClear;
  cam.fov = saved.fov;
  cam.near = saved.near;
  cam.far = saved.far;
  cam.updateProjectionMatrix();
}

function draw(): void {
  renderer.info.reset();
  world.sync(null, emptyState, 1);
  placeCamera();
  renderer.render(world.scene, world.camera);
  if (naive) {
    if (viewModel.visible) renderNaive();
  } else {
    viewModel.render(renderer);
  }
}

const emptyState = {
  tick: 0,
  time: 0,
  rngState: 0,
  entities: [],
  match: {
    phase: 'playing' as const,
    fragLimit: 0,
    timeLimit: 0,
    elapsed: 0,
    scores: [],
    winner: null,
  },
};

function status(fps: number): string {
  const p = VIEWMODEL_TEST_POSITIONS[positionIndex];
  const f = pawn.feet;
  return (
    `${frozenName ? `test position: ${p?.name ?? '?'}` : `${fps.toFixed(0)} fps`}  ` +
    `weapon ${pawn.pendingWeapon ? `${pawn.weapon} → ${pawn.pendingWeapon}` : pawn.weapon}  ` +
    `${naive ? 'NAIVE single pass' : 'two-pass view model'}\n` +
    `feet ${f.x.toFixed(1)} ${f.y.toFixed(1)} ${f.z.toFixed(1)}  ` +
    `speed ${Math.hypot(pawn.velocity.x, pawn.velocity.z).toFixed(1)} m/s` +
    (frozenName
      ? `\n${p?.note ?? ''}`
      : controls?.touch
        ? '\nleft side: move  right side: look'
        : '\nclick: lock mouse  WASD/Space/Ctrl  LMB/RMB fire  1-8/wheel weapons  [ ] test positions  N naive  H hide')
  );
}

const start = VIEWMODEL_TEST_POSITIONS[positionIndex];
if (start) placeAt(start);

if (frozenName) {
  // Deterministic frame: pre-roll the motion with the position's velocity.
  const p = start!;
  // At least long enough for the spawn raise (0.15 s) to finish.
  const moving = Math.max(0.2, Number(params.get('t') ?? '1.3') || 0);
  const dt = 1 / 60;
  if (p.velocity) pawn.velocity = { ...p.velocity };
  for (let t = 0; t < moving; t += dt) viewModel.update(pawn, dt, !hidden);
  if (p.firing) {
    fire('primary');
    viewModel.update(pawn, dt * 0.5, !hidden);
  }
  draw();
  hud.textContent = status(60);
  document.body.dataset.ready = '1';
} else {
  let last = performance.now();
  let fps = 60;
  const frame = (now: number): void => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    fps += (1 / Math.max(dt, 1e-3) - fps) * 0.05;
    stepPawn(dt);
    viewModel.update(pawn, dt, !hidden);
    draw();
    hud.textContent = status(fps);
    controls?.sync(positionIndex, pawn.pendingWeapon ?? pawn.weapon);
    document.body.dataset.ready = '1';
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
