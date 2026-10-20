/**
 * P31 acceptance: every §7.1 route is reachable in a headless scripted run
 * with the live movement tuning, pad landings deal no fall damage, and the
 * hazards do what the map says. One world is shared; the pawn is teleported
 * to each route's start with the demo's own teleporter.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HitMask } from '../../sim/physics';
import {
  NULL_INPUT,
  Buttons,
  TICK_RATE,
  type DamageType,
  type PawnId,
  type PawnState,
  type Pose,
  type SimEvent,
  type Vec3,
} from '../../sim/types';
import { createWorld, type SimWorld } from '../../sim/world';
import { worldOptions } from '../../sim/world/testing';
import { allPlaces, type GroundProbe } from './places';
import { RouteDriver, describe as whereIs, feetY, horizontalDistance } from './routeDriver';
import { ROUTES, type RouteDef } from './routes';
import { installTeleporter, type Teleporter } from './teleport';

interface RunLog {
  ticks: number;
  landings: number[];
  damage: { type: DamageType; amount: number }[];
  death: Extract<SimEvent, { type: 'death' }> | null;
  jumpPads: number;
  wallDodges: number;
  doubleJumps: number;
  pickups: string[];
}

let world: SimWorld;
let teleporter: Teleporter;
let pawn: PawnId;

function pawnState(): Readonly<PawnState> {
  const state = world.getState();
  const found = state.entities.find((e) => e.kind === 'pawn' && e.id === pawn);
  if (!found || found.kind !== 'pawn') throw new Error('local pawn missing');
  return found;
}

function stepWorld(input = NULL_INPUT): readonly SimEvent[] {
  return world.step(new Map([[pawn, { ...input, seq: world.tick + 1 }]]));
}

/** Sump floor: inside the sink's kill volume. */
const SUMP: Vec3 = { x: -48, y: 20, z: 40 };

/** Kill a live pawn in the sump so the next route starts with a fresh one (100 health, no shield). */
function killPawn(): void {
  if (!pawnState().alive) return;
  teleporter.request(pawn, { position: SUMP, yaw: 0, pitch: 0 });
  for (let i = 0; i < TICK_RATE && pawnState().alive; i++) stepWorld();
  expect(pawnState().alive, 'the sump kill volume kills').toBe(false);
}

/** Kill, respawn, teleport to `start` and wait until standing there. */
function settleAt(start: Readonly<Pose>): void {
  killPawn();
  teleporter.request(pawn, start);
  for (let i = 0; i < 6 * TICK_RATE; i++) {
    const p = pawnState();
    const fire = p.alive || i % 2 === 0 ? 0 : Buttons.Fire;
    stepWorld({ ...NULL_INPUT, yaw: start.yaw, pitch: start.pitch, buttons: fire });
    const q = pawnState();
    if (
      q.alive &&
      q.grounded &&
      horizontalDistance(q.position, start.position) <= 1 &&
      Math.abs(feetY(q) - start.position.y) <= 0.5
    ) {
      return;
    }
  }
  throw new Error(`could not settle at ${JSON.stringify(start.position)}: ${whereIs(pawnState())}`);
}

function run(route: RouteDef): RunLog {
  settleAt(route.start);
  const driver = new RouteDriver(route.steps, route.start.yaw);
  const log: RunLog = {
    ticks: 0,
    landings: [],
    damage: [],
    death: null,
    jumpPads: 0,
    wallDodges: 0,
    doubleJumps: 0,
    pickups: [],
  };
  const budget = route.steps.reduce((sum, s) => sum + s.maxTicks, 0) + TICK_RATE;
  for (let i = 0; i < budget && !driver.status.finished; i++) {
    const input = driver.next(pawnState(), world.tick + 1);
    const events = stepWorld(input);
    log.ticks++;
    for (const e of events) {
      if (e.type === 'land' && e.pawn === pawn) log.landings.push(e.impactSpeed);
      if (e.type === 'damage' && e.target === pawn) {
        log.damage.push({ type: e.damageType, amount: e.amount });
      }
      if (e.type === 'death' && e.victim === pawn) log.death = e;
      if (e.type === 'jumpPad' && e.pawn === pawn) log.jumpPads++;
      if (e.type === 'dodge' && e.pawn === pawn && e.wall) log.wallDodges++;
      if (e.type === 'jump' && e.pawn === pawn && e.double) log.doubleJumps++;
      if (e.type === 'pickupTaken' && e.pawn === pawn) log.pickups.push(e.pickupType);
    }
    if (log.death) break;
  }
  // A hazard run keeps going until the death it expects (or gives up).
  for (let i = 0; route.expect.death && !log.death && i < 6 * TICK_RATE; i++) {
    for (const e of stepWorld()) {
      if (e.type === 'death' && e.victim === pawn) log.death = e;
      if (e.type === 'damage' && e.target === pawn) {
        log.damage.push({ type: e.damageType, amount: e.amount });
      }
    }
    log.ticks++;
  }
  return log;
}

function fallDamage(log: RunLog): number {
  return log.damage.filter((d) => d.type === 'fall').reduce((s, d) => s + d.amount, 0);
}

const groundProbe: GroundProbe = (from, maxDrop) =>
  world.physics.raycast(from, { x: 0, y: -1, z: 0 }, maxDrop, { mask: HitMask.World })?.point ??
  null;

