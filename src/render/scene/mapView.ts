/**
 * Static part of the scene built from a `MapDef` (docs/DESIGN.md §8.3, §8.5):
 * brushes as placeholder-material meshes, props as placeholder boxes, map
 * lights plus a basic directional + ambient rig, and debug markers for spawns,
 * pickups, jump pads, kill/damage/water volumes and nav links.
 */
import {
  AmbientLight,
  ArrowHelper,
  Box3,
  BoxGeometry,
  BufferGeometry,
  ConeGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  OctahedronGeometry,
  PointLight,
  SpotLight,
  Vector3,
  type Light,
  type Material,
} from 'three';
import type { LightDef, MapDef, PickupType, Vec3, VolumeKind } from '../../sim/types';
import { brushIsValid } from '../../sim/physics/shapes';
import { brushGeometry } from './brushGeometry';
import { MaterialLibrary, kelvinToColor } from './materials';

/** Colors for debug markers. */
export const MARKER_COLORS = {
  spawn: 0x3ad06b,
  jumpPad: 0x33c3ff,
  prop: 0xff00ff,
  navLink: 0xffd23a,
  volume: { kill: 0xff3030, damage: 0xff9a2e, water: 0x3a7dff } satisfies Record<
    VolumeKind,
    number
  >,
  pickup: {
    weapon: 0xd0d0d0,
    ammo: 0x9f8f4a,
    healthVial: 0x5ad0ff,
    healthPack: 0x40e070,
    shieldPack: 0xffd23a,
    superShield: 0xffa000,
    udamage: 0xc040ff,
  } satisfies Record<PickupType, number>,
} as const;

/** Basic light rig used when a map defines no lights of its own. */
export const DEFAULT_LIGHTS: readonly LightDef[] = [
  { kind: 'ambient', temperatureK: 6500, intensity: 0.6 },
  {
    kind: 'directional',
    direction: { x: -0.4, y: -1, z: -0.3 },
    temperatureK: 5000,
    intensity: 2.2,
    castShadow: true,
  },
];

export interface MapViewOptions {
  /** Shared material library; one is created (and owned) if omitted. */
  materials?: MaterialLibrary;
  /** Show debug markers initially (default true). */
  showMarkers?: boolean;
}

/** Counts of what was built, for tests and the debug overlay. */
export interface MapViewStats {
  brushes: number;
  skippedBrushes: number;
  props: number;
  lights: number;
  markers: number;
}

const toV3 = (v: Vec3): Vector3 => new Vector3(v.x, v.y, v.z);

/** Axis-aligned bounds of all brushes (yaw included), or an empty box. */
export function mapBounds(map: MapDef): Box3 {
  const bounds = new Box3();
  const tmp = new Box3();
  for (const brush of map.brushes) {
    if (!brushIsValid(brush)) continue;
    const { x, y, z } = brush.size;
    const hz = brush.shape === 'cylinder' ? x / 2 : z / 2;
    const half = new Vector3(x / 2, y / 2, hz);
    const yaw = brush.yaw ?? 0;
    if (yaw !== 0) {
      const c = Math.abs(Math.cos(yaw));
      const s = Math.abs(Math.sin(yaw));
      half.set(half.x * c + half.z * s, half.y, half.x * s + half.z * c);
    }
    const center = toV3(brush.position);
    tmp.set(center.clone().sub(half), center.clone().add(half));
    bounds.union(tmp);
  }
  return bounds;
}

/** The scene graph for one map. Call `dispose()` when switching maps. */
export class MapView {
  readonly root = new Group();
  readonly brushes = new Group();
  readonly props = new Group();
  readonly lights = new Group();
  readonly markers = new Group();
  readonly bounds: Box3;
  readonly stats: MapViewStats;

  private readonly materials: MaterialLibrary;
  private readonly ownsMaterials: boolean;
  private readonly markerMaterials: Material[] = [];

