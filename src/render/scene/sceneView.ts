/**
 * `SceneView` (docs/DESIGN.md §8.3): owns the Three.js scene for one map and
 * mirrors world entities into it through an id → object map.
 *
 * Usage per rendered frame:
 *   view.handleEvents(eventsSinceLastFrame); // optional: snaps teleports/respawns
 *   view.sync(previousTickState, currentTickState, alpha);
 *   renderer.render(view.scene, view.camera);
 *
 * Entities are created when they first appear in a state (or an
 * `entitySpawned` event) and removed when they disappear (or on
 * `entityDestroyed`). Positions are interpolated between the previous and
 * current tick with `alpha` from the game loop.
 */
import { Color, Fog, PerspectiveCamera, Scene, Vector3 } from 'three';
import type { EntityId, EntityState, MapDef, Pose, SimEvent, WorldState } from '../../sim/types';
import { applyPoseToCamera, lookAtPose } from './debugCamera';
import {
  EntityAssets,
  createEntityView,
  isViewedKind,
  placeEntityView,
  type EntityView,
} from './entityViews';
import { MapView } from './mapView';
import { MaterialLibrary } from './materials';

export interface SceneViewOptions {
  /** Vertical field of view in degrees (default 75). */
  fov?: number;
  /** Initial aspect ratio (default 16 / 9). */
  aspect?: number;
  /** Show map debug markers (default true). */
  showMarkers?: boolean;
  /** Background color (default dark blue-grey). */
  background?: number;
}

export class SceneView {
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly mapView: MapView;

  private readonly materials = new MaterialLibrary();
  private readonly assets = new EntityAssets();
  private readonly views = new Map<EntityId, EntityView>();
  /** Entities whose next sync must not interpolate (teleported, respawned). */
  private readonly snap = new Set<EntityId>();
  private readonly prevById = new Map<EntityId, EntityState>();
  private readonly seen = new Set<EntityId>();
  private disposed = false;

  constructor(
    readonly map: MapDef,
    options: SceneViewOptions = {},
  ) {
    const background = options.background ?? 0x1a1f26;
    this.scene.background = new Color(background);
    this.camera = new PerspectiveCamera(options.fov ?? 75, options.aspect ?? 16 / 9, 0.05, 2000);
    this.mapView = new MapView(map, {
      materials: this.materials,
      showMarkers: options.showMarkers ?? true,
    });
    this.scene.add(this.mapView.root);
    const size = this.mapView.bounds.isEmpty()
      ? 200
      : this.mapView.bounds.getSize(new Vector3()).length();
    this.scene.fog = new Fog(background, size * 1.5, size * 4);
    applyPoseToCamera(this.camera, this.defaultPose());
  }

  /** First named camera, else a three-quarter overview of the map bounds. */
  defaultPose(): Pose {
    const first = this.map.cameras[0];
    if (first) return first.pose;
    return this.overviewPose();
  }

  /** Three-quarter overview of the map from above one corner. */
  overviewPose(): Pose {
    const b = this.mapView.bounds;
    if (b.isEmpty()) return lookAtPose({ x: 0, y: 20, z: 40 }, { x: 0, y: 0, z: 0 });
    const center = b.getCenter(new Vector3());
    const size = b.getSize(new Vector3());
    const eye = {
      x: center.x + size.x * 0.45,
      y: b.max.y + size.y * 0.25,
      z: center.z + size.z * 0.75,
    };
    return lookAtPose(eye, { x: center.x, y: b.min.y, z: center.z });
  }

  setCameraPose(pose: Readonly<Pose>): void {
    applyPoseToCamera(this.camera, pose);
  }

  /** Place the camera at a named `MapDef` camera. Returns false if no such camera. */
  useNamedCamera(name: string): boolean {
    const cam = this.map.cameras.find((c) => c.name === name);
    if (!cam) return false;
    this.setCameraPose(cam.pose);
    return true;
  }

  resize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  setMarkersVisible(visible: boolean): void {
    this.mapView.setMarkersVisible(visible);
  }

  /** Object for an entity, if it has a view. */
  objectFor(id: EntityId): EntityView['object'] | undefined {
    return this.views.get(id)?.object;
  }

  /** Number of live entity views. */
  get entityCount(): number {
    return this.views.size;
  }

  /**
   * React to sim events: drop views on `entityDestroyed`, and skip
   * interpolation for entities that teleported or respawned.
   */
  handleEvents(events: readonly SimEvent[]): void {
    for (const e of events) {
      switch (e.type) {
        case 'entityDestroyed':
          this.removeView(e.id);
          this.snap.delete(e.id);
          break;
        case 'entitySpawned':
          this.snap.add(e.id);
          break;
        case 'respawn':
        case 'teleport':
          this.snap.add(e.pawn);
          break;
        default:
          break;
      }
    }
  }

  /**
   * Mirror `curr` into the scene, interpolating from `prev` by `alpha` in
   * [0, 1]. Pass `prev = null` (or the same state) to place without
   * interpolation.
   */
  sync(prev: Readonly<WorldState> | null, curr: Readonly<WorldState>, alpha: number): void {
    if (this.disposed) return;
    const t = Math.min(1, Math.max(0, alpha));
    this.prevById.clear();
    if (prev && prev !== curr) for (const e of prev.entities) this.prevById.set(e.id, e);
    this.seen.clear();
    for (const entity of curr.entities) {
      if (!isViewedKind(entity.kind)) continue;
      this.seen.add(entity.id);
      let view = this.views.get(entity.id);
      if (view && view.kind !== entity.kind) {
        this.removeView(entity.id);
        view = undefined;
      }
      if (!view) {
        view = createEntityView(entity, this.assets);
        if (!view) continue;
        this.views.set(entity.id, view);
        this.scene.add(view.object);
      }
      const from = this.snap.has(entity.id) ? undefined : this.prevById.get(entity.id);
      placeEntityView(view, from, entity, t);
    }
    for (const id of [...this.views.keys()]) if (!this.seen.has(id)) this.removeView(id);
    this.snap.clear();
  }

  /** Release every GPU resource this view created. The view is unusable afterwards. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of [...this.views.keys()]) this.removeView(id);
    this.mapView.dispose();
    this.assets.dispose();
    this.materials.dispose();
    this.scene.clear();
  }

  private removeView(id: EntityId): void {
    const view = this.views.get(id);
    if (!view) return;
    // Entity meshes share geometry and materials from `EntityAssets`; nothing to free here.
    view.object.removeFromParent();
    this.views.delete(id);
  }
}
