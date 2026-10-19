/**
 * Scripted combat for the FX demo and its fixed-tick screenshots: a pure
 * function of the tick, so `demo.html?tick=N` always shows the same frame.
 * Positions are in the laundry sketch (`../scene/fixtures/laundrySketch`):
 * washer front face at z = −26 (x −26..−2), dryer front face at z = −26
 * (x 2..26), floor at y = 0.
 */
import type {
  CameraDef,
  EntityState,
  PawnState,
  PickupState,
  ProjectileState,
  ProjectileType,
  SimEvent,
  Vec3,
  WeaponId,
  WorldState,
} from '../../sim/types';
import { TICK_DT } from '../../sim/types';
import { Rng } from '../../sim/rng';
import { lookAtPose } from '../scene/debugCamera';
import { PAWN_EYE_HEIGHT, PAWN_HEIGHT } from '../scene/entityViews';
import { FX_GRAVITY } from './particles';

/** Ticks before the script repeats. */
export const LOOP_TICKS = 900;

const CENTER_Y = PAWN_HEIGHT / 2;
const EYE_DY = PAWN_EYE_HEIGHT - PAWN_HEIGHT / 2;

const A_POS: Vec3 = { x: -14, y: CENTER_Y, z: 10 };
const A_AFTER_TELEPORT: Vec3 = { x: -30, y: CENTER_Y, z: 30 };
const B_POS: Vec3 = { x: 30, y: CENTER_Y, z: 5 };
const C_POS: Vec3 = { x: -6, y: CENTER_Y, z: -10 };
const C_RESPAWN: Vec3 = { x: -40, y: CENTER_Y, z: 20 };
const SHIELD_PICKUP: Vec3 = { x: 0, y: 1, z: 0 };

const eye = (p: Vec3): Vec3 => ({ x: p.x, y: p.y + EYE_DY, z: p.z });
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (a: Vec3, k: number): Vec3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const length = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
const normalize = (a: Vec3): Vec3 => scale(a, 1 / (length(a) || 1));
const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => add(a, scale(sub(b, a), t));

/** A straight shot: spawns at `fire`, travels `from → to` at `speed`, explodes on arrival. */
interface Flight {
  id: number;
  type: ProjectileType;
  owner: number;
  weapon: WeaponId;
  fire: number;
  from: Vec3;
  to: Vec3;
  speed: number;
  radius: number;
  damageType: 'rocket' | 'grenade' | 'redeemer';
  /** Lobbed: gravity bends the path and `to` is the computed landing point. */
  lob: boolean;
  /** Arrival tick (derived). */
  land: number;
}

function flight(f: Omit<Flight, 'land'>): Flight {
  const land = f.fire + Math.ceil(length(sub(f.to, f.from)) / f.speed / TICK_DT);
  return { ...f, land };
}

/** Where a 22 m/s lob from `from` along `dir` lands on y = 0 under §4 gravity. */
function lobLanding(from: Vec3, dir: Vec3, speed: number): { to: Vec3; seconds: number } {
  const v = scale(normalize(dir), speed);
  // from.y + v.y t − ½ g t² = 0.2
  const a = -0.5 * FX_GRAVITY;
  const b = v.y;
  const c = from.y - 0.2;
  const t = (-b - Math.sqrt(b * b - 4 * a * c)) / (2 * a);
  return { to: { x: from.x + v.x * t, y: 0.2, z: from.z + v.z * t }, seconds: t };
}

const GRENADE_DIR: Vec3 = { x: 0.45, y: 0.55, z: -0.7 };
const GRENADE = lobLanding(eye(A_POS), GRENADE_DIR, 22);

const ROCKET_TARGET: Vec3 = { x: 14, y: 12, z: -26 };
const SALVO_TARGETS: Vec3[] = [
  { x: -3, y: 0.3, z: 21 },
  { x: 0, y: 0.3, z: 20 },
  { x: 3, y: 0.3, z: 19 },
];
const NUKE_TARGET: Vec3 = { x: 0, y: 20, z: -5 };

