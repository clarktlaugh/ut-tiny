/**
 * Controller-level behavior that the smoke run does not pin down: the
 * respawn press, command sanity, hearing through `observe`, and that a bot
 * fires at a visible enemy in front of it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LAUNDRY_ROOM } from '../../maps/laundry-room';
import { NavMesh, bakeNavMesh } from '../../nav';
import {
  Buttons,
  TICK_RATE,
  type InputCommand,
  type PawnId,
  type PawnState,
} from '../../sim/types';
import type { MoverState } from '../../sim/movement';
import { createWorld, type SimWorld } from '../../sim/world';
import { worldOptions } from '../../sim/world/testing';
import { BotController, dodgeButton } from './botController';
import { worldSenses } from './senses';

describe('bot controller', () => {
  let nav: NavMesh;
  let world: SimWorld;
  let bot: BotController;
  let other: PawnId;

  beforeAll(async () => {
    nav = new NavMesh(bakeNavMesh(LAUNDRY_ROOM));
    world = await createWorld(worldOptions({ seed: 99 }));
    const pawnId = world.addPlayer('bot:0', { name: 'Bot', isBot: true, skill: 4 });
    other = world.addPlayer('bot:1', { name: 'Other', isBot: true, skill: 0 });
    bot = new BotController({
      pawnId,
      nav,
      senses: worldSenses(world),
      skill: 4,
      seed: 5,
      map: LAUNDRY_ROOM,
    });
  });
  afterAll(() => world.dispose());

  const pawn = (id: PawnId): PawnState => world.getEntity(id) as PawnState;

  it('presses Fire on alternate ticks to respawn once allowed, and nothing before', () => {
    const state = world.getState();
    expect(pawn(bot.pawnId).alive).toBe(false);
    const early = bot.produce(1, state);
    expect(early.buttons & Buttons.Fire).toBe(0);
    const at = pawn(bot.pawnId).respawnAt;
    const even = at % 2 === 0 ? at : at + 1;
    expect(bot.produce(even, state).buttons & Buttons.Fire).toBe(Buttons.Fire);
    expect(bot.produce(even + 1, state).buttons & Buttons.Fire).toBe(0);
  });

  it('produces bounded, finite commands with increasing sequence numbers once alive', () => {
    let state = world.getState();
    let last: InputCommand | null = null;
    for (let tick = 1; tick <= 4 * TICK_RATE; tick++) {
      const cmd = bot.produce(tick, state);
      if (last) expect(cmd.seq).toBeGreaterThan(last.seq);
      last = cmd;
      for (const n of [cmd.moveX, cmd.moveY, cmd.yaw, cmd.pitch])
        expect(Number.isFinite(n)).toBe(true);
      expect(Math.abs(cmd.moveX)).toBeLessThanOrEqual(1 + 1e-9);
      expect(Math.abs(cmd.moveY)).toBeLessThanOrEqual(1 + 1e-9);
      expect(cmd.weapon).toBeGreaterThanOrEqual(0);
      expect(cmd.weapon).toBeLessThanOrEqual(8);
      const events = world.step(new Map([[bot.pawnId, cmd]]));
      state = world.getState();
      bot.observe(events, state);
    }
    expect(pawn(bot.pawnId).alive).toBe(true);
    expect(bot.currentGoal).not.toBeNull();
  });

  it('hears an enemy shoot, turns, sees it and fires back', () => {
    // Stand both pawns on the floor 12 m apart, the bot facing away.
    let state = world.getState();
    const enemyAlive = (): boolean => pawn(other).alive;
    const t0 = state.tick;
    for (let tick = t0 + 1; !enemyAlive() && tick < t0 + 400; tick++) {
      const cmd: InputCommand = {
        seq: tick,
        moveX: 0,
        moveY: 0,
        yaw: 0,
        pitch: 0,
        buttons: tick % 2 ? Buttons.Fire : 0,
        weapon: 0,
      };
      world.step(new Map([[other, cmd]]));
    }
    expect(enemyAlive()).toBe(true);
    const slots = (world as unknown as { slots: Map<PawnId, { mover: MoverState | null }> }).slots;
    const me = slots.get(bot.pawnId)!.mover!;
    const foe = slots.get(other)!.mover!;
    world.mover.teleport(bot.pawnId, me, { x: -50, y: 0.9, z: -40 }, Math.PI / 2);
    world.mover.teleport(other, foe, { x: -38, y: 0.9, z: -40 }, Math.PI / 2);
    state = world.getState();
    let shots = 0;
    const from = state.tick;
    for (let tick = from + 1; tick <= from + 4 * TICK_RATE; tick++) {
      const inputs = new Map<PawnId, InputCommand>();
      inputs.set(bot.pawnId, bot.produce(tick, state));
      // The enemy faces the bot (+x is yaw −π/2) and fires a burst at the start.
      inputs.set(other, {
        seq: tick,
        moveX: 0,
        moveY: 0,
        yaw: Math.PI / 2,
        pitch: 0,
        buttons: tick - from <= 6 ? Buttons.Fire : 0,
        weapon: 0,
      });
      const events = world.step(inputs);
      state = world.getState();
      bot.observe(events, state);
      shots += events.filter((e) => e.type === 'shotFired' && e.pawn === bot.pawnId).length;
    }
    expect(shots).toBeGreaterThan(0);
  });
});

describe('dodgeButton', () => {
  it('picks the dodge bit closest to the direction relative to yaw', () => {
    // Yaw 0: forward is −z, right is +x.
    expect(dodgeButton({ x: 0, y: 0, z: -1 }, 0)).toBe(Buttons.DodgeForward);
    expect(dodgeButton({ x: 0, y: 0, z: 1 }, 0)).toBe(Buttons.DodgeBack);
    expect(dodgeButton({ x: 1, y: 0, z: 0 }, 0)).toBe(Buttons.DodgeRight);
    expect(dodgeButton({ x: -1, y: 0, z: 0 }, 0)).toBe(Buttons.DodgeLeft);
    // Yaw π/2 turns the view toward −x, so −x is now forward.
    expect(dodgeButton({ x: -1, y: 0, z: 0 }, Math.PI / 2)).toBe(Buttons.DodgeForward);
  });
});
