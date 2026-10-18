/**
 * Rapier glue for the simulation (docs/DESIGN.md §8.1, P6).
 *
 * `PhysicsWorld` owns a Rapier world that holds:
 * - static colliders built from `MapDef` brushes (and props, when geometry is supplied),
 * - one kinematic capsule per actor (pawns, and anything else that should be hit by
 *   traces or trip sensors),
 * - sensor boxes for volumes, jump pads, and anything else added with `addSensor`.
 *
 * Rapier does not integrate anything here: gravity is zero, there are no dynamic
 * bodies, and movement code sets actor positions directly. `step()` exists to
 * refresh Rapier's query structures after colliders move and to report sensor
 * enter/exit transitions in a deterministic order.
 *
 * Coordinates are meters, +Y up (§3). Brush conventions are in `shapes.ts`.
 */
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type { Box3, Brush, EntityId, MapDef, PropRef, Quat, Vec3 } from '../types';
import { initPhysics, type Rapier } from './rapier';
import {
  brushIsValid,
  rampLocalVertices,
  rotateVec,
  scaleVertices,
  vertexBounds,
  yawQuat,
  type PropGeometry,
} from './shapes';

type RWorld = RAPIER_NS.World;
type RCollider = RAPIER_NS.Collider;
type RColliderDesc = RAPIER_NS.ColliderDesc;
type RRigidBody = RAPIER_NS.RigidBody;
type RShape = RAPIER_NS.Shape;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Bit mask selecting which collider categories a query can hit. */
export const HitMask = {
  /** Static map geometry: brushes and props. */
  World: 1 << 0,
  /** Actor capsules. */
  Actors: 1 << 1,
  /** Sensor volumes. Excluded by default. */
  Sensors: 1 << 2,
} as const;

/** Default query mask: map geometry and actors, not sensors. */
export const HIT_SOLID = HitMask.World | HitMask.Actors;

/** Identifier of a sensor, allocated by `PhysicsWorld.addSensor`. Never reused. */
export type SensorId = number;

/** What a sensor stands for. `placementIndex` indexes the matching `MapDef` array. */
export type SensorTag =
  | { kind: 'volume'; placementIndex: number }
  | { kind: 'jumpPad'; placementIndex: number }
  | { kind: 'custom'; name: string; entity?: EntityId };

/** What a collider stands for. Returned with every hit. */
export type ColliderTag =
  | { kind: 'brush'; index: number }
  | { kind: 'prop'; index: number }
  | { kind: 'actor'; entity: EntityId }
  | { kind: 'sensor'; sensor: SensorId; tag: SensorTag };

/** Vertical capsule; `halfHeight` is half the straight section, so total height = 2·(halfHeight + radius). */
export interface CapsuleDims {
  radius: number;
  halfHeight: number;
}

/** Pawn capsule from §3: 1.8 m tall, radius 0.4 m. */
export const PAWN_CAPSULE: Readonly<CapsuleDims> = Object.freeze({ radius: 0.4, halfHeight: 0.5 });

/** Shapes accepted by `castShape` and `overlap`. */
export type QueryShape =
  | { type: 'sphere'; radius: number }
  | { type: 'capsule'; radius: number; halfHeight: number }
  | { type: 'box'; halfExtents: Vec3 };

export interface QueryOptions {
  /** `HitMask` bits; defaults to `HIT_SOLID`. */
  mask?: number;
  /** Actor to ignore (usually the shooter or the mover itself). */
  ignoreActor?: EntityId;
}

export interface RayHit {
  /** Distance from the origin along the normalised direction. */
  distance: number;
  point: Vec3;
  /** Surface normal at the hit, pointing out of the hit collider. Zero if the ray started inside. */
  normal: Vec3;
  collider: ColliderTag;
}