export const FLIGHTS: readonly Flight[] = [
  flight({
    id: 10,
    type: 'rocket',
    owner: 2,
    weapon: 'rocket',
    fire: 120,
    from: eye(B_POS),
    to: ROCKET_TARGET,
    speed: 27,
    radius: 4.4,
    damageType: 'rocket',
    lob: false,
  }),
  ...SALVO_TARGETS.map((to, i) =>
    flight({
      id: 11 + i,
      type: 'rocket' as const,
      owner: 2,
      weapon: 'rocket' as const,
      fire: 300,
      from: eye(B_POS),
      to,
      speed: 27,
      radius: 4.4,
      damageType: 'rocket' as const,
      lob: false,
    }),
  ),
  {
    id: 14,
    type: 'grenade',
    owner: 1,
    weapon: 'assault',
    fire: 420,
    from: eye(A_POS),
    to: GRENADE.to,
    speed: 22,
    radius: 3.5,
    damageType: 'grenade',
    lob: true,
    land: 420 + Math.ceil(GRENADE.seconds / TICK_DT),
  },
  flight({
    id: 15,
    type: 'redeemer',
    owner: 2,
    weapon: 'redeemer',
    fire: 540,
    from: eye(B_POS),
    to: NUKE_TARGET,
    speed: 20,
    radius: 50,
    damageType: 'redeemer',
    lob: false,
  }),
];

/** Key moments, by name, for the screenshot set and the HUD. */
export const MOMENTS = {
  assaultStart: 30,
  assaultEnd: 90,
  rocketFire: 120,
  rocketHit: FLIGHTS[0]!.land,
  shockKill: 240,
  salvoFire: 300,
  salvoHit: FLIGHTS[1]!.land,
  grenadeFire: 420,
  grenadeHit: FLIGHTS[4]!.land,
  nukeFire: 540,
  nukeHit: FLIGHTS[5]!.land,
  teleport: 720,
  land: 740,
  jumpPad: 760,
  pickup: 780,
  respawn: 420,
} as const;

/** Cameras framing each moment, added to the sketch's own. */
export const FX_CAMERAS: readonly CameraDef[] = [
  { name: 'fx-wall', pose: lookAtPose({ x: -6, y: 3.5, z: -4 }, { x: -14, y: 2, z: -26 }) },
  { name: 'fx-rocket', pose: lookAtPose({ x: 28, y: 9, z: -2 }, { x: 14, y: 11, z: -26 }) },
  { name: 'fx-beam', pose: lookAtPose({ x: 6, y: 3, z: 3 }, { x: -9, y: 1.4, z: -2 }) },
  { name: 'fx-salvo', pose: lookAtPose({ x: 12, y: 6, z: 36 }, { x: 0, y: 1, z: 20 }) },
  {
    name: 'fx-grenade',
    pose: lookAtPose(add(GRENADE.to, { x: 8, y: 4, z: 10 }), add(GRENADE.to, { x: 0, y: 1, z: 0 })),
  },
  { name: 'fx-nuke', pose: lookAtPose({ x: 42, y: 32, z: 48 }, { x: 0, y: 14, z: -5 }) },
];

/** The screenshot set: camera name and the tick to freeze at. */
export const FX_SHOTS: readonly { camera: string; tick: number }[] = [
  { camera: 'fx-wall', tick: MOMENTS.assaultStart + 46 },
  { camera: 'fx-rocket', tick: MOMENTS.rocketHit + 5 },
  { camera: 'fx-beam', tick: MOMENTS.shockKill + 3 },
  { camera: 'fx-beam', tick: MOMENTS.shockKill + 24 },
  { camera: 'fx-salvo', tick: MOMENTS.salvoHit + 6 },
  { camera: 'fx-grenade', tick: MOMENTS.grenadeHit + 5 },
  { camera: 'fx-nuke', tick: MOMENTS.nukeHit + 12 },
  { camera: 'overview', tick: MOMENTS.nukeHit + 40 },
];

