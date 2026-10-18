/**
 * Placeholder meshes for dynamic entities, and the interpolation helpers the
 * scene view uses to place them between two sim ticks (docs/DESIGN.md §8.3).
 *
 * Conventions:
 * - `PawnState.position` is the capsule center, as in the physics glue
 *   (`PAWN_CAPSULE`: 1.8 m tall, radius 0.4 m, §3).
 * - Yaw 0 faces −Z; positive yaw turns toward −X (right-handed about +Y), the
 *   same as a Three.js camera with `rotation.y = yaw`.
 */
import {
  BoxGeometry,
  CapsuleGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  OctahedronGeometry,
  SphereGeometry,
  type BufferGeometry,
  type Object3D,
} from 'three';
import type { EntityState, PickupType, ProjectileType, Vec3 } from '../../sim/types';
import { hashString } from './materials';
import { MARKER_COLORS } from './mapView';

/** Pawn body dimensions (§3). Kept in step with `PAWN_CAPSULE` in the physics glue. */
export const PAWN_RADIUS = 0.4;
export const PAWN_HEIGHT = 1.8;
/** Eye height above the feet (§3). */
export const PAWN_EYE_HEIGHT = 1.6;

/** Entity kinds that get a dynamic view; jump pads and volumes are drawn from the `MapDef`. */
export type ViewedKind = 'pawn' | 'projectile' | 'mine' | 'pickup';

export function isViewedKind(kind: EntityState['kind']): kind is ViewedKind {
  return kind === 'pawn' || kind === 'projectile' || kind === 'mine' || kind === 'pickup';
}

/** Linear interpolation. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Interpolate angles in radians along the shortest arc. */
export function lerpAngle(a: number, b: number, t: number): number {
  const twoPi = Math.PI * 2;
  let d = (b - a) % twoPi;
  if (d > Math.PI) d -= twoPi;
  else if (d < -Math.PI) d += twoPi;
  return a + d * t;
}

export function lerpVec3(a: Vec3, b: Vec3, t: number, out: Vec3): Vec3 {
  out.x = lerp(a.x, b.x, t);
  out.y = lerp(a.y, b.y, t);
  out.z = lerp(a.z, b.z, t);
  return out;
}

/** Stable, saturated body color per player id. */
export function playerColor(playerId: string): number {
  const hue = (hashString(playerId) % 360) / 360;
  // HSL → RGB for s = 0.65, l = 0.5, without allocating a Color.
  const s = 0.65;
  const l = 0.5;
  const q = l + s - l * s;
  const p = 2 * l - q;
  const ch = (t: number): number => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  const r = Math.round(ch(hue + 1 / 3) * 255);
  const g = Math.round(ch(hue) * 255);
  const b = Math.round(ch(hue - 1 / 3) * 255);
  return (r << 16) | (g << 8) | b;
}

const PROJECTILE_COLORS: Record<ProjectileType, number> = {
  rocket: 0xff7a2e,
  grenade: 0x6b8f3a,
  redeemer: 0xe0e0e0,
  disc: 0x40c0ff,
};

/**
 * Shared geometry and materials for entity placeholders. One instance per
 * scene view; entity meshes reference these and never own GPU resources, so
 * creating and destroying views does not allocate GPU buffers.
 */
export class EntityAssets {
  readonly capsule: BufferGeometry = new CapsuleGeometry(
    PAWN_RADIUS,
    PAWN_HEIGHT - 2 * PAWN_RADIUS,
    6,
    16,
  );
  readonly visor: BufferGeometry = new BoxGeometry(0.5, 0.15, 0.2);
  readonly projectile: BufferGeometry = new SphereGeometry(0.2, 12, 8);
  readonly mine: BufferGeometry = new SphereGeometry(0.15, 10, 6);
  readonly pickup: BufferGeometry = new OctahedronGeometry(0.45);
  readonly visorMaterial = new MeshStandardMaterial({ color: 0x15181c, roughness: 0.3 });
  private readonly materials = new Map<string, MeshStandardMaterial>();