export interface ShapeHit {
  /** Distance the shape travelled along the normalised direction before touching. 0 if it started overlapping. */
  distance: number;
  /** Center of the cast shape at the time of impact. */
  position: Vec3;
  /** Contact point on the hit collider, world space. */
  point: Vec3;
  /** Normal at the contact point, pointing out of the hit collider. */
  normal: Vec3;
  /** True when the shape already overlapped the collider at its start position. */
  startedInside: boolean;
  collider: ColliderTag;
}

/** A transition reported by `step()`. */
export interface SensorEvent {
  type: 'enter' | 'exit';
  actor: EntityId;
  sensor: SensorId;
  tag: SensorTag;
}

export interface LoadMapOptions {
  /**
   * Geometry for props whose collision mode is not `none`. Props without
   * geometry are skipped (procedural props are expected to be brushes).
   */
  propGeometry?: (prop: PropRef, index: number) => PropGeometry | undefined;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const GROUP_WORLD = HitMask.World;
const GROUP_ACTOR = HitMask.Actors;
const GROUP_SENSOR = HitMask.Sensors;

/** Rapier interaction groups: memberships in the high 16 bits, filter in the low 16. */
function groups(memberships: number, filter: number): number {
  return ((memberships << 16) | (filter & 0xffff)) >>> 0;
}

const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 };

/** Overlap shallower than this (meters) counts as touching, not starting inside. */
const PENETRATION_EPSILON = 1e-3;

function v3(v: { x: number; y: number; z: number }): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

