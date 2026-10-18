import { describe, expect, it, vi } from 'vitest';
import { LoopbackTransport } from '../net/loopback';
import {
  Buttons,
  NULL_INPUT,
  TICK_DT,
  type Controller,
  type InputCommand,
  type SimEvent,
  type SnapshotCodec,
  type WorldState,
} from '../sim/types';
import { LocalSession } from './localSession';
import { cmd, TestWorld } from './testWorld';

function setup(options: Partial<ConstructorParameters<typeof LocalSession>[0]> = {}) {
  const world = new TestWorld();
  const transport = new LoopbackTransport();
  const session = new LocalSession({ world, transport, ...options });
  return { world, transport, session };
}

describe('LocalSession', () => {
  it('adds the local player to the world when the transport reports it', () => {
    const { world, session } = setup();
    expect(world.players.has('local')).toBe(true);
    expect(session.localPawnId).toBe(world.pawnFor('local'));
    expect(session.localPawnId).not.toBe(0);
  });

  it('1000 ticks of variable frames step the world exactly 1000 times', () => {
    const { world, session } = setup();
    const frames = [0.007, 0.016, 0.021, 0.0333, 0.001, 0.05];
    let remaining = 1000 * TICK_DT;
    let i = 0;
    while (remaining > 1e-12) {
      const dt = Math.min(remaining, frames[i++ % frames.length] ?? 0);
      session.advance(dt);
      remaining -= dt;
    }
    expect(world.tick).toBe(1000);
    expect(session.tick).toBe(1000);
  });

  it('feeds controller commands to the world for their pawns', () => {
    const { world, session } = setup();
    const bot: Controller = {
      pawnId: world.addPlayer('bot:1', { name: 'Bot', isBot: true }),
      produce: (tick) => cmd(tick + 100),
    };
    session.addController(bot);
    session.step();
    session.step();
    expect(world.steppedInputs.map((m) => m.get(bot.pawnId)?.seq)).toEqual([100, 101]);
  });

  it('passes the tick about to run and the previous state to controllers', () => {
    const { world, session } = setup();
    const seen: [number, number][] = [];
    session.addController({
      pawnId: session.localPawnId,
      produce: (tick, state) => {
        seen.push([tick, state.tick]);
        return NULL_INPUT;
      },
    });
    session.advance(TICK_DT * 3);
    expect(seen).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
    expect(world.tick).toBe(3);
  });

  it('routes inputs sent through the transport to the sender pawn, newest seq wins, once', () => {
    const { world, transport, session } = setup();
    transport.sendInput(cmd(2, Buttons.Fire));
    transport.sendInput(cmd(1));
    session.step();
    session.step();
    const pawn = session.localPawnId;
    expect(world.steppedInputs[0]?.get(pawn)).toMatchObject({ seq: 2, buttons: Buttons.Fire });
    // Edge bits must not repeat: no new command means NULL_INPUT next tick.
    expect(world.steppedInputs[1]?.get(pawn)).toBe(NULL_INPUT);
  });

  it('controller commands win over transport commands for the same pawn', () => {
    const { world, transport, session } = setup();
    const pawn = session.localPawnId;
    const local: InputCommand = cmd(9, Buttons.Jump);
    session.addController({ pawnId: pawn, produce: () => local });
    transport.sendInput(cmd(50));
    session.step();
    expect(world.steppedInputs[0]?.get(pawn)).toBe(local);
  });

  it('detached controllers stop producing', () => {
    const { session } = setup();
    const produce = vi.fn(() => NULL_INPUT);
    const off = session.addController({ pawnId: session.localPawnId, produce });
    session.step();
    off();
    session.step();
    expect(produce).toHaveBeenCalledOnce();
  });

  it('notifies tick listeners with events and the new state, frame listeners with alpha', () => {
    const { session } = setup();
    const ticks: number[] = [];
    const alphas: number[] = [];
    session.onTick((_events, state) => ticks.push(state.tick));
    session.onFrame((alpha) => alphas.push(alpha));
    session.advance(TICK_DT * 2.5);
    expect(ticks).toEqual([1, 2]);
    expect(alphas).toHaveLength(1);
    expect(alphas[0]).toBeCloseTo(0.5, 9);
  });

  it('publishes snapshots at the configured interval with the events since the last one', () => {
    const encode = vi.fn((s: Readonly<WorldState>) => new Uint32Array([s.tick]).buffer);
    const codec: SnapshotCodec = { encode, decode: () => ({}) as WorldState };
    const { world, transport, session } = setup({ codec, snapshotInterval: 3 });
    let n = 0;
    const realStep = world.step.bind(world);
    world.step = (inputs) => {
      realStep(inputs);
      const e: SimEvent = { type: 'respawn', tick: world.tick, pawnId: ++n } as unknown as SimEvent;
      return [e];
    };
    const got: [number, number][] = [];
    transport.onSnapshot((buf, events) => got.push([new Uint32Array(buf)[0] ?? -1, events.length]));
    for (let i = 0; i < 7; i++) session.step();
    expect(got).toEqual([
      [3, 3],
      [6, 3],
    ]);
  });

  it('does not publish snapshots without a codec', () => {
    const { transport, session } = setup();
    const snap = vi.fn();
    transport.onSnapshot(snap);
    session.advance(1);
    expect(snap).not.toHaveBeenCalled();
  });

  it('pauses on blur and resumes on focus without catching up', () => {
    const { world, session } = setup();
    const win = new EventTarget();
    session.pauseOnBlur(win);
    win.dispatchEvent(new Event('blur'));
    expect(session.paused).toBe(true);
    session.advance(0.2);
    expect(world.tick).toBe(0);
    win.dispatchEvent(new Event('focus'));
    expect(session.paused).toBe(false);
    session.advance(TICK_DT);
    expect(world.tick).toBe(1);
  });

  it('removes a participant that leaves', () => {
    const world = new TestWorld();
    const transport = new LoopbackTransport();
    let leave: ((id: string) => void) | undefined;
    transport.onPlayerLeave = (cb) => {
      leave = cb;
      return () => {};
    };
    new LocalSession({ world, transport });
    expect(world.players.has('local')).toBe(true);
    leave?.('local');
    expect(world.players.has('local')).toBe(false);
  });

  it('close() stops stepping, detaches listeners and closes the transport', () => {
    const { world, transport, session } = setup();
    const onTick = vi.fn();
    session.onTick(onTick);
    session.close();
    expect(transport.isClosed).toBe(true);
    expect(session.step()).toEqual([]);
    session.advance(1);
    expect(world.tick).toBe(0);
    expect(onTick).not.toHaveBeenCalled();
    session.close();
  });
});