  constructor(
    readonly map: MapDef,
    options: MapViewOptions = {},
  ) {
    this.materials = options.materials ?? new MaterialLibrary();
    this.ownsMaterials = !options.materials;
    this.root.name = `map:${map.name}`;
    this.brushes.name = 'brushes';
    this.props.name = 'props';
    this.lights.name = 'lights';
    this.markers.name = 'markers';
    this.root.add(this.brushes, this.props, this.lights, this.markers);
    this.bounds = mapBounds(map);

    let skipped = 0;
    map.brushes.forEach((brush, i) => {
      if (!brushIsValid(brush)) {
        skipped++;
        return;
      }
      const mesh = new Mesh(brushGeometry(brush), this.materials.get(brush.material));
      mesh.name = `brush:${i}:${brush.shape}:${brush.material}`;
      mesh.position.copy(toV3(brush.position));
      mesh.rotation.y = brush.yaw ?? 0;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData = { kind: 'brush', index: i };
      mesh.updateMatrix();
      mesh.matrixAutoUpdate = false;
      this.brushes.add(mesh);
    });

    this.buildProps();
    const lightDefs = map.lights.length > 0 ? map.lights : DEFAULT_LIGHTS;
    for (const def of lightDefs) this.lights.add(this.buildLight(def));
    // Always guarantee a little fill so a map with only point lights isn't black.
    if (!lightDefs.some((l) => l.kind === 'ambient')) {
      this.lights.add(new HemisphereLight(0xdfe6ee, 0x4a4440, 0.35));
    }
    this.buildMarkers();
    this.markers.visible = options.showMarkers ?? true;

    this.stats = {
      brushes: this.brushes.children.length,
      skippedBrushes: skipped,
      props: this.props.children.length,
      lights: this.lights.children.length,
      markers: this.markers.children.length,
    };
  }

  /** Show or hide spawn / pickup / pad / volume / nav-link markers. */
  setMarkersVisible(visible: boolean): void {
    this.markers.visible = visible;
  }

  dispose(): void {
    this.root.traverse((obj) => {
      if (obj instanceof Mesh || obj instanceof Line) (obj.geometry as BufferGeometry).dispose();
      if (obj instanceof ArrowHelper) obj.dispose();
      if ((obj as Light).isLight) (obj as Light).dispose();
    });
    for (const m of this.markerMaterials) m.dispose();
    this.markerMaterials.length = 0;
    if (this.ownsMaterials) this.materials.dispose();
    this.root.removeFromParent();
    this.root.clear();
  }

  private markerMaterial<M extends Material>(m: M): M {
    this.markerMaterials.push(m);
    return m;
  }

  /** Props are drawn as their scaled unit box until GLTF loading lands. */
  private buildProps(): void {
    if (this.map.props.length === 0) return;
    const geo = new BoxGeometry(1, 1, 1);
    const mat = this.markerMaterial(
      new MeshStandardMaterial({ color: MARKER_COLORS.prop, roughness: 0.9, wireframe: true }),
    );
    this.map.props.forEach((prop, i) => {
      const mesh = new Mesh(i === 0 ? geo : geo.clone(), mat);
      mesh.name = `prop:${i}:${prop.asset}`;
      mesh.position.copy(toV3(prop.position));
      mesh.quaternion.set(prop.rotation.x, prop.rotation.y, prop.rotation.z, prop.rotation.w);
      mesh.scale.copy(toV3(prop.scale));
      mesh.userData = { kind: 'prop', index: i, asset: prop.asset };
      this.props.add(mesh);
    });
  }

  private buildLight(def: LightDef): Object3D {
    const color = kelvinToColor(def.temperatureK);
    switch (def.kind) {
      case 'ambient':
        return new AmbientLight(color, def.intensity);
      case 'point': {
        // decay 0: map intensities are authored for a 100 m room, not physical candela.
        const light = new PointLight(color, def.intensity, 0, 0);
        if (def.position) light.position.copy(toV3(def.position));
        light.castShadow = def.castShadow ?? false;
        return light;
      }
      case 'spot': {
        const light = new SpotLight(color, def.intensity, 0, Math.PI / 4, 0.4, 0);
        if (def.position) light.position.copy(toV3(def.position));
        const dir = def.direction ? toV3(def.direction).normalize() : new Vector3(0, -1, 0);
        // Target is a child, so its local position is just the aim direction.
        light.add(light.target);
        light.target.position.copy(dir);
        light.castShadow = def.castShadow ?? false;
        return light;
      }
      case 'directional':
        return this.buildDirectional(def, color);
    }
  }

