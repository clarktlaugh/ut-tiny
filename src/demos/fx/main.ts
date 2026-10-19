/**
 * FX demo, built as `/demos/fx.html`. `/src/render/fx/demo.html`
 * is a dev-server alias of the same module (the FX README points at it).
 *
 * Scripted combat from `timeline.ts` plays on the laundry sketch: an assault
 * rifle burst, a rocket, a shock kill with gibs, a three-rocket salvo, a
 * grenade, a Redeemer, a teleport, a landing, a jump pad and a pickup.
 *
 * Query parameters: `tick=N` runs the script to tick N and freezes there
 * (for screenshots), `camera=<name>` starts at a named camera (the sketch's
 * or `fx-*` from the timeline), `markers=1` shows the map debug markers.
 * When the first frame has rendered, `document.body.dataset.ready` is `"1"`.
 * With `tick=` the What-to-check card stays closed so screenshots are clean.
 */
import { PCFShadowMap, WebGLRenderer } from 'three';
import { TICK_DT } from '../../sim/types';
import { DebugCameraControls } from '../../render/scene/debugCamera';
import { LAUNDRY_SKETCH } from '../../render/scene/fixtures/laundrySketch';
import { SceneView } from '../../render/scene/sceneView';
import { FxSystem } from '../../render/fx/fxSystem';
import { raycastProbe } from '../../render/fx/surface';
import { FX_CAMERAS, LOOP_TICKS, eventsAt, stateAt } from '../../render/fx/timeline';
import { createDemoShell } from '../shell';

const canvas = document.querySelector<HTMLCanvasElement>('#scene');
const hud = document.querySelector<HTMLDivElement>('#hud');
const flashEl = document.querySelector<HTMLDivElement>('#flash');
if (!canvas || !hud || !flashEl) throw new Error('fx.html is missing #scene, #hud or #flash');

const params = new URLSearchParams(location.search);
const frozenTick = params.has('tick') ? Math.max(0, Number(params.get('tick'))) : null;
const map = { ...LAUNDRY_SKETCH, cameras: [...LAUNDRY_SKETCH.cameras, ...FX_CAMERAS] };

const shell = createDemoShell({
  slug: 'fx',
  showCardOnLoad: frozenTick === null,
  onReset: () => {
    tick = -1;
    prev = stateAt(0);
    curr = prev;
    simTime = 0;
    controls.pose = view.defaultPose();
  },
  perfStats: () => {
    const s = fx.stats();
    return {
      particles: s.light + s.matter,
      beams: s.beams,
    };
  },
  tuning: () => ({
    tick,
    camera: Object.values(controls.pose.position)
      .map((v) => v.toFixed(1))
      .join(' '),
  }),
});

const renderer = new WebGLRenderer({ canvas, antialias: shell.quality.antialias });
renderer.shadowMap.enabled = shell.quality.shadows;
shell.trackRenderer(renderer);
renderer.shadowMap.type = PCFShadowMap;
const view = new SceneView(map, { showMarkers: params.get('markers') === '1' });
const fx = new FxSystem({
  seed: 16,
  surface: raycastProbe([view.mapView.brushes, view.mapView.props]),
});
view.scene.add(fx.root);

const controls = new DebugCameraControls({
  element: canvas,
  cameras: map.cameras,
  initialPose: view.defaultPose(),
  onToggleMarkers: () => view.setMarkersVisible(!view.mapView.markers.visible),
});
const wanted = params.get('camera');
if (wanted) {
  const index = map.cameras.findIndex((c) => c.name === wanted);
  if (index >= 0) controls.selectCamera(index);
}
view.setCameraPose(controls.pose);

let tick = -1;
let prev = stateAt(0);
let curr = prev;

/** Advance the script to `target`, feeding each tick's events and state to the views. */
function stepTo(target: number): void {
  while (tick < target) {
    tick++;
    const events = eventsAt(tick);
    prev = curr;
    curr = stateAt(tick);
    view.handleEvents(events);
    fx.handleEvents(events, curr);
    fx.update(TICK_DT, view.camera, curr);
  }
}

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setPixelRatio(shell.pixelRatio());
  renderer.setSize(w, h, false);
  view.resize(w, h);
}
window.addEventListener('resize', resize);
resize();

if (frozenTick !== null) stepTo(frozenTick);

let last = performance.now();
let simTime = frozenTick !== null ? frozenTick * TICK_DT : 0;
let fps = 60;
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  fps += (1 / Math.max(dt, 1e-3) - fps) * 0.05;
  view.setCameraPose(controls.update(dt));
  if (frozenTick === null) {
    simTime += dt;
    const target = Math.floor(simTime * 60);
    stepTo(Math.min(target, tick + 10)); // never spiral after a stall
    view.sync(prev, curr, simTime * 60 - tick);
  } else {
    // Frozen: keep beams facing a moving camera without ageing anything.
    fx.update(0, view.camera);
    view.sync(prev, curr, 1);
  }
  flashEl!.style.opacity = fx.screenFlash.intensity.toFixed(3);
  renderer.render(view.scene, view.camera);
  const s = fx.stats();
  const p = controls.pose.position;
  hud!.textContent =
    `${map.name} FX  tick ${tick} / ${LOOP_TICKS}${frozenTick !== null ? ' (frozen)' : ''}  ` +
    `${fps.toFixed(0)} fps  draw calls ${renderer.info.render.calls}\n` +
    `particles ${s.light + s.matter}  beams ${s.beams}  lights ${s.flashes}  ` +
    `decals ${s.decals}  gibs ${s.gibs}  recycled ${s.recycled}\n` +
    `pos ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}  ` +
    (shell.touch
      ? 'touch controls arrive with P27; the script loops'
      : 'WASD/QE move, Shift fast, right-drag look, [ ] cameras, M markers');
  document.body.dataset.ready = '1';
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
