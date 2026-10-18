/**
 * Projectile entity (docs/DESIGN.md §5, §8.1): spawn, shape-cast motion,
 * bounce, fuse, guidance, detonation and splash.
 *
 * Motion is a sphere sweep through the `PhysicsWorld` each tick, so projectiles
 * never tunnel through walls or pawns. `straight` projectiles fly at constant
 * velocity; `lob` projectiles fall under the movement gravity, bounce with
 * restitution and friction, and come to rest when slow on a floor. A fused
 * projectile detonates at `detonateAt`. A guided projectile turns toward its
 * owner's yaw/pitch input at `GUIDE_YAW_RATE` / `GUIDE_PITCH_RATE` (§5.1).
 *
 * Impact resolution asks the weapon's module (`WeaponModule.onImpact`) and
 * falls back to `defaultImpact`: straight projectiles detonate on anything;
 * lobs detonate on a pawn when they carry damage and bounce off everything
 * else.
 *
 * Detonation deals the mode's `damage` directly to a pawn hit (knockback along
 * the flight path), then `applySplash` to everyone else in `splashRadius`.
 */
import { DEFAULT_MOVEMENT, clampPitch } from '../../movement';
import type { ShapeHit } from '../../physics/physicsWorld';
import {
  Buttons,
  NO_ENTITY,
  TICK_DT,
  TICK_RATE,
  type InputCommand,
  type PawnState,
  type Quat,
  type SimEvent,
  type Tick,
  type Vec3,
} from '../../types';
import {
  damageTypeFor,
  type ImpactAction,
  type ImpactContext,
  type ProjectileRecord,
  type ProjectileSpawn,
  type RemoveReason,
  type WeaponHost,
  type WeaponModule,
  type WeaponServices,
} from './host';
import {
  add,
  anglesFromDirection,
  directionFromAngles,
  dot,
  length,
  normalize,
  scale,
  sub,
  wrapAngle,
} from './math';
import { applySplash } from './splash';

/** Collision sphere radius, m. */
export const PROJECTILE_RADIUS = 0.15;
/** Gravity on lobbed projectiles; the pawn gravity from §4 so arcs feel consistent. */
export const LOB_GRAVITY = DEFAULT_MOVEMENT.gravity;
/** Fraction of normal speed kept after a bounce. */
export const LOB_RESTITUTION = 0.5;
/** Fraction of tangential speed kept after a bounce. */
export const LOB_FRICTION = 0.8;
/** A lob slower than this after bouncing off a floor comes to rest, m/s. */
export const REST_SPEED = 1.5;
/** Floors for the purpose of coming to rest have a normal at least this upright. */
export const REST_NORMAL_Y = 0.7;
/** Straight projectiles that hit nothing for this long are removed. */
export const MAX_FLIGHT_SECONDS = 15;
/** Anything that falls below this height is removed. */
export const KILL_PLANE_Y = -500;
/** The owner's own capsule is ignored for this long after launch. */
export const OWNER_SAFE_SECONDS = 0.15;
/** Guided steering limits (§5.1), rad/s. */
export const GUIDE_YAW_RATE = (70 * Math.PI) / 180;
export const GUIDE_PITCH_RATE = (50 * Math.PI) / 180;
/** A shot-down warhead fizzles (§5): small blast instead of a nuke. */
export const FIZZLE_RADIUS = 4;
export const FIZZLE_DAMAGE = 30;
/** Gap left between a projectile and the surface it touched, m. */
const SKIN = 0.01;

/** What the projectile stepper needs from the system each tick. */
export interface ProjectileEnv {
  host: WeaponHost;
  services: WeaponServices;
  tick: Tick;
  events: SimEvent[];
  module: WeaponModule | undefined;
  /** The owner's input this tick, for guidance. */
  ownerInput: Readonly<InputCommand> | undefined;
  /** Remove the projectile from the system (emits `entityDestroyed`). */
  remove(rec: ProjectileRecord, reason: RemoveReason): void;
}

/** Quaternion with yaw about +Y then pitch about the local X axis. */
export function orientationFor(yaw: number, pitch: number): Quat {
  const cy = Math.cos(yaw / 2);
  const sy = Math.sin(yaw / 2);
  const cp = Math.cos(pitch / 2);
  const sp = Math.sin(pitch / 2);
  return { x: cy * sp, y: sy * cp, z: -sy * sp, w: cy * cp };
}

function faceVelocity(rec: ProjectileRecord): void {
  const v = rec.state.velocity;
  if (length(v) === 0) return;
  const { yaw, pitch } = anglesFromDirection(v);
  rec.state.orientation = orientationFor(yaw, pitch);
}

