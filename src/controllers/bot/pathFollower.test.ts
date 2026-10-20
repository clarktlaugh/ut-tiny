/**
 * Path following against the real sim: a small flat arena with a platform,
 * driven only through `InputCommand`s like a bot would. Covers walking,
 * a `jump` link, a `pad` link, stuck recovery, and pad hazard avoidance.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PICKUPS } from '../../data/pickups';
import { WEAPONS } from '../../data/weapons';
import { NavMesh, bakeNavMesh } from '../../nav';
import { Rng } from '../../sim/rng';
import {
  Buttons,
  NULL_INPUT,
  TICK_RATE,
  type Brush,
  type InputCommand,
  type JumpPadDef,
  type MapDef,
  type NavLinkDef,
  type PawnId,
  type PawnState,
  type SimEvent,
  type Vec3,
  type WorldOptions,
} from '../../sim/types';
import { createWorld, type SimWorld } from '../../sim/world';
import { TEST_WORLD_RULES } from '../../sim/world/testing';
import { dodgeButton } from './botController';
import { padHazards } from './hazards';
import { PathFollower, feetOf } from './pathFollower';
import { RouteGraph } from './routeGraph';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

function box(min: Vec3, max: Vec3): Brush {
  return {
    shape: 'box',
    position: v((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2),
    size: v(max.x - min.x, max.y - min.y, max.z - min.z),
    material: 'test',
  };
}

/** 40 × 40 m floor (top at y 0) under a ceiling (the bake needs one) plus extras. */
function arena(extra: {
  brushes?: Brush[];
  navLinks?: NavLinkDef[];
  jumpPads?: JumpPadDef[];
  pickups?: MapDef['pickups'];
  spawn?: Vec3;
}): MapDef {
  return {
    name: 'arena',
    scale: 40,
    brushes: [
      box(v(-20, -1, -20), v(20, 0, 20)),
      box(v(-20, 20, -20), v(20, 21, 20)),
      ...(extra.brushes ?? []),
    ],
    props: [],
    spawns: [{ position: extra.spawn ?? v(-10, 0, 0), yaw: 0, pitch: 0 }],
    pickups: extra.pickups ?? [],
    jumpPads: extra.jumpPads ?? [],
    volumes: [],
    lights: [],
    navLinks: extra.navLinks ?? [],
    cameras: [],
    ambience: { loops: [], reverb: 'none' },
  };
}

function options(map: MapDef): WorldOptions {
  return { map, seed: 7, rules: TEST_WORLD_RULES, weapons: WEAPONS, pickups: PICKUPS };
}

interface Drive {
  ticks: number;
  status: string;
  events: SimEvent[];
  pawn: PawnState;
}

/** Spawn the pawn, then feed the follower's steps to the world until it arrives or `maxTicks` pass. */
function drive(
  world: SimWorld,
  pawnId: PawnId,
  follower: PathFollower,
  goal: Vec3,
  maxTicks: number,
): Drive {
  const rng = new Rng(1);
  const events: SimEvent[] = [];
  let pawn = world.getEntity(pawnId) as PawnState;
  let tick = 0;
  // Press Fire to respawn, then release.
  while (!pawn.alive && tick < 400) {
    tick++;
    events.push(
      ...world.step(
        new Map([[pawnId, { ...NULL_INPUT, seq: tick, buttons: tick % 2 ? Buttons.Fire : 0 }]]),
      ),
    );
    pawn = world.getEntity(pawnId) as PawnState;
  }
  expect(pawn.alive).toBe(true);
  follower.setGoal(goal);
  let status = 'moving';
  let used = 0;
  for (; used < maxTicks; used++) {
    tick++;
    const step = follower.update(tick, pawn, rng);
    status = step.status;
    if (status === 'arrived' || status === 'unreachable') break;
    // Yaw 0: forward is −z, right is +x.
    const cmd: InputCommand = {
      seq: tick,
      moveX: step.move?.x ?? 0,
      moveY: -(step.move?.z ?? 0),
      yaw: 0,
      pitch: 0,
      buttons: (step.jump ? Buttons.Jump : 0) | (step.dodge ? dodgeButton(step.dodge, 0) : 0),
      weapon: 0,
    };
    events.push(...world.step(new Map([[pawnId, cmd]])));
    pawn = world.getEntity(pawnId) as PawnState;
  }
  return { ticks: used, status, events, pawn };
}

