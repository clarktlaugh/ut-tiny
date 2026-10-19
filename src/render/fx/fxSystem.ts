/**
 * `FxSystem` (docs/DESIGN.md §8.3): turns `SimEvent`s into pooled visual
 * effects. Owns an additive and an alpha particle layer, beam ribbons, light
 * flashes, decals and gibs, all under one `root` to add to the scene.
 *
 * Usage per rendered frame, after `SceneView.handleEvents` / `sync`:
 *   fx.handleEvents(eventsSinceLastFrame, currentState);
 *   fx.update(dt, camera, currentState);
 *
 * Rules (§12): every pool is sized at construction and never grows; a full
 * pool recycles its oldest member. Randomness comes from a seeded `Rng`, so
 * the same events at the same ticks give the same frame.
 */
import { Group, type Camera, type DataTexture } from 'three';
import type {
  DamageType,
  EntityId,
  EntityState,
  PawnState,
  PickupType,
  SimEvent,
  Vec3,
  WorldState,
} from '../../sim/types';
import { NO_ENTITY } from '../../sim/types';
import { Rng } from '../../sim/rng';
import { MARKER_COLORS } from '../scene/mapView';
import { PAWN_HEIGHT, playerColor } from '../scene/entityViews';
import { createAtlasTexture } from './atlas';
import { BeamPool } from './beams';
import { DecalPool } from './decals';
import * as recipes from './effects';
import { LightFlashPool } from './flashes';
import { GibPool } from './gibs';
import { ParticleLayer } from './particles';
import { NO_SURFACE, type SurfaceProbe } from './surface';

export interface FxCapacities {
  /** Additive particles (glows, sparks, fire). */
  light: number;
  /** Alpha-blended particles (smoke, dust, blood). */
  matter: number;
  beams: number;
  flashes: number;
  decals: number;
  gibs: number;
}

/** Pool sizes tuned for the §12 budget on an integrated GPU. */
export const DEFAULT_CAPACITIES: Readonly<FxCapacities> = Object.freeze({
  light: 1024,
  matter: 768,
  beams: 32,
  flashes: 4,
  decals: 64,
  gibs: 48,
});

export interface FxSystemOptions {
  /** RNG seed; the same seed and events give the same effects. */
  seed?: number;
  capacities?: Partial<FxCapacities>;
  /** How to find surfaces for decals and gib floors; defaults to none. */
  surface?: SurfaceProbe;
}

/** Live counts, pool allocations and spawn totals, for the HUD and tests. */
export interface FxStats {
  light: number;
  matter: number;
  beams: number;
  flashes: number;
  decals: number;
  gibs: number;
  /** Constructor-time allocations across every pool. Must not change after construction. */
  allocations: number;
  /** Objects under `root`. Must not change after construction. */
  children: number;
  /** Particles recycled because a pool was full. */
  recycled: number;
}

/** Full-screen flash state for the HUD overlay (Redeemer, §5). */
export interface ScreenFlash {
  /** 0..1 opacity. */
  intensity: number;
  color: number;
}

/** Damage types that never splash blood (the damage pipeline's environmental kinds). */
const BLOODLESS: ReadonlySet<DamageType> = new Set<DamageType>([
  'fall',
  'killVolume',
  'damageVolume',
  'suicide',
  'telefrag',
]);

/** Impact speed above which landing kicks up dust (§4: fall damage starts at 20 m/s). */
const DUST_LANDING_SPEED = 9;

interface Trail {
  last: Vec3;
  carry: number;
  seen: boolean;
}

export class FxSystem {
  readonly root = new Group();
  readonly atlas: DataTexture;
  readonly light: ParticleLayer;
  readonly matter: ParticleLayer;
  readonly beams: BeamPool;
  readonly flashes: LightFlashPool;
  readonly decals: DecalPool;
  readonly gibs: GibPool;
  readonly rng: Rng;
  readonly capacities: Readonly<FxCapacities>;
  surface: SurfaceProbe;
  readonly screenFlash: ScreenFlash = { intensity: 0, color: 0xffffff };

