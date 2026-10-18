import { describe, expect, it } from 'vitest';
import {
  Box3,
  BufferGeometry,
  DirectionalLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Vector3,
  type Object3D,
} from 'three';
import { rampLocalVertices } from '../../sim/physics/shapes';
import type {
  Brush,
  EntityState,
  MapDef,
  PawnState,
  PickupState,
  SimEvent,
  WorldState,
} from '../../sim/types';
import { brushGeometry, rampGeometry } from './brushGeometry';
import {
  DebugCameraControls,
  applyPoseToCamera,
  lookAtPose,
  stepDebugCamera,
  viewDirection,
  IDLE_INPUT,
} from './debugCamera';
import { lerpAngle, PAWN_HEIGHT, PAWN_RADIUS, playerColor } from './entityViews';
import { LAUNDRY_SKETCH } from './fixtures/laundrySketch';
import { MapView, mapBounds, DEFAULT_LIGHTS } from './mapView';
import { MaterialLibrary, kelvinToRgb, placeholderColor, PLACEHOLDER_COLORS } from './materials';
import { SceneView } from './sceneView';

const EMPTY_MAP: MapDef = {
  name: 'empty',
  scale: 40,
  brushes: [],
  props: [],
  spawns: [],
  pickups: [],
  jumpPads: [],
  volumes: [],
  lights: [],
  navLinks: [],
  cameras: [],
  ambience: { loops: [], reverb: '' },
};

