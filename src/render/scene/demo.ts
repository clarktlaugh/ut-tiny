/**
 * Dev-only demo for the scene view: `npm run dev`, then open
 * `/src/render/scene/demo.html`. Not part of the production build.
 *
 * Query parameters: `camera=<name>` starts at a named map camera and freezes
 * the demo pawns (for screenshots), `markers=0` hides debug markers.
 * When the first frame has rendered, `document.body.dataset.ready` is `"1"`.
 */
import { PCFShadowMap, WebGLRenderer } from 'three';
import { PAWN_HEIGHT } from './entityViews';
import { DebugCameraControls } from './debugCamera';
import { LAUNDRY_SKETCH } from './fixtures/laundrySketch';
import { SceneView } from './sceneView';
import type { PawnState, WorldState } from '../../sim/types';

const canvas = document.querySelector<HTMLCanvasElement>('#scene');
const hud = document.querySelector<HTMLDivElement>('#hud');
if (!canvas || !hud) throw new Error('demo.html is missing #scene or #hud');

const params = new URLSearchParams(location.search);
const fixedCamera = params.get('camera');
const map = LAUNDRY_SKETCH;

const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFShadowMap;
const view = new SceneView(map, { showMarkers: params.get('markers') !== '0' });

const controls = new DebugCameraControls({
  element: canvas,
  cameras: map.cameras,
  initialPose: view.defaultPose(),
  onToggleMarkers: () => view.setMarkersVisible(!view.mapView.markers.visible),
});
if (fixedCamera) {
  const index = map.cameras.findIndex((c) => c.name === fixedCamera);
  if (index >= 0) controls.selectCamera(index);
}

function pawn(id: number, playerId: string, t: number, radius: number, cx: number): PawnState {
  const a = t * 0.6 + id;
  return {
    id,
    kind: 'pawn',
    playerId,
    position: { x: cx + Math.cos(a) * radius, y: PAWN_HEIGHT / 2, z: Math.sin(a) * radius },
    velocity: { x: 0, y: 0, z: 0 },
    // Face along the direction of travel (tangent of the circle).
    yaw: Math.PI - a,
    pitch: 0,
    alive: true,
    health: 100,
    shield: 0,
    grounded: true,
    crouching: false,
    weapon: null,
    pendingWeapon: null,
    owned: [],
    ammo: {},
    spawnProtectedUntil: 0,
    respawnAt: 0,
    guiding: 0,
    disc: 0,
    viewingDisc: false,
    zoom: 1,
    udamageUntil: 0,
  };
}

function stateAt(tick: number): WorldState {
  const t = tick / 60;
  return {
    tick,
    time: t,
    rngState: 0,
    entities: [pawn(1, 'local', t, 8, 0), pawn(2, 'bot:1', t, 5, -25), pawn(3, 'bot:2', t, 6, 30)],
    match: { phase: 'playing', fragLimit: 0, timeLimit: 0, elapsed: t, scores: [], winner: null },
  };
}

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h, false);
  view.resize(w, h);
}
window.addEventListener('resize', resize);
resize();

let last = performance.now();
let simTime = 0;
let fps = 60;
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  fps += (1 / Math.max(dt, 1e-3) - fps) * 0.05;
  if (!fixedCamera) simTime += dt;
  const tickFloat = simTime * 60;
  const tick = Math.floor(tickFloat);
  view.sync(stateAt(tick), stateAt(tick + 1), tickFloat - tick);
  view.setCameraPose(controls.update(dt));
  renderer.render(view.scene, view.camera);
  const p = controls.pose.position;
  hud!.textContent =
    `${map.name}  ${fps.toFixed(0)} fps  draw calls ${renderer.info.render.calls}\n` +
    `pos ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}  speed ${controls.settings.speed.toFixed(0)} m/s\n` +
    'WASD/QE move, Shift fast, right-drag look, wheel speed, [ ] cameras, M markers';
  document.body.dataset.ready = '1';
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