  private flashAge = 0;
  private flashLife = 0;
  private flashPeak = 0;
  /** Camera position at the last update; the observer for the screen flash. */
  private readonly observer: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly entities = new Map<EntityId, EntityState>();
  private readonly trails = new Map<EntityId, Trail>();
  private readonly scratch: Vec3 = { x: 0, y: 0, z: 0 };
  private disposed = false;

  constructor(options: FxSystemOptions = {}) {
    this.capacities = { ...DEFAULT_CAPACITIES, ...options.capacities };
    this.rng = new Rng(options.seed ?? 0x5eed);
    this.surface = options.surface ?? NO_SURFACE;
    this.atlas = createAtlasTexture();
    const c = this.capacities;
    this.light = new ParticleLayer('additive', this.atlas, c.light);
    this.matter = new ParticleLayer('alpha', this.atlas, c.matter);
    this.beams = new BeamPool(c.beams);
    this.flashes = new LightFlashPool(c.flashes);
    this.decals = new DecalPool(this.atlas, c.decals);
    this.gibs = new GibPool(c.gibs);
    this.root.name = 'fx';
    this.root.add(
      this.decals.mesh,
      this.matter.mesh,
      this.light.mesh,
      this.beams.mesh,
      this.gibs.mesh,
      this.flashes.root,
    );
  }

  stats(): FxStats {
    let children = 0;
    this.root.traverse(() => children++);
    return {
      light: this.light.size,
      matter: this.matter.size,
      beams: this.beams.size,
      flashes: this.flashes.size,
      decals: this.decals.size,
      gibs: this.gibs.size,
      allocations:
        this.light.allocations.count +
        this.matter.allocations.count +
        this.beams.allocations.count +
        this.flashes.allocations.count +
        this.decals.allocations.count +
        this.gibs.allocations.count,
      children,
      recycled:
        this.light.pool.recycled +
        this.matter.pool.recycled +
        this.beams.pool.recycled +
        this.flashes.pool.recycled +
        this.gibs.pool.recycled,
    };
  }

  /**
   * Spawn effects for this frame's events. `state` is the tick the events
   * belong to; it supplies positions for pawn- and pickup-relative effects.
   */
  handleEvents(events: readonly SimEvent[], state?: Readonly<WorldState>): void {
    if (this.disposed) return;
    this.index(state);
    for (const e of events) {
      switch (e.type) {
        case 'shotFired':
          recipes.muzzleFlash(this, e.weapon, e.origin, e.direction);
          break;
        case 'hitscan': {
          const hitPawn = e.hitPawn !== NO_ENTITY;
          recipes.tracer(this, e.weapon, e.from, e.to);
          recipes.lingeringBeam(this, e.weapon, e.from, e.to);
          recipes.hitscanImpact(this, e.weapon, e.from, e.to, hitPawn, e.headshot);
          break;
        }
        case 'explosion': {
          const fx = recipes.explosion(this, e.position, e.radius, e.damageType);
          if (fx?.screenFlash) this.startScreenFlash(e.position, e.radius, fx.screenFlash);
          break;
        }
        case 'damage': {
          if (BLOODLESS.has(e.damageType) || e.amount <= 0) break;
          const pawn = this.pawn(e.target);
          if (pawn) recipes.pawnHit(this, this.chest(pawn), e.momentum, e.amount);
          break;
        }
        case 'death': {
          const pawn = this.pawn(e.victim);
          if (!pawn) break;
          const at = this.chest(pawn);
          const floor = this.surface(at, { x: 0, y: -1, z: 0 }, 60);
          recipes.gibPawn(this, at, playerColor(pawn.playerId), floor ? floor.point.y : -Infinity);
          break;
        }
        case 'teleport':
          recipes.teleportFlash(this, e.from, e.to);
          break;
        case 'land': {
          if (e.impactSpeed < DUST_LANDING_SPEED) break;
          const pawn = this.pawn(e.pawn);
          if (pawn) recipes.dust(this, this.feet(pawn), 1 + e.impactSpeed / 8);
          break;
        }
        case 'jumpPad': {
          const pawn = this.pawn(e.pawn);
          if (pawn) recipes.dust(this, this.feet(pawn), 4);
          break;
        }
        case 'pickupTaken': {
          const pickup = this.entities.get(e.pickup);
          if (pickup) recipes.sparkle(this, pickup.position, pickupColor(e.pickupType));
          break;
        }
        case 'entityDestroyed':
          this.trails.delete(e.id);
          break;
        default:
          break;
      }
    }
  }