/** Build a record and its snapshot state. Emits `entitySpawned`. */
export function createProjectile(
  host: WeaponHost,
  spawn: ProjectileSpawn,
  tick: Tick,
  events: SimEvent[],
): ProjectileRecord {
  const id = host.allocateEntityId();
  const fuseTicks = spawn.fuseTicks ?? Math.round((spawn.def.fuse ?? 0) * TICK_RATE);
  const guided = spawn.guided ?? false;
  const radius = spawn.radius ?? PROJECTILE_RADIUS;
  const rec: ProjectileRecord = {
    state: {
      id,
      kind: 'projectile',
      position: { ...spawn.position },
      projectileType: spawn.projectileType,
      owner: spawn.owner,
      velocity: { ...spawn.velocity },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
      health: spawn.health ?? spawn.def.projectileHealth ?? 0,
      guided,
      landed: false,
      disrupted: false,
      detonateAt: fuseTicks > 0 ? tick + fuseTicks : 0,
    },
    weapon: spawn.weapon,
    mode: spawn.mode,
    def: spawn.def,
    motion: spawn.motion,
    radius,
    hitRadius: spawn.hitRadius ?? radius,
    restitution: spawn.restitution ?? LOB_RESTITUTION,
    spawnTick: tick,
    ownerSafeUntil: tick + Math.round(OWNER_SAFE_SECONDS * TICK_RATE),
    bounces: 0,
    detonateOnOwnerDeath: spawn.detonateOnOwnerDeath ?? guided,
    custom: {},
  };
  faceVelocity(rec);
  events.push({ type: 'entitySpawned', tick, id, kind: 'projectile' });
  return rec;
}

/** Default impact rule when the weapon's module has no `onImpact`. */
export function defaultImpact(
  rec: Readonly<ProjectileRecord>,
  hitPawn: Readonly<PawnState> | undefined,
): ImpactAction {
  if (rec.motion === 'straight') return 'detonate';
  return hitPawn && rec.def.damage > 0 ? 'detonate' : 'bounce';
}

/**
 * Advance one projectile by one tick. The projectile may be removed by the
 * time this returns (detonated, destroyed, expired).
 */
export function stepProjectile(rec: ProjectileRecord, env: ProjectileEnv): void {
  const s = rec.state;
  const { tick } = env;

  if (s.guided) {
    const owner = env.host.pawn(s.owner);
    if (!owner?.alive || owner.guiding !== s.id) {
      detonateProjectile(rec, env, s.position);
      return;
    }
    if (env.ownerInput) {
      if (env.ownerInput.buttons & Buttons.Fire && tick > rec.spawnTick) {
        detonateProjectile(rec, env, s.position);
        return;
      }
      steer(rec, env.ownerInput);
    }
  }

  if (!s.landed) {
    if (rec.motion === 'lob') s.velocity.y -= LOB_GRAVITY * TICK_DT;
    const move = scale(s.velocity, TICK_DT);
    const dist = length(move);
    if (dist > 0) {
      const hit = env.host.physics.castShape(
        { type: 'sphere', radius: rec.radius },
        s.position,
        move,
        dist,
        {
          ignoreActor: tick < rec.ownerSafeUntil ? s.owner : undefined,
        },
      );
      if (hit) {
        if (resolveImpact(rec, env, hit)) return;
      } else {
        s.position = add(s.position, move);
      }
    }
    faceVelocity(rec);
  }

  if (s.detonateAt > 0 && tick >= s.detonateAt) {
    detonateProjectile(rec, env, s.position);
    return;
  }
  if (s.position.y < KILL_PLANE_Y) {
    env.remove(rec, 'expired');
    return;
  }
  if (rec.motion === 'straight' && tick - rec.spawnTick >= MAX_FLIGHT_SECONDS * TICK_RATE) {
    env.remove(rec, 'expired');
  }
}

/** Turn a guided projectile toward the owner's view angles within the §5.1 rate limits. */
export function steer(rec: ProjectileRecord, input: Readonly<InputCommand>): void {
  const s = rec.state;
  const speed = length(s.velocity);
  if (speed === 0) return;
  const current = anglesFromDirection(s.velocity);
  const maxYaw = GUIDE_YAW_RATE * TICK_DT;
  const maxPitch = GUIDE_PITCH_RATE * TICK_DT;
  const dYaw = Math.max(-maxYaw, Math.min(maxYaw, wrapAngle(input.yaw - current.yaw)));
  const dPitch = Math.max(-maxPitch, Math.min(maxPitch, clampPitch(input.pitch) - current.pitch));
  const dir = directionFromAngles(current.yaw + dYaw, current.pitch + dPitch);
  s.velocity = scale(dir, speed);
}