beforeAll(async () => {
  const base = worldOptions({ seed: 31 });
  // No spawn protection: the hazards must hurt a freshly respawned pawn.
  world = await createWorld({ ...base, rules: { ...base.rules, spawnProtection: 0 } });
  teleporter = installTeleporter(world.mover);
  pawn = world.addPlayer('local', { name: 'Walker', isBot: false });
  // First tick: the pawn spawns at a map spawn point.
  stepWorld();
  expect(pawnState().alive).toBe(true);
}, 60_000);

afterAll(() => {
  teleporter.dispose();
  world.dispose();
});

describe('laundry walkabout routes (§7.1)', () => {
  it.each(ROUTES.map((r) => [r.id, r] as const))(
    '%s is reachable: %s',
    (_id, route) => {
      const log = run(route);
      const p = pawnState();
      const where = `${route.id} ended after ${log.ticks} ticks at ${whereIs(p)}; landings ${log.landings
        .map((s) => s.toFixed(1))
        .join(', ')}`;
      const ex = route.expect;
      expect(p.alive, where).toBe(ex.alive);
      if (ex.arrive) {
        expect(horizontalDistance(p.position, ex.arrive.near), where).toBeLessThanOrEqual(
          ex.arrive.radius,
        );
        expect(Math.abs(feetY(p) - ex.arrive.feetY), where).toBeLessThanOrEqual(0.6);
        expect(p.grounded, where).toBe(true);
      }
      if (ex.noFallDamage) expect(fallDamage(log), where).toBe(0);
      if (ex.death) {
        expect(log.death?.damageType, where).toBe(ex.death.damageType);
        if (ex.death.message) expect(log.death?.message, where).toBe(ex.death.message);
      } else {
        expect(log.death, where).toBeNull();
      }
      if (ex.jumpPad) expect(log.jumpPads, where).toBeGreaterThan(0);
      if (ex.wallDodge) expect(log.wallDodges, where).toBeGreaterThan(0);
      if (ex.doubleJump) expect(log.doubleJumps, where).toBeGreaterThan(0);
      if (ex.pickup) expect(log.pickups, where).toContain(ex.pickup);
      if (ex.hurtBy) {
        expect(
          log.damage.some((d) => d.type === ex.hurtBy),
          where,
        ).toBe(true);
        expect(p.health, where).toBeLessThan(100);
      }
      if (ex.inWater !== undefined) expect(world.inWater(pawn), where).toBe(ex.inWater);
    },
    120_000,
  );

  it('respawns after a hazard death and plays on', () => {
    const r1 = ROUTES[0];
    if (!r1) throw new Error('no routes');
    const log = run(r1);
    expect(log.death).toBeNull();
    expect(pawnState().alive).toBe(true);
  }, 60_000);
});

describe('teleport destinations', () => {
  it('every place stands on solid ground, clear of geometry', () => {
    const places = allPlaces(world.options.map, groundProbe);
    expect(places.length).toBe(world.options.map.cameras.length + ROUTES.length);
    expect(new Set(places.map((p) => p.id)).size).toBe(places.length);
    for (const place of places) {
      settleAt(place.pose);
      for (let i = 0; i < TICK_RATE; i++) stepWorld({ ...NULL_INPUT, yaw: place.pose.yaw });
      const p = pawnState();
      const where = `${place.id}: ${whereIs(p)}`;
      expect(p.alive, where).toBe(true);
      expect(p.grounded, where).toBe(true);
      expect(horizontalDistance(p.position, place.pose.position), where).toBeLessThan(0.3);
      expect(Math.abs(feetY(p) - place.pose.position.y), where).toBeLessThan(0.3);
    }
  }, 120_000);

  it('camera places stand below the camera eye, facing its way', () => {
    const places = allPlaces(world.options.map, groundProbe);
    for (const cam of world.options.map.cameras) {
      const place = places.find((p) => p.id === `camera:${cam.name}`);
      expect(place).toBeDefined();
      const eye: Vec3 = cam.pose.position;
      expect(place!.pose.position.x).toBeCloseTo(eye.x, 5);
      expect(place!.pose.position.z).toBeCloseTo(eye.z, 5);
      expect(place!.pose.position.y).toBeLessThanOrEqual(eye.y);
      expect(place!.pose.yaw).toBe(cam.pose.yaw);
      expect(place!.pose.pitch).toBe(cam.pose.pitch);
    }
  });

  it('a request made while dead is applied on the respawn tick', () => {
    const h1 = ROUTES.find((r) => r.id === 'H1');
    if (!h1) throw new Error('H1 missing');
    run(h1);
    expect(pawnState().alive).toBe(false);
    const target: Pose = { position: { x: 0, y: 0, z: 10 }, yaw: 1, pitch: 0.2 };
    teleporter.request(pawn, target);
    expect(teleporter.pending(pawn)).toEqual(target);
    let respawnTick = -1;
    for (let i = 0; i < 4 * TICK_RATE && respawnTick < 0; i++) {
      const events = stepWorld({ ...NULL_INPUT, buttons: i % 2 ? Buttons.Fire : 0 });
      if (events.some((e) => e.type === 'respawn' && e.pawn === pawn)) respawnTick = world.tick;
    }
    expect(respawnTick).toBeGreaterThan(0);
    const p = pawnState();
    expect(p.alive).toBe(true);
    expect(horizontalDistance(p.position, target.position)).toBeLessThan(0.1);
    expect(p.yaw).toBeCloseTo(1, 5);
    expect(teleporter.pending(pawn)).toBeUndefined();
  }, 60_000);
});