  /** Directional light aimed at the map center, with a shadow frustum covering the map. */
  private buildDirectional(def: LightDef, color: ReturnType<typeof kelvinToColor>): Object3D {
    const light = new DirectionalLight(color, def.intensity);
    const dir = def.direction ? toV3(def.direction) : new Vector3(-0.4, -1, -0.3);
    if (dir.lengthSq() === 0) dir.set(0, -1, 0);
    dir.normalize();
    const center = this.bounds.isEmpty() ? new Vector3() : this.bounds.getCenter(new Vector3());
    const radius = this.bounds.isEmpty()
      ? 50
      : Math.max(1, this.bounds.getSize(new Vector3()).length() / 2);
    light.position.copy(
      def.position ? toV3(def.position) : center.clone().addScaledVector(dir, -2 * radius),
    );
    light.target.position.copy(center);
    light.castShadow = def.castShadow ?? false;
    if (light.castShadow) {
      const cam = light.shadow.camera;
      cam.left = -radius;
      cam.right = radius;
      cam.top = radius;
      cam.bottom = -radius;
      cam.near = 0.5;
      cam.far = light.position.distanceTo(center) + radius * 2;
      cam.updateProjectionMatrix();
      light.shadow.mapSize.set(2048, 2048);
      light.shadow.bias = -0.0005;
      light.shadow.normalBias = 0.05;
    }
    const group = new Group();
    group.name = 'directional';
    group.add(light, light.target);
    return group;
  }

  private buildMarkers(): void {
    const map = this.map;
    const translucent = (color: number, opacity: number): MeshBasicMaterial =>
      this.markerMaterial(
        new MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
      );

    // Spawns: a cone pointing along the spawn's facing (yaw 0 = −Z), standing on the floor point.
    const spawnMat = translucent(MARKER_COLORS.spawn, 0.8);
    map.spawns.forEach((pose, i) => {
      const cone = new Mesh(new ConeGeometry(0.4, 1.2, 12), spawnMat);
      cone.rotation.x = -Math.PI / 2; // tip toward −Z
      const holder = new Group();
      holder.name = `spawn:${i}`;
      holder.position.copy(toV3(pose.position));
      holder.rotation.y = pose.yaw;
      holder.add(cone);
      this.markers.add(holder);
    });

    map.pickups.forEach((p, i) => {
      const mesh = new Mesh(
        new OctahedronGeometry(0.5),
        translucent(MARKER_COLORS.pickup[p.type], 0.9),
      );
      mesh.name = `pickup:${i}:${p.type}${p.weapon ? `:${p.weapon}` : ''}`;
      mesh.position.copy(toV3(p.position));
      this.markers.add(mesh);
    });

    const padMat = translucent(MARKER_COLORS.jumpPad, 0.35);
    map.jumpPads.forEach((pad, i) => {
      const mesh = new Mesh(new BoxGeometry(pad.size.x, pad.size.y, pad.size.z), padMat);
      mesh.name = `jumpPad:${i}`;
      mesh.position.copy(toV3(pad.position));
      this.markers.add(mesh);
      const launch = toV3(pad.launch);
      const len = launch.length();
      if (len > 0) {
        const arrow = new ArrowHelper(
          launch.clone().normalize(),
          toV3(pad.position),
          Math.min(20, len / 2),
          MARKER_COLORS.jumpPad,
        );
        arrow.name = `jumpPad:${i}:launch`;
        this.markers.add(arrow);
      }
    });

    map.volumes.forEach((vol, i) => {
      const size = toV3(vol.box.max).sub(toV3(vol.box.min));
      const center = toV3(vol.box.min).add(toV3(vol.box.max)).multiplyScalar(0.5);
      const mesh = new Mesh(
        new BoxGeometry(Math.abs(size.x), Math.abs(size.y), Math.abs(size.z)),
        translucent(MARKER_COLORS.volume[vol.kind], 0.3),
      );
      mesh.name = `volume:${i}:${vol.kind}`;
      mesh.position.copy(center);
      this.markers.add(mesh);
    });

    if (map.navLinks.length > 0) {
      const lineMat = this.markerMaterial(new LineBasicMaterial({ color: MARKER_COLORS.navLink }));
      map.navLinks.forEach((link, i) => {
        const line = new Line(
          new BufferGeometry().setFromPoints([toV3(link.from), toV3(link.to)]),
          lineMat,
        );
        line.name = `navLink:${i}:${link.kind}`;
        this.markers.add(line);
      });
    }
  }
}