/** Returns true when the projectile was removed. */
function resolveImpact(rec: ProjectileRecord, env: ProjectileEnv, hit: ShapeHit): boolean {
  const s = rec.state;
  const normal = length(hit.normal) > 0 ? normalize(hit.normal) : normalize(scale(s.velocity, -1));
  s.position = add(hit.position, scale(normal, SKIN));

  let hitPawn: PawnState | undefined;
  if (hit.collider.kind === 'actor') {
    const pawn = env.host.pawn(hit.collider.entity);
    if (pawn?.alive) hitPawn = pawn;
  }

  const ctx: ImpactContext = {
    host: env.host,
    services: env.services,
    tick: env.tick,
    projectile: rec,
    hit,
    hitPawn,
    events: env.events,
  };
  const action = env.module?.onImpact?.(ctx) ?? defaultImpact(rec, hitPawn);
  switch (action) {
    case 'detonate':
      detonateProjectile(rec, env, s.position, hitPawn);
      return true;
    case 'destroy':
      env.remove(rec, 'destroyed');
      return true;
    case 'bounce':
      bounce(rec, normal);
      return false;
  }
}

/** Reflect the velocity off a surface; slow lobs on floors come to rest. */
export function bounce(rec: ProjectileRecord, normal: Readonly<Vec3>): void {
  const s = rec.state;
  const vn = dot(s.velocity, normal);
  const tangent = sub(s.velocity, scale(normal, vn));
  const next = add(scale(tangent, LOB_FRICTION), scale(normal, -vn * rec.restitution));
  rec.bounces++;
  if (normal.y >= REST_NORMAL_Y && length(next) < REST_SPEED) {
    s.velocity = { x: 0, y: 0, z: 0 };
    s.landed = true;
  } else {
    s.velocity = next;
  }
}

/**
 * Detonate at `at`: direct damage to `directHit` (if any), splash to everyone
 * else, then removal. Projectiles without splash and without a direct hit
 * still emit an `explosion` event when they carry damage.
 */
export function detonateProjectile(
  rec: ProjectileRecord,
  env: ProjectileEnv,
  at: Readonly<Vec3>,
  directHit?: PawnState,
): void {
  const s = rec.state;
  const { def } = rec;
  const damageType = damageTypeFor(rec.weapon, rec.mode);

  if (directHit && def.damage > 0) {
    const hit = env.host.damage(
      directHit.id,
      {
        amount: def.damage,
        damageType,
        instigator: s.owner,
        weapon: rec.weapon,
        momentum: scale(normalize(s.velocity), def.momentum ?? 0),
      },
      env.tick,
    );
    if (hit) env.events.push(...hit.events);
  }

  const radius = def.splashRadius ?? 0;
  if (radius > 0 || def.damage > 0) {
    const opts = {
      center: at,
      radius,
      damage: def.splashDamage ?? def.damage,
      momentum: def.momentum ?? 0,
      instigator: s.owner,
      weapon: rec.weapon,
      damageType,
    };
    applySplash(
      env.host,
      env.tick,
      directHit ? { ...opts, exclude: directHit.id } : opts,
      env.events,
    );
  }
  env.remove(rec, 'detonated');
}

/**
 * A hitscan or other hit on the projectile itself. Shootable projectiles lose
 * `amount` health and fizzle when it runs out; an enemy hit on a disc disrupts
 * it (§16 decision 3). Returns true when the projectile was destroyed.
 */
export function damageProjectile(
  rec: ProjectileRecord,
  amount: number,
  byPawn: PawnState['id'],
  env: ProjectileEnv,
): boolean {
  const s = rec.state;
  if (s.health > 0) {
    s.health = Math.max(0, s.health - amount);
    if (s.health > 0) return false;
    env.events.push({ type: 'projectileDestroyed', tick: env.tick, id: s.id, byPawn });
    applySplash(
      env.host,
      env.tick,
      {
        center: s.position,
        radius: FIZZLE_RADIUS,
        damage: FIZZLE_DAMAGE,
        momentum: (rec.def.momentum ?? 0) * 0.25,
        instigator: byPawn === NO_ENTITY ? s.owner : byPawn,
        weapon: rec.weapon,
        damageType: damageTypeFor(rec.weapon, rec.mode),
      },
      env.events,
    );
    env.remove(rec, 'destroyed');
    return true;
  }
  if (s.projectileType === 'disc' && byPawn !== s.owner && !s.disrupted) {
    s.disrupted = true;
    env.events.push({ type: 'discDisrupted', tick: env.tick, disc: s.id, byPawn });
  }
  return false;
}