function normalize(v: Vec3): Vec3 | null {
  const len = Math.hypot(v.x, v.y, v.z);
  if (!(len > 0) || !Number.isFinite(len)) return null;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

interface ActorRecord {
  body: RRigidBody;
  collider: RCollider;
  /** Sensors the actor was inside after the last `step()`. Sorted ascending. */
  inside: SensorId[];
}

interface SensorRecord {
  collider: RCollider;
  tag: SensorTag;
}

// ---------------------------------------------------------------------------
// PhysicsWorld
// ---------------------------------------------------------------------------

export class PhysicsWorld {
  readonly rapier: Rapier;
  /** The underlying Rapier world, for packets that need raw access (e.g. the character controller). */
  readonly world: RWorld;

  private readonly tags = new Map<number, ColliderTag>();
  private readonly actors = new Map<EntityId, ActorRecord>();
  private readonly sensors = new Map<SensorId, SensorRecord>();
  private nextSensorId: SensorId = 1;
  /** Exits owed for actors or sensors removed since the last step. */
  private pendingExits: SensorEvent[] = [];
  private disposed = false;

  private constructor(rapier: Rapier) {
    this.rapier = rapier;
    this.world = new rapier.World({ x: 0, y: 0, z: 0 });
  }

  /** Create an empty physics world. */
  static async create(): Promise<PhysicsWorld> {
    return new PhysicsWorld(await initPhysics());
  }

  /** Create a physics world with the map's static geometry, volumes and jump pads loaded. */
  static async fromMap(map: MapDef, options: LoadMapOptions = {}): Promise<PhysicsWorld> {
    const pw = await PhysicsWorld.create();
    pw.loadMap(map, options);
    return pw;
  }

  // -- Map loading ----------------------------------------------------------

  /**
   * Add the map's brushes and props as static colliders, and its volumes and
   * jump pads as sensors. Call once per world; queries see the result after `step()`.
   */
  loadMap(map: MapDef, options: LoadMapOptions = {}): void {
    map.brushes.forEach((brush, index) => this.addBrush(brush, index));
    if (options.propGeometry) {
      const resolve = options.propGeometry;
      map.props.forEach((prop, index) => {
        if (prop.collision === 'none') return;
        const geometry = resolve(prop, index);
        if (geometry) this.addProp(prop, geometry, index);
      });
    }
    map.volumes.forEach((volume, placementIndex) => {
      this.addSensor(volume.box, { kind: 'volume', placementIndex });
    });
    map.jumpPads.forEach((pad, placementIndex) => {
      const half = { x: pad.size.x / 2, y: pad.size.y / 2, z: pad.size.z / 2 };
      const box: Box3 = {
        min: { x: pad.position.x - half.x, y: pad.position.y - half.y, z: pad.position.z - half.z },
        max: { x: pad.position.x + half.x, y: pad.position.y + half.y, z: pad.position.z + half.z },
      };
      this.addSensor(box, { kind: 'jumpPad', placementIndex });
    });
  }

  /** Add one brush as a static collider. `index` is its position in `MapDef.brushes`. */
  addBrush(brush: Brush, index: number): void {
    if (!brushIsValid(brush)) {
      throw new Error(`Brush ${index} (${brush.shape}) has non-positive size`);
    }
    const R = this.rapier;
    const { size } = brush;
    let desc: RColliderDesc | null;
    switch (brush.shape) {
      case 'box':
        desc = R.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2);
        break;
      case 'cylinder':
        desc = R.ColliderDesc.cylinder(size.y / 2, size.x / 2);
        break;
      case 'ramp':
        desc = R.ColliderDesc.convexHull(rampLocalVertices(size));
        break;
    }
    if (!desc) throw new Error(`Brush ${index} (${brush.shape}) produced no collider`);
    desc
      .setTranslation(brush.position.x, brush.position.y, brush.position.z)
      .setRotation(yawQuat(brush.yaw ?? 0))
      .setCollisionGroups(groups(GROUP_WORLD, 0xffff));
    this.track(this.world.createCollider(desc), { kind: 'brush', index });
  }

  /** Add one prop as a static collider using its asset-space geometry. */
  addProp(prop: PropRef, geometry: PropGeometry, index: number): void {
    if (prop.collision === 'none') return;
    const R = this.rapier;
    const verts = scaleVertices(geometry.vertices, prop.scale);
    let desc: RColliderDesc | null;
    let offset: Vec3 = { x: 0, y: 0, z: 0 };
    switch (prop.collision) {
      case 'box': {
        const { center, half } = vertexBounds(verts);
        desc = R.ColliderDesc.cuboid(half.x, half.y, half.z);
        offset = rotateVec(prop.rotation, center);
        break;
      }
      case 'convex':
        desc = R.ColliderDesc.convexHull(verts);
        break;
      case 'trimesh':
        desc = R.ColliderDesc.trimesh(verts, geometry.indices);
        break;
    }
    if (!desc) throw new Error(`Prop ${index} (${prop.asset}) produced no collider`);
    desc
      .setTranslation(
        prop.position.x + offset.x,
        prop.position.y + offset.y,
        prop.position.z + offset.z,
      )
      .setRotation(prop.rotation)
      .setCollisionGroups(groups(GROUP_WORLD, 0xffff));
    this.track(this.world.createCollider(desc), { kind: 'prop', index });
  }

  // -- Sensors --------------------------------------------------------------

  /** Add an axis-aligned sensor box. Actors entering or leaving it are reported by `step()`. */
  addSensor(box: Box3, tag: SensorTag): SensorId {
    const R = this.rapier;
    const hx = (box.max.x - box.min.x) / 2;
    const hy = (box.max.y - box.min.y) / 2;
    const hz = (box.max.z - box.min.z) / 2;
    if (!(hx > 0 && hy > 0 && hz > 0)) throw new Error('Sensor box must have positive extents');
    const desc = R.ColliderDesc.cuboid(hx, hy, hz)
      .setTranslation(box.min.x + hx, box.min.y + hy, box.min.z + hz)
      .setSensor(true)
      .setCollisionGroups(groups(GROUP_SENSOR, 0xffff));
    const collider = this.world.createCollider(desc);
    const id = this.nextSensorId++;
    this.sensors.set(id, { collider, tag });
    this.track(collider, { kind: 'sensor', sensor: id, tag });
    return id;
  }

  /** Remove a sensor. Actors inside it get an `exit` on the next `step()`. */
  removeSensor(id: SensorId): void {
    const rec = this.sensors.get(id);
    if (!rec) return;
    const actorIds = [...this.actors.keys()].sort((a, b) => a - b);
    for (const actorId of actorIds) {
      const actor = this.actors.get(actorId);
      if (!actor) continue;
      const at = actor.inside.indexOf(id);
      if (at >= 0) {
        actor.inside.splice(at, 1);
        this.pendingExits.push({ type: 'exit', actor: actorId, sensor: id, tag: rec.tag });
      }
    }
    this.untrack(rec.collider);
    this.world.removeCollider(rec.collider, false);
    this.sensors.delete(id);
  }

  /** Tag of a sensor, or undefined. */
  sensorTag(id: SensorId): SensorTag | undefined {
    return this.sensors.get(id)?.tag;
  }

  /** Sensors the actor was inside as of the last `step()`, ascending. */
  sensorsContaining(actor: EntityId): readonly SensorId[] {
    return this.actors.get(actor)?.inside ?? [];
  }

  // -- Actors ---------------------------------------------------------------

  /** Add an actor capsule centered at `position`. Throws if the id is already present. */
  addActor(id: EntityId, position: Vec3, capsule: CapsuleDims = PAWN_CAPSULE): void {
    if (this.actors.has(id)) throw new Error(`Actor ${id} already exists`);
    const R = this.rapier;
    const body = this.world.createRigidBody(
      R.RigidBodyDesc.kinematicPositionBased().setTranslation(position.x, position.y, position.z),
    );
    const collider = this.world.createCollider(
      R.ColliderDesc.capsule(capsule.halfHeight, capsule.radius).setCollisionGroups(
        groups(GROUP_ACTOR, 0xffff),
      ),
      body,
    );
    this.actors.set(id, { body, collider, inside: [] });
    this.track(collider, { kind: 'actor', entity: id });
  }

  /** Teleport an actor's capsule center. Queries and sensors see it after `step()`. */
  setActorPosition(id: EntityId, position: Vec3): void {
    const rec = this.actors.get(id);
    if (!rec) throw new Error(`Unknown actor ${id}`);
    rec.body.setTranslation(position, false);
  }

  /** Current capsule center of an actor, or undefined. */
  actorPosition(id: EntityId): Vec3 | undefined {
    const rec = this.actors.get(id);
    return rec ? v3(rec.body.translation()) : undefined;
  }

  /** The actor's Rapier collider, for the character controller. */
  actorCollider(id: EntityId): RCollider | undefined {
    return this.actors.get(id)?.collider;
  }

  /** Remove an actor. It gets `exit` events for every sensor it was in on the next `step()`. */
  removeActor(id: EntityId): void {
    const rec = this.actors.get(id);
    if (!rec) return;
    for (const sensor of rec.inside) {
      const tag = this.sensors.get(sensor)?.tag;
      if (tag) this.pendingExits.push({ type: 'exit', actor: id, sensor, tag });
    }
    this.untrack(rec.collider);
    this.world.removeRigidBody(rec.body);
    this.actors.delete(id);
  }

  // -- Step -----------------------------------------------------------------

  /**
   * Refresh query structures after colliders were added or moved, then report
   * sensor transitions since the previous step.
   *
   * Order: exits owed by removals (in removal order), then for each actor in
   * ascending id: its exits, then its enters, each by ascending sensor id.
   */
  step(): SensorEvent[] {
    this.assertLive();
    this.world.step();
    const events = this.pendingExits;
    this.pendingExits = [];
    const actorIds = [...this.actors.keys()].sort((a, b) => a - b);
    for (const actorId of actorIds) {
      const actor = this.actors.get(actorId);
      if (!actor) continue;
      const now = this.sensorsOverlapping(actor.collider);
      const before = actor.inside;
      for (const s of before) {
        if (!now.includes(s)) events.push(this.sensorEvent('exit', actorId, s));
      }
      for (const s of now) {
        if (!before.includes(s)) events.push(this.sensorEvent('enter', actorId, s));
      }
      actor.inside = now;
    }
    return events;
  }

  // -- Queries --------------------------------------------------------------

  /** First collider hit by a ray, or null. `direction` need not be normalised. */
  raycast(
    origin: Vec3,
    direction: Vec3,
    maxDistance: number,
    options: QueryOptions = {},
  ): RayHit | null {
    this.assertLive();
    const dir = normalize(direction);
    if (!dir || !(maxDistance > 0)) return null;
    const ray = new this.rapier.Ray(origin, dir);
    const hit = this.world.castRayAndGetNormal(
      ray,
      maxDistance,
      true,
      undefined,
      this.queryGroups(options),
      undefined,
      this.ignoredBody(options),
    );
    if (!hit) return null;
    const tag = this.tags.get(hit.collider.handle);
    if (!tag) return null;
    const d = hit.timeOfImpact;
    return {
      distance: d,
      point: { x: origin.x + dir.x * d, y: origin.y + dir.y * d, z: origin.z + dir.z * d },
      normal: v3(hit.normal),
      collider: tag,
    };
  }

  /**
   * Sweep `shape` from `origin` along `direction` up to `maxDistance` and return
   * the first hit, or null. Used for projectile motion and movement sweeps.
   */
  castShape(
    shape: QueryShape,
    origin: Vec3,
    direction: Vec3,
    maxDistance: number,
    options: QueryOptions & { rotation?: Quat } = {},
  ): ShapeHit | null {
    this.assertLive();
    const dir = normalize(direction);
    if (!dir || !(maxDistance >= 0)) return null;
    const rotation = options.rotation ?? IDENTITY;
    const rshape = this.makeShape(shape);

    // Rapier's sweep is unreliable when the shape starts inside a collider (it
    // can return no hit when moving deeper) and stops at once on surfaces it
    // only grazes, so classify start contacts first.
    const { deepest: inside, grazing } = this.startContacts(rshape, origin, rotation, dir, options);
    if (inside) {
      return {
        distance: 0,
        position: v3(origin),
        point: inside.point,
        normal: inside.normal,
        startedInside: true,
        collider: inside.tag,
      };
    }

    const hit = this.world.castShape(
      origin,
      rotation,
      dir,
      rshape,
      0,
      maxDistance,
      false,
      undefined,
      this.queryGroups(options),
      undefined,
      this.ignoredBody(options),
      grazing.size > 0 ? (collider) => !grazing.has(collider.handle) : undefined,
    );
    if (!hit) return null;
    const tag = this.tags.get(hit.collider.handle);
    if (!tag) return null;
    const d = hit.time_of_impact;
    return {
      distance: d,
      position: { x: origin.x + dir.x * d, y: origin.y + dir.y * d, z: origin.z + dir.z * d },
      point: v3(hit.witness1),
      normal: v3(hit.normal1),
      startedInside: false,
      collider: tag,
    };
  }

  /** Every collider overlapping `shape` at `position`, in a stable order (by kind, then id). */
  overlap(
    shape: QueryShape,
    position: Vec3,
    options: QueryOptions & { rotation?: Quat } = {},
  ): ColliderTag[] {
    this.assertLive();
    const found: ColliderTag[] = [];
    this.world.intersectionsWithShape(
      position,
      options.rotation ?? IDENTITY,
      this.makeShape(shape),
      (collider) => {
        const tag = this.tags.get(collider.handle);
        if (tag) found.push(tag);
        return true;
      },
      undefined,
      this.queryGroups(options),
      undefined,
      this.ignoredBody(options),
    );
    return found.sort(compareTags);
  }

  /** Tag for a raw Rapier collider, or undefined (e.g. for results of raw-world queries). */
  colliderTag(collider: RCollider): ColliderTag | undefined {
    return this.tags.get(collider.handle);
  }

  /** Free the Rapier world. The instance is unusable afterwards. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.world.free();
    this.tags.clear();
    this.actors.clear();
    this.sensors.clear();
  }

  // -- Helpers --------------------------------------------------------------

  private track(collider: RCollider, tag: ColliderTag): void {
    this.tags.set(collider.handle, tag);
  }

  private untrack(collider: RCollider): void {
    this.tags.delete(collider.handle);
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('PhysicsWorld used after dispose()');
  }

  private queryGroups(options: QueryOptions): number {
    return groups(0xffff, options.mask ?? HIT_SOLID);
  }

  private ignoredBody(options: QueryOptions): RRigidBody | undefined {
    return options.ignoreActor === undefined
      ? undefined
      : this.actors.get(options.ignoreActor)?.body;
  }

  private makeShape(shape: QueryShape): RShape {
    const R = this.rapier;
    switch (shape.type) {
      case 'sphere':
        return new R.Ball(shape.radius);
      case 'capsule':
        return new R.Capsule(shape.halfHeight, shape.radius);
      case 'box':
        return new R.Cuboid(shape.halfExtents.x, shape.halfExtents.y, shape.halfExtents.z);
    }
  }

  /**
   * Classify what `shape` touches at its start position:
   * - `deepest`: the collider it penetrates most deeply (beyond `PENETRATION_EPSILON`),
   *   ties broken by `compareTags`; null if it only touches or is clear.
   * - `grazing`: handles of colliders it merely touches without moving into them
   *   along `dir`. The sweep ignores these so a sphere resting on a floor can slide.
   */
  private startContacts(
    shape: RShape,
    position: Vec3,
    rotation: Quat,
    dir: Vec3,
    options: QueryOptions,
  ): {
    deepest: { tag: ColliderTag; point: Vec3; normal: Vec3 } | null;
    grazing: Set<number>;
  } {
    let best: { tag: ColliderTag; point: Vec3; normal: Vec3; depth: number } | null = null;
    const grazing = new Set<number>();
    this.world.intersectionsWithShape(
      position,
      rotation,
      shape,
      (collider) => {
        const tag = this.tags.get(collider.handle);
        const contact = tag && collider.contactShape(shape, position, rotation, 0);
        if (!tag || !contact) return true;
        const depth = -contact.distance;
        if (depth <= PENETRATION_EPSILON) {
          const n = contact.normal1;
          // normal1 points out of the collider; a negative dot means moving into it.
          if (n.x * dir.x + n.y * dir.y + n.z * dir.z > -1e-6) grazing.add(collider.handle);
          return true;
        }
        if (
          !best ||
          depth > best.depth ||
          (depth === best.depth && compareTags(tag, best.tag) < 0)
        ) {
          best = { tag, point: v3(contact.point1), normal: v3(contact.normal1), depth };
        }
        return true;
      },
      undefined,
      this.queryGroups(options),
      undefined,
      this.ignoredBody(options),
    );
    return { deepest: best, grazing };
  }

  private sensorsOverlapping(actorCollider: RCollider): SensorId[] {
    const ids: SensorId[] = [];
    this.world.intersectionsWithShape(
      actorCollider.translation(),
      actorCollider.rotation(),
      actorCollider.shape,
      (collider) => {
        const tag = this.tags.get(collider.handle);
        if (tag?.kind === 'sensor') ids.push(tag.sensor);
        return true;
      },
      this.rapier.QueryFilterFlags.EXCLUDE_SOLIDS,
      groups(0xffff, GROUP_SENSOR),
    );
    return ids.sort((a, b) => a - b);
  }

  private sensorEvent(type: 'enter' | 'exit', actor: EntityId, sensor: SensorId): SensorEvent {
    const tag = this.sensors.get(sensor)?.tag;
    if (!tag) throw new Error(`Unknown sensor ${sensor}`);
    return { type, actor, sensor, tag };
  }
}

const KIND_ORDER: Record<ColliderTag['kind'], number> = { brush: 0, prop: 1, actor: 2, sensor: 3 };

function tagKey(tag: ColliderTag): number {
  switch (tag.kind) {
    case 'brush':
    case 'prop':
      return tag.index;
    case 'actor':
      return tag.entity;
    case 'sensor':
      return tag.sensor;
  }
}

function compareTags(a: ColliderTag, b: ColliderTag): number {
  return KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || tagKey(a) - tagKey(b);
}