  /**
   * Advance all effects by `dt` seconds. `camera` orients beams and is the
   * observer for the screen flash; `state` drives projectile trails.
   */
  update(dt: number, camera: Camera | Readonly<Vec3>, state?: Readonly<WorldState>): void {
    if (this.disposed) return;
    const eye = 'position' in camera && 'isCamera' in camera ? camera.position : (camera as Vec3);
    this.observer.x = eye.x;
    this.observer.y = eye.y;
    this.observer.z = eye.z;
    if (state) this.emitTrails(state);
    this.light.update(dt);
    this.matter.update(dt);
    this.beams.update(dt, this.observer);
    this.flashes.update(dt);
    this.decals.update(dt);
    this.gibs.update(dt);
    if (this.flashLife > 0) {
      this.flashAge += dt;
      if (this.flashAge >= this.flashLife) {
        this.flashLife = 0;
        this.screenFlash.intensity = 0;
      } else {
        const k = 1 - this.flashAge / this.flashLife;
        this.screenFlash.intensity = this.flashPeak * k * k;
      }
    }
  }

  /** Remove every live effect, keeping the pools. */
  clear(): void {
    this.light.clear();
    this.matter.clear();
    this.beams.clear();
    this.flashes.clear();
    this.decals.clear();
    this.gibs.clear();
    this.trails.clear();
    this.flashLife = 0;
    this.screenFlash.intensity = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    this.light.dispose();
    this.matter.dispose();
    this.beams.dispose();
    this.flashes.dispose();
    this.decals.dispose();
    this.gibs.dispose();
    this.atlas.dispose();
    this.root.removeFromParent();
    this.root.clear();
  }

  // -------------------------------------------------------------------------

  private index(state?: Readonly<WorldState>): void {
    this.entities.clear();
    if (!state) return;
    for (const e of state.entities) this.entities.set(e.id, e);
  }

  private pawn(id: EntityId): PawnState | undefined {
    const e = this.entities.get(id);
    return e?.kind === 'pawn' ? e : undefined;
  }

  /** Capsule center, where hits and gibs originate. */
  private chest(pawn: PawnState): Vec3 {
    const s = this.scratch;
    s.x = pawn.position.x;
    s.y = pawn.position.y;
    s.z = pawn.position.z;
    return s;
  }

  private feet(pawn: PawnState): Vec3 {
    const s = this.chest(pawn);
    s.y -= PAWN_HEIGHT / 2;
    return s;
  }

  private startScreenFlash(center: Readonly<Vec3>, radius: number, life: number): void {
    const d = Math.hypot(
      this.observer.x - center.x,
      this.observer.y - center.y,
      this.observer.z - center.z,
    );
    const peak = Math.min(1, Math.max(0, 1.3 - d / (radius * 1.6)));
    if (peak <= 0) return;
    this.flashPeak = Math.max(peak, this.flashLife > 0 ? this.screenFlash.intensity : 0);
    this.flashAge = 0;
    this.flashLife = life;
    this.screenFlash.intensity = this.flashPeak;
    this.screenFlash.color = 0xfff4dc;
  }

  private emitTrails(state: Readonly<WorldState>): void {
    for (const t of this.trails.values()) t.seen = false;
    for (const e of state.entities) {
      if (e.kind !== 'projectile') continue;
      let t = this.trails.get(e.id);
      if (!t) {
        t = { last: { x: e.position.x, y: e.position.y, z: e.position.z }, carry: 0, seen: true };
        this.trails.set(e.id, t);
        continue;
      }
      t.seen = true;
      t.carry = recipes.trail(this, e.projectileType, t.last, e.position, t.carry);
      t.last.x = e.position.x;
      t.last.y = e.position.y;
      t.last.z = e.position.z;
    }
    for (const [id, t] of this.trails) if (!t.seen) this.trails.delete(id);
  }
}

/** Sparkle color for a pickup kind (the scene view's marker colors). */
export function pickupColor(type: PickupType): number {
  return MARKER_COLORS.pickup[type];
}