describe('path follower on a flat arena', () => {
  let world: SimWorld;
  let nav: NavMesh;
  let pawnId: PawnId;
  const map = arena({});

  beforeAll(() => {
    nav = new NavMesh(bakeNavMesh(map));
  });
  beforeEach(async () => {
    world = await createWorld(options(map));
    pawnId = world.addPlayer('bot', { name: 'Bot', isBot: true });
  });
  afterEach(() => world.dispose());

  it('walks to a point across the floor and arrives', () => {
    const follower = new PathFollower(nav, { allowedLinks: new Set() });
    const goal = v(12, 0, -8);
    const run = drive(world, pawnId, follower, goal, 6 * TICK_RATE);
    expect(run.status).toBe('arrived');
    const feet = feetOf(run.pawn);
    expect(Math.hypot(feet.x - goal.x, feet.z - goal.z)).toBeLessThan(1);
    // 24 m at 8.8 m/s is under 3 s; allow for acceleration and the arrival radius.
    expect(run.ticks).toBeLessThan(4 * TICK_RATE);
  });

  it('reports an unreachable goal without a path and keeps blacklists per link', () => {
    const follower = new PathFollower(nav, { allowedLinks: new Set() });
    const run = drive(world, pawnId, follower, v(0, 30, 0), 60);
    expect(run.status).toBe('unreachable');
    expect(follower.blocked(0)).toEqual([]);
  });
});

describe('path follower over links', () => {
  // A 1 m platform (too tall to step up) reached by a jump link, a 6 m
  // platform reached by a pad, and a pickup on each.
  const low = box(v(4, 0, -6), v(14, 1, 6));
  const high = box(v(-14, 0, -14), v(-4, 6, -8));
  const pad: JumpPadDef = {
    position: v(-9, 0.5, 0),
    size: v(3, 1, 3),
    // Up 7 m (apex above the 6 m top) and 8 m toward −z in the 0.86 s to the apex.
    launch: v(0, Math.sqrt(2 * 19 * 7), -8 / (Math.sqrt(2 * 19 * 7) / 19)),
  };
  const map = arena({
    spawn: v(-9, 0, 8),
    brushes: [low, high],
    jumpPads: [pad],
    navLinks: [
      { from: v(2, 0, 0), to: v(6, 1, 0), kind: 'jump' },
      { from: v(-9, 0, 0), to: v(-9, 6, -10), kind: 'pad' },
    ],
    pickups: [
      { type: 'healthVial', position: v(10, 2, 0) },
      { type: 'healthVial', position: v(-9, 7, -11) },
    ],
  });
  let world: SimWorld;
  let nav: NavMesh;
  let graph: RouteGraph;
  let pawnId: PawnId;

  beforeAll(() => {
    nav = new NavMesh(bakeNavMesh(map));
    graph = new RouteGraph(nav, { hazards: padHazards(map) });
  });
  // A fresh world per test, so each run starts from the spawn.
  beforeEach(async () => {
    world = await createWorld(options(map));
    pawnId = world.addPlayer('bot', { name: 'Bot', isBot: true });
  });
  afterEach(() => world.dispose());

  const taken = (events: SimEvent[]): number =>
    events.filter((e) => e.type === 'pickupTaken' && e.pawn === pawnId).length;

  it('jumps onto the low platform through the jump link and takes the vial', () => {
    const follower = new PathFollower(nav, { allowedLinks: new Set(['jump']), planner: graph });
    const run = drive(world, pawnId, follower, v(10, 1, 0), 8 * TICK_RATE);
    expect(run.status).toBe('arrived');
    expect(run.events.some((e) => e.type === 'jump' && e.pawn === pawnId)).toBe(true);
    expect(taken(run.events)).toBe(1);
    expect(feetOf(run.pawn).y).toBeCloseTo(1, 0);
  });

  it('cannot reach the low platform when jump links are not allowed', () => {
    const follower = new PathFollower(nav, { allowedLinks: new Set(), planner: graph });
    expect(drive(world, pawnId, follower, v(10, 1, 0), 60).status).toBe('unreachable');
  });

  it('rides the pad onto the high platform through the pad link and takes the vial', () => {
    const follower = new PathFollower(nav, {
      allowedLinks: new Set(['pad']),
      planner: graph,
      hazards: padHazards(map),
    });
    const run = drive(world, pawnId, follower, v(-9, 6, -11), 10 * TICK_RATE);
    expect(run.status).toBe('arrived');
    expect(run.events.some((e) => e.type === 'jumpPad' && e.pawn === pawnId)).toBe(true);
    expect(taken(run.events)).toBe(1);
    expect(feetOf(run.pawn).y).toBeCloseTo(6, 0);
  });

  it('walks around the pad instead of through it when the pad is not the way', () => {
    const follower = new PathFollower(nav, {
      allowedLinks: new Set(['pad']),
      planner: graph,
      hazards: padHazards(map),
    });
    // From the spawn at (−9, 0, 8) the pad sits right on the straight line to (−9, 0, −6).
    const run = drive(world, pawnId, follower, v(-9, 0, -6), 6 * TICK_RATE);
    expect(run.status).toBe('arrived');
    expect(run.events.some((e) => e.type === 'jumpPad')).toBe(false);
  });
});