function pawn(id: number, playerId: string, position: Vec3, yaw: number, alive = true): PawnState {
  return {
    id,
    kind: 'pawn',
    playerId,
    position,
    velocity: { x: 0, y: 0, z: 0 },
    yaw,
    pitch: 0,
    alive,
    health: alive ? 100 : 0,
    shield: 0,
    grounded: true,
    crouching: false,
    weapon: 'assault',
    pendingWeapon: null,
    owned: ['assault'],
    ammo: { assault: 100 },
    spawnProtectedUntil: 0,
    respawnAt: 0,
    guiding: 0,
    disc: 0,
    viewingDisc: false,
    zoom: 1,
    udamageUntil: 0,
  };
}

/** Yaw that faces from `from` toward `to` (yaw 0 = −Z, positive toward −X). */
function yawToward(from: Vec3, to: Vec3): number {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z));
}

function projectilePosition(f: Flight, tick: number): Vec3 {
  const t = (tick - f.fire) * TICK_DT;
  if (!f.lob) {
    const total = length(sub(f.to, f.from)) / f.speed;
    return lerp(f.from, f.to, Math.min(1, t / total));
  }
  const v = scale(normalize(GRENADE_DIR), f.speed);
  return {
    x: f.from.x + v.x * t,
    y: Math.max(0.2, f.from.y + v.y * t - 0.5 * FX_GRAVITY * t * t),
    z: f.from.z + v.z * t,
  };
}

function projectile(f: Flight, tick: number): ProjectileState {
  const p = projectilePosition(f, tick);
  const d = normalize(sub(f.to, f.from));
  return {
    id: f.id,
    kind: 'projectile',
    projectileType: f.type,
    owner: f.owner,
    position: p,
    velocity: scale(d, f.speed),
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    health: f.type === 'redeemer' ? 50 : 0,
    guided: false,
    landed: false,
    disrupted: false,
    detonateAt: 0,
  };
}

/** Sim state at a tick of the loop. */
export function stateAt(absoluteTick: number): WorldState {
  const tick = ((absoluteTick % LOOP_TICKS) + LOOP_TICKS) % LOOP_TICKS;
  const a = pawn(
    1,
    'local',
    tick >= MOMENTS.teleport ? A_AFTER_TELEPORT : A_POS,
    yawToward(A_POS, { x: -14, y: 0, z: -26 }),
  );
  const b = pawn(2, 'bot:1', B_POS, yawToward(B_POS, ROCKET_TARGET));
  const cAlive = tick < MOMENTS.shockKill || tick >= MOMENTS.respawn;
  const c = pawn(
    3,
    'bot:2',
    tick >= MOMENTS.respawn ? C_RESPAWN : C_POS,
    yawToward(C_POS, A_POS),
    cAlive,
  );
  const shield: PickupState = {
    id: 20,
    kind: 'pickup',
    position: SHIELD_PICKUP,
    placementIndex: 6,
    type: 'shieldPack',
    available: tick < MOMENTS.pickup,
    respawnAt: 0,
    takenBy: [],
  };
  const entities: EntityState[] = [a, b, c, shield];
  for (const f of FLIGHTS) if (tick >= f.fire && tick < f.land) entities.push(projectile(f, tick));
  return {
    tick: absoluteTick,
    time: absoluteTick * TICK_DT,
    rngState: 0,
    entities,
    match: {
      phase: 'playing',
      fragLimit: 0,
      timeLimit: 0,
      elapsed: absoluteTick * TICK_DT,
      scores: [],
      winner: null,
    },
  };
}