  material(key: string, color: number, emissive = 0): MeshStandardMaterial {
    let m = this.materials.get(key);
    if (!m) {
      m = new MeshStandardMaterial({ color, emissive, roughness: 0.6 });
      this.materials.set(key, m);
    }
    return m;
  }

  dispose(): void {
    this.capsule.dispose();
    this.visor.dispose();
    this.projectile.dispose();
    this.mine.dispose();
    this.pickup.dispose();
    this.visorMaterial.dispose();
    for (const m of this.materials.values()) m.dispose();
    this.materials.clear();
  }
}

/** A placed view for one entity. */
export interface EntityView {
  readonly id: number;
  readonly kind: ViewedKind;
  readonly object: Object3D;
}

/** Build the placeholder object for an entity. Returns undefined for kinds without a view. */
export function createEntityView(
  entity: EntityState,
  assets: EntityAssets,
): EntityView | undefined {
  switch (entity.kind) {
    case 'pawn': {
      const root = new Group();
      root.name = `pawn:${entity.id}:${entity.playerId}`;
      const body = new Mesh(
        assets.capsule,
        assets.material(`player:${entity.playerId}`, playerColor(entity.playerId)),
      );
      body.name = 'body';
      body.castShadow = true;
      body.receiveShadow = true;
      // Visor at eye height on the −Z side so facing is visible.
      const visor = new Mesh(assets.visor, assets.visorMaterial);
      visor.name = 'visor';
      visor.position.set(0, PAWN_EYE_HEIGHT - PAWN_HEIGHT / 2, -(PAWN_RADIUS - 0.05));
      root.add(body, visor);
      return { id: entity.id, kind: 'pawn', object: root };
    }
    case 'projectile': {
      const t = entity.projectileType;
      const mesh = new Mesh(
        assets.projectile,
        assets.material(`projectile:${t}`, PROJECTILE_COLORS[t], PROJECTILE_COLORS[t]),
      );
      mesh.name = `projectile:${entity.id}:${t}`;
      return { id: entity.id, kind: 'projectile', object: mesh };
    }
    case 'mine': {
      const mesh = new Mesh(assets.mine, assets.material('mine', 0x30363c, 0x400000));
      mesh.name = `mine:${entity.id}`;
      return { id: entity.id, kind: 'mine', object: mesh };
    }
    case 'pickup': {
      const type: PickupType = entity.type;
      const color = MARKER_COLORS.pickup[type];
      const mesh = new Mesh(
        assets.pickup,
        assets.material(`pickup:${type}`, color, color & 0x3f3f3f),
      );
      mesh.name = `pickup:${entity.id}:${type}`;
      return { id: entity.id, kind: 'pickup', object: mesh };
    }
    default:
      return undefined;
  }
}

const scratch: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Place a view between the previous and current state of its entity. `prev`
 * may be undefined (just spawned, or snapping after a teleport/respawn).
 */
export function placeEntityView(
  view: EntityView,
  prev: EntityState | undefined,
  curr: EntityState,
  alpha: number,
): void {
  const from = prev && prev.kind === curr.kind ? prev : curr;
  const p = lerpVec3(from.position, curr.position, alpha, scratch);
  const obj = view.object;
  obj.position.set(p.x, p.y, p.z);
  switch (curr.kind) {
    case 'pawn': {
      const fromYaw = from.kind === 'pawn' ? from.yaw : curr.yaw;
      obj.rotation.y = lerpAngle(fromYaw, curr.yaw, alpha);
      obj.visible = curr.alive;
      const crouchScale = curr.crouching ? 0.6 : 1;
      obj.scale.set(1, crouchScale, 1);
      break;
    }
    case 'projectile': {
      const q = curr.orientation;
      obj.quaternion.set(q.x, q.y, q.z, q.w);
      break;
    }
    case 'pickup':
      obj.visible = curr.available;
      break;
    default:
      break;
  }
}