function pawn(id: number, overrides: Partial<PawnState> = {}): PawnState {
  return {
    id,
    kind: 'pawn',
    playerId: `p${id}`,
    position: { x: 0, y: 0.9, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
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
    ...overrides,
  };
}

function state(tick: number, entities: EntityState[]): WorldState {
  return {
    tick,
    time: tick / 60,
    rngState: 0,
    entities,
    match: { phase: 'playing', fragLimit: 0, timeLimit: 0, elapsed: 0, scores: [], winner: null },
  };
}

function worldBox(obj: Object3D): Box3 {
  obj.updateWorldMatrix(true, true);
  return new Box3().setFromObject(obj);
}

function expectVecClose(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
  digits = 5,
): void {
  expect(a.x).toBeCloseTo(b.x, digits);
  expect(a.y).toBeCloseTo(b.y, digits);
  expect(a.z).toBeCloseTo(b.z, digits);
}

describe('brush geometry', () => {
  it('box and cylinder match the brush extents', () => {
    const boxGeo = brushGeometry({
      shape: 'box',
      position: { x: 0, y: 0, z: 0 },
      size: { x: 4, y: 2, z: 6 },
      material: 'wood',
    });
    boxGeo.computeBoundingBox();
    expectVecClose(boxGeo.boundingBox!.max, { x: 2, y: 1, z: 3 });

    const cylGeo = brushGeometry({
      shape: 'cylinder',
      position: { x: 0, y: 0, z: 0 },
      size: { x: 6, y: 10, z: 999 },
      material: 'metal',
    });
    cylGeo.computeBoundingBox();
    expectVecClose(cylGeo.boundingBox!.max, { x: 3, y: 5, z: 3 }, 3);
  });

  it('ramp uses the same corners as the physics wedge, wound outward', () => {
    const size = { x: 4, y: 3, z: 8 };
    const geo = rampGeometry(size);
    const pos = geo.getAttribute('position');
    expect(pos.count).toBe(8 * 3); // 3 quads × 2 + 2 triangles

    const corners = rampLocalVertices(size);
    const key = (x: number, y: number, z: number): string =>
      `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;
    const cornerKeys = new Set<string>();
    for (let i = 0; i < 6; i++) {
      cornerKeys.add(key(corners[i * 3]!, corners[i * 3 + 1]!, corners[i * 3 + 2]!));
    }
    const used = new Set<string>();
    for (let i = 0; i < pos.count; i++) used.add(key(pos.getX(i), pos.getY(i), pos.getZ(i)));
    expect(used).toEqual(cornerKeys);

    // Every face normal points away from the wedge's interior, and the slope faces up and toward −Z.
    const a = new Vector3();
    const b = new Vector3();
    const c = new Vector3();
    const n = new Vector3();
    const centroid = new Vector3(0, -size.y / 6, size.z / 6);
    let slopeSeen = false;
    for (let t = 0; t < pos.count; t += 3) {
      a.fromBufferAttribute(pos, t);
      b.fromBufferAttribute(pos, t + 1);
      c.fromBufferAttribute(pos, t + 2);
      n.crossVectors(b.clone().sub(a), c.clone().sub(a)).normalize();
      const mid = a.clone().add(b).add(c).divideScalar(3).sub(centroid);
      expect(n.dot(mid)).toBeGreaterThan(0);
      if (n.y > 0.1 && n.z < -0.1) slopeSeen = true;
    }
    expect(slopeSeen).toBe(true);
  });
});

describe('materials', () => {
  it('resolves families, prefixes and unknown ids', () => {
    expect(placeholderColor('wood')).toBe(PLACEHOLDER_COLORS.wood);
    expect(placeholderColor('enamel-washer')).toBe(PLACEHOLDER_COLORS.enamel);
    expect(placeholderColor('mystery-goo')).toBe(placeholderColor('mystery-goo'));
    expect(placeholderColor('mystery-goo')).not.toBe(placeholderColor('other-goo'));
  });

  it('caches one material per id and disposes them', () => {
    const lib = new MaterialLibrary();
    const a = lib.get('wood-table');
    expect(lib.get('wood-table')).toBe(a);
    lib.get('metal');
    expect(lib.size).toBe(2);
    lib.dispose();
    expect(lib.size).toBe(0);
  });

  it('converts color temperature: warm is red-heavy, daylight near white', () => {
    const warm = kelvinToRgb(2700);
    expect(warm.r).toBe(1);
    expect(warm.b).toBeLessThan(0.6);
    const day = kelvinToRgb(6500);
    expect(day.r).toBeGreaterThan(0.95);
    expect(day.g).toBeGreaterThan(0.9);
    expect(day.b).toBeGreaterThan(0.9);
    const cool = kelvinToRgb(10000);
    expect(cool.b).toBe(1);
    expect(cool.r).toBeLessThan(cool.b);
  });
});

describe('MapView', () => {
  it('builds one mesh per brush, placed where the brush says', () => {
    const view = new MapView(LAUNDRY_SKETCH);
    expect(view.stats.brushes).toBe(LAUNDRY_SKETCH.brushes.length);
    expect(view.stats.skippedBrushes).toBe(0);

    LAUNDRY_SKETCH.brushes.forEach((brush, i) => {
      const mesh = view.brushes.children[i] as Mesh<BufferGeometry, MeshStandardMaterial>;
      expect(mesh.userData).toMatchObject({ kind: 'brush', index: i });
      expect(mesh.material.name).toBe(brush.material);
      const box = worldBox(mesh);
      const center = box.getCenter(new Vector3());
      if (brush.shape !== 'ramp') expectVecClose(center, brush.position, 3);
      expect(box.min.y).toBeCloseTo(brush.position.y - brush.size.y / 2, 3);
      expect(box.max.y).toBeCloseTo(brush.position.y + brush.size.y / 2, 3);
    });
    view.dispose();
  });

  it('washer and dryer tops sit at 34 m with a 4 m gap (§7.1 layout)', () => {
    const view = new MapView(LAUNDRY_SKETCH);
    const find = (mat: string): Box3 => {
      const mesh = view.brushes.children.find(
        (m) => ((m as Mesh).material as MeshStandardMaterial).name === mat,
      );
      if (!mesh) throw new Error(`no brush ${mat}`);
      return worldBox(mesh);
    };
    const washer = find('enamel-washer');
    const dryer = find('enamel-dryer');
    expect(washer.max.y).toBeCloseTo(34);
    expect(dryer.max.y).toBeCloseTo(34);
    expect(dryer.min.x - washer.max.x).toBeCloseTo(4);
    view.dispose();
  });

  it('applies yaw the same way the physics glue does (+X turns toward −Z)', () => {
    const brush: Brush = {
      shape: 'box',
      position: { x: 10, y: 1, z: 0 },
      size: { x: 4, y: 2, z: 2 },
      yaw: Math.PI / 2,
      material: 'wood',
    };
    const view = new MapView({ ...EMPTY_MAP, brushes: [brush] });
    const mesh = view.brushes.children[0]!;
    mesh.updateWorldMatrix(true, false);
    const tip = new Vector3(2, 0, 0).applyMatrix4(mesh.matrixWorld);
    expectVecClose(tip, { x: 10, y: 1, z: -2 });
    // Bounds account for yaw: 4 m long along Z after the turn.
    const b = mapBounds({ ...EMPTY_MAP, brushes: [brush] });
    expect(b.max.z - b.min.z).toBeCloseTo(4);
    expect(b.max.x - b.min.x).toBeCloseTo(2);
    view.dispose();
  });

  it('skips degenerate brushes instead of throwing', () => {
    const view = new MapView({
      ...EMPTY_MAP,
      brushes: [
        { shape: 'box', position: { x: 0, y: 0, z: 0 }, size: { x: 0, y: 1, z: 1 }, material: 'x' },
      ],
    });
    expect(view.stats).toMatchObject({ brushes: 0, skippedBrushes: 1 });
    view.dispose();
  });

  it('adds markers for spawns, pickups, pads, volumes and nav links', () => {
    const m = LAUNDRY_SKETCH;
    const view = new MapView(m);
    const names = view.markers.children.map((c) => c.name);
    const count = (prefix: string): number => names.filter((n) => n.startsWith(prefix)).length;
    expect(count('spawn:')).toBe(m.spawns.length);
    expect(count('pickup:')).toBe(m.pickups.length);
    expect(count('volume:')).toBe(m.volumes.length);
    expect(count('navLink:')).toBe(m.navLinks.length);
    expect(names.filter((n) => /^jumpPad:\d+$/.test(n))).toHaveLength(m.jumpPads.length);
    expect(names).toContain('volume:0:water');
    view.setMarkersVisible(false);
    expect(view.markers.visible).toBe(false);
    view.dispose();
  });

  it('uses the map lights, or a directional + ambient rig when there are none', () => {
    const withLights = new MapView(LAUNDRY_SKETCH);
    expect(withLights.stats.lights).toBe(LAUNDRY_SKETCH.lights.length);
    withLights.dispose();

    const bare = new MapView(EMPTY_MAP);
    expect(bare.stats.lights).toBe(DEFAULT_LIGHTS.length);
    let directional: DirectionalLight | undefined;
    let ambient = 0;
    bare.lights.traverse((o) => {
      if (o instanceof DirectionalLight) directional = o;
      if (o.type === 'AmbientLight') ambient++;
    });
    expect(directional?.castShadow).toBe(true);
    expect(ambient).toBe(1);
    bare.dispose();
  });

  it('draws props as their scaled placeholder box', () => {
    const view = new MapView({
      ...EMPTY_MAP,
      props: [
        {
          asset: 'models/bottle.glb',
          position: { x: 1, y: 2, z: 3 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 2, y: 4, z: 2 },
          collision: 'box',
        },
      ],
    });
    expect(view.stats.props).toBe(1);
    const box = worldBox(view.props.children[0]!);
    expectVecClose(box.getSize(new Vector3()), { x: 2, y: 4, z: 2 });
    view.dispose();
  });
});

describe('entity helpers', () => {
  it('lerps angles along the shortest arc', () => {
    expect(lerpAngle(0, Math.PI / 2, 0.5)).toBeCloseTo(Math.PI / 4);
    // From just below +π to just above −π goes through π, not through 0.
    const mid = lerpAngle(Math.PI - 0.1, -Math.PI + 0.1, 0.5);
    expect(Math.abs(Math.cos(mid) - -1)).toBeLessThan(1e-6);
  });

  it('gives each player a stable color', () => {
    expect(playerColor('bot:1')).toBe(playerColor('bot:1'));
    expect(playerColor('bot:1')).not.toBe(playerColor('bot:2'));
  });
});

describe('SceneView', () => {
  it('creates a 1.8 m pawn capsule centered on the pawn position', () => {
    const view = new SceneView(LAUNDRY_SKETCH);
    view.sync(null, state(0, [pawn(7, { position: { x: 3, y: 0.9, z: -2 } })]), 0);
    const obj = view.objectFor(7);
    expect(obj).toBeDefined();
    const body = obj!.getObjectByName('body')!;
    const box = worldBox(body);
    expect(box.max.y - box.min.y).toBeCloseTo(PAWN_HEIGHT, 3);
    expect(box.max.x - box.min.x).toBeCloseTo(PAWN_RADIUS * 2, 2);
    expectVecClose(box.getCenter(new Vector3()), { x: 3, y: 0.9, z: -2 }, 3);
    view.dispose();
  });

  it('interpolates position and yaw between ticks', () => {
    const view = new SceneView(EMPTY_MAP);
    const prev = state(0, [pawn(1, { position: { x: 0, y: 0, z: 0 }, yaw: 0 })]);
    const curr = state(1, [pawn(1, { position: { x: 10, y: 2, z: -4 }, yaw: 1 })]);
    view.sync(prev, curr, 0.25);
    const obj = view.objectFor(1)!;
    expectVecClose(obj.position, { x: 2.5, y: 0.5, z: -1 });
    expect(obj.rotation.y).toBeCloseTo(0.25);
    view.sync(prev, curr, 1);
    expectVecClose(obj.position, { x: 10, y: 2, z: -4 });
    view.dispose();
  });

  it('snaps instead of interpolating after a respawn or teleport event', () => {
    const view = new SceneView(EMPTY_MAP);
    const prev = state(0, [pawn(1, { position: { x: 0, y: 0, z: 0 } })]);
    const curr = state(1, [pawn(1, { position: { x: 50, y: 0, z: 0 } })]);
    const events: SimEvent[] = [
      {
        type: 'respawn',
        tick: 1,
        pawn: 1,
        pose: { position: { x: 50, y: 0, z: 0 }, yaw: 0, pitch: 0 },
      },
    ];
    view.handleEvents(events);
    view.sync(prev, curr, 0.1);
    expect(view.objectFor(1)!.position.x).toBeCloseTo(50);
    // The snap only lasts one sync.
    view.sync(prev, curr, 0.1);
    expect(view.objectFor(1)!.position.x).toBeCloseTo(5);
    view.dispose();
  });

  it('adds and removes views as entities come and go', () => {
    const view = new SceneView(EMPTY_MAP);
    const pickup: PickupState = {
      id: 9,
      kind: 'pickup',
      position: { x: 0, y: 1, z: 0 },
      placementIndex: 0,
      type: 'healthVial',
      available: false,
      respawnAt: 0,
      takenBy: [],
    };
    view.sync(null, state(0, [pawn(1), pawn(2), pickup]), 0);
    expect(view.entityCount).toBe(3);
    expect(view.objectFor(9)!.visible).toBe(false);
    expect(view.objectFor(1)!.parent).toBe(view.scene);

    view.sync(null, state(1, [pawn(2, { alive: false })]), 0);
    expect(view.entityCount).toBe(1);
    expect(view.objectFor(1)).toBeUndefined();
    expect(view.objectFor(2)!.visible).toBe(false);

    view.handleEvents([{ type: 'entityDestroyed', tick: 2, id: 2, kind: 'pawn' }]);
    expect(view.entityCount).toBe(0);
    view.dispose();
  });

  it('ignores entity kinds that are drawn from the map', () => {
    const view = new SceneView(EMPTY_MAP);
    view.sync(
      null,
      state(0, [{ id: 4, kind: 'jumpPad', position: { x: 0, y: 0, z: 0 }, placementIndex: 0 }]),
      0,
    );
    expect(view.entityCount).toBe(0);
    view.dispose();
  });

  it('frames the map: default pose is the first named camera; named cameras resolve', () => {
    const view = new SceneView(LAUNDRY_SKETCH);
    expectVecClose(view.camera.position, LAUNDRY_SKETCH.cameras[0]!.pose.position);
    expect(view.useNamedCamera('sink')).toBe(true);
    expect(view.useNamedCamera('nope')).toBe(false);
    view.resize(800, 400);
    expect(view.camera.aspect).toBe(2);
    view.dispose();
  });

  it('overview pose looks down at the map from outside its footprint', () => {
    const view = new SceneView({ ...LAUNDRY_SKETCH, cameras: [] });
    const pose = view.defaultPose();
    expect(pose.pitch).toBeLessThan(0);
    expect(pose.position.y).toBeGreaterThan(view.mapView.bounds.max.y);
    view.dispose();
  });

  it('every named camera in the sketch looks toward the room interior', () => {
    const bounds = mapBounds(LAUNDRY_SKETCH);
    for (const cam of LAUNDRY_SKETCH.cameras) {
      const d = viewDirection(cam.pose.yaw, cam.pose.pitch);
      const p = cam.pose.position;
      // A point 20 m ahead stays inside the room's footprint.
      const ahead = new Vector3(p.x + d.x * 20, p.y + d.y * 20, p.z + d.z * 20);
      expect(bounds.containsPoint(ahead), cam.name).toBe(true);
    }
  });

  it('dispose is idempotent and sync after dispose is a no-op', () => {
    const view = new SceneView(LAUNDRY_SKETCH);
    view.sync(null, state(0, [pawn(1)]), 0);
    view.dispose();
    view.dispose();
    view.sync(null, state(1, [pawn(1)]), 0);
    expect(view.entityCount).toBe(0);
  });
});

describe('debug camera', () => {
  it('yaw 0 looks down −Z and positive yaw turns toward −X', () => {
    const d0 = viewDirection(0, 0);
    expect(d0.z).toBeCloseTo(-1);
    const d90 = viewDirection(Math.PI / 2, 0);
    expect(d90.x).toBeCloseTo(-1);
  });

  it('applyPoseToCamera matches viewDirection', () => {
    const cam = new PerspectiveCamera();
    const pose = { position: { x: 1, y: 2, z: 3 }, yaw: 0.7, pitch: -0.3 };
    applyPoseToCamera(cam, pose);
    const dir = cam.getWorldDirection(new Vector3());
    expectVecClose(dir, viewDirection(pose.yaw, pose.pitch));
  });

  it('lookAtPose inverts viewDirection', () => {
    const pose = lookAtPose({ x: 0, y: 10, z: 0 }, { x: -5, y: 5, z: -5 });
    const d = viewDirection(pose.yaw, pose.pitch);
    const want = new Vector3(-5, -5, -5).normalize();
    expectVecClose(new Vector3(d.x, d.y, d.z), want);
  });

  it('moves forward, strafes right, climbs, and clamps pitch', () => {
    const start = { position: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 };
    const settings = { speed: 10, sensitivity: 0.01 };
    const fwd = stepDebugCamera(start, { ...IDLE_INPUT, forward: 1 }, 1, settings);
    expectVecClose(fwd.position, { x: 0, y: 0, z: -10 });
    const right = stepDebugCamera(start, { ...IDLE_INPUT, right: 1, boost: 2 }, 0.5, settings);
    expect(right.position.x).toBeCloseTo(10);
    const up = stepDebugCamera(start, { ...IDLE_INPUT, up: 1 }, 1, settings);
    expect(up.position.y).toBeCloseTo(10);
    const look = stepDebugCamera(start, { ...IDLE_INPUT, lookDX: 10, lookDY: -1000 }, 1, settings);
    expect(look.yaw).toBeCloseTo(-0.1);
    expect(look.pitch).toBeLessThan(Math.PI / 2);
    expect(look.pitch).toBeGreaterThan(1.5);
  });

  it('controls cycle named cameras and clean up their listeners', () => {
    const element = new EventTarget() as unknown as HTMLElement;
    const keys = new EventTarget();
    const g = globalThis as unknown as { window?: EventTarget; document?: unknown };
    const hadWindow = 'window' in g;
    const prevWindow = g.window;
    g.window = new EventTarget();
    try {
      const selected: string[] = [];
      let toggles = 0;
      const controls = new DebugCameraControls({
        element,
        keyTarget: keys,
        cameras: LAUNDRY_SKETCH.cameras,
        onSelectCamera: (c) => selected.push(c.name),
        onToggleMarkers: () => toggles++,
      });
      const press = (code: string): void => {
        keys.dispatchEvent(Object.assign(new Event('keydown'), { code }));
        keys.dispatchEvent(Object.assign(new Event('keyup'), { code }));
      };
      press('BracketRight');
      press('BracketRight');
      press('BracketLeft');
      press('BracketLeft');
      press('KeyM');
      expect(selected).toEqual(['overview', 'machines', 'overview', 'drain']);
      expect(toggles).toBe(1);
      expect(controls.pose.position).toEqual(LAUNDRY_SKETCH.cameras.at(-1)!.pose.position);

      keys.dispatchEvent(Object.assign(new Event('keydown'), { code: 'KeyW' }));
      const before = controls.pose.position.z;
      controls.update(0.1);
      expect(controls.pose.position.z).not.toBe(before);

      controls.dispose();
      press('BracketRight');
      expect(selected).toHaveLength(4);
    } finally {
      if (hadWindow) g.window = prevWindow;
      else delete g.window;
    }
  });
});