/** Events that occur on a tick of the loop. */
export function eventsAt(absoluteTick: number): SimEvent[] {
  const tick = ((absoluteTick % LOOP_TICKS) + LOOP_TICKS) % LOOP_TICKS;
  const events: SimEvent[] = [];
  const aEye = eye(A_POS);
  const cChest = C_POS;

  // Assault rifle burst at the washer; two rounds find pawn C.
  if (tick >= MOMENTS.assaultStart && tick <= MOMENTS.assaultEnd && tick % 6 === 0) {
    const rng = new Rng(tick);
    const hitsPawn = tick === 60 || tick === 66;
    const target: Vec3 = hitsPawn
      ? cChest
      : { x: -14 + rng.nextRange(-2.5, 2.5), y: 1.6 + rng.nextRange(-1.5, 2.5), z: -26 };
    const dir = normalize(sub(target, aEye));
    events.push(
      {
        type: 'shotFired',
        tick,
        pawn: 1,
        weapon: 'assault',
        mode: 'primary',
        origin: aEye,
        direction: dir,
      },
      {
        type: 'hitscan',
        tick,
        pawn: 1,
        weapon: 'assault',
        from: aEye,
        to: target,
        hitPawn: hitsPawn ? 3 : 0,
        headshot: false,
      },
    );
    if (hitsPawn) {
      events.push({
        type: 'damage',
        tick,
        target: 3,
        instigator: 1,
        amount: 7,
        damageType: 'bullet',
        momentum: scale(dir, 0.5),
      });
    }
  }

  // Projectiles: fire and arrival.
  for (const f of FLIGHTS) {
    if (tick === f.fire) {
      const dir = normalize(f.lob ? GRENADE_DIR : sub(f.to, f.from));
      events.push(
        {
          type: 'shotFired',
          tick,
          pawn: f.owner,
          weapon: f.weapon,
          mode: f.lob ? 'alt' : 'primary',
          origin: f.from,
          direction: dir,
        },
        { type: 'entitySpawned', tick, id: f.id, kind: 'projectile' },
      );
    }
    if (tick === f.land) {
      events.push(
        {
          type: 'explosion',
          tick,
          position: f.to,
          radius: f.radius,
          damageType: f.damageType,
          instigator: f.owner,
        },
        { type: 'entityDestroyed', tick, id: f.id, kind: 'projectile' },
      );
    }
  }

  // Shock beam kills C.
  if (tick === MOMENTS.shockKill) {
    const dir = normalize(sub(cChest, aEye));
    events.push(
      {
        type: 'shotFired',
        tick,
        pawn: 1,
        weapon: 'shock',
        mode: 'primary',
        origin: aEye,
        direction: dir,
      },
      {
        type: 'hitscan',
        tick,
        pawn: 1,
        weapon: 'shock',
        from: aEye,
        to: cChest,
        hitPawn: 3,
        headshot: false,
      },
      {
        type: 'damage',
        tick,
        target: 3,
        instigator: 1,
        amount: 1000,
        damageType: 'shock',
        momentum: scale(dir, 6),
      },
      { type: 'death', tick, victim: 3, killer: 1, damageType: 'shock', weapon: 'shock' },
    );
  }
  if (tick === MOMENTS.respawn) {
    events.push({
      type: 'respawn',
      tick,
      pawn: 3,
      pose: { position: C_RESPAWN, yaw: 0, pitch: 0 },
    });
  }

  // World events.
  if (tick === MOMENTS.teleport) {
    events.push({
      type: 'teleport',
      tick,
      pawn: 1,
      from: A_POS,
      to: A_AFTER_TELEPORT,
      telefragged: 0,
    });
  }
  if (tick === MOMENTS.land) events.push({ type: 'land', tick, pawn: 2, impactSpeed: 22 });
  if (tick === MOMENTS.jumpPad) events.push({ type: 'jumpPad', tick, pawn: 3, pad: 30 });
  if (tick === MOMENTS.pickup) {
    events.push({ type: 'pickupTaken', tick, pawn: 1, pickup: 20, pickupType: 'shieldPack' });
  }
  return events;
}
