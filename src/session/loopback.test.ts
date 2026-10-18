/**
 * LoopbackTransport against the Transport contract (tests/contracts/transport.contract.test.ts).
 */
import { describe, expect, it, vi } from 'vitest';
import { LoopbackTransport } from '../net/loopback';
import type { MatchState } from '../sim/types';
import { cmd } from './testWorld';

const match: MatchState = {
  phase: 'playing',
  fragLimit: 20,
  timeLimit: 600,
  elapsed: 0,
  scores: [],
  winner: null,
};

describe('LoopbackTransport', () => {
  it('isHost is true and players() contains only localPlayerId', () => {
    const t = new LoopbackTransport({ localPlayerId: 'me' });
    expect(t.isHost).toBe(true);
    expect(t.localPlayerId).toBe('me');
    expect(t.players()).toEqual(['me']);
    expect(new LoopbackTransport().localPlayerId).toBe('local');
  });

  it('reports the local player as joined on subscribe', () => {
    const t = new LoopbackTransport({ profile: { name: 'Ann', isBot: false } });
    const join = vi.fn();
    t.onPlayerJoin(join);
    expect(join).toHaveBeenCalledExactlyOnceWith('local', { name: 'Ann', isBot: false });
  });

  it('delivers sendInput to onInput with the sender id, in order', () => {
    const t = new LoopbackTransport();
    const got: [string, number][] = [];
    t.onInput((id, c) => got.push([id, c.seq]));
    t.sendInput(cmd(1));
    t.sendInput(cmd(2));
    expect(got).toEqual([
      ['local', 1],
      ['local', 2],
    ]);
  });

  it('delivers sendSnapshot to every onSnapshot listener', () => {
    const t = new LoopbackTransport();
    const a = vi.fn();
    const b = vi.fn();
    t.onSnapshot(a);
    t.onSnapshot(b);
    const buf = new ArrayBuffer(4);
    t.sendSnapshot(buf, []);
    expect(a).toHaveBeenCalledWith(buf, []);
    expect(b).toHaveBeenCalledWith(buf, []);
  });

  it('onMatchState fires immediately with the current value if one is known', () => {
    const t = new LoopbackTransport();
    const early = vi.fn();
    t.onMatchState(early);
    expect(early).not.toHaveBeenCalled();
    t.setMatchState(match);
    expect(early).toHaveBeenCalledExactlyOnceWith(match);
    const late = vi.fn();
    t.onMatchState(late);
    expect(late).toHaveBeenCalledExactlyOnceWith(match);
  });

  it('unsubscribe functions stop further callbacks', () => {
    const t = new LoopbackTransport();
    const input = vi.fn();
    const off = t.onInput(input);
    off();
    t.sendInput(cmd(1));
    expect(input).not.toHaveBeenCalled();
  });

  it('a listener unsubscribing during delivery does not skip the others', () => {
    const t = new LoopbackTransport();
    const second = vi.fn();
    const off = t.onInput(() => off());
    t.onInput(second);
    t.sendInput(cmd(1));
    expect(second).toHaveBeenCalledOnce();
  });

  it('close() releases all listeners and makes further sends no-ops', () => {
    const t = new LoopbackTransport();
    const input = vi.fn();
    const snap = vi.fn();
    const ms = vi.fn();
    t.onInput(input);
    t.onSnapshot(snap);
    t.onMatchState(ms);
    t.close();
    t.sendInput(cmd(1));
    t.sendSnapshot(new ArrayBuffer(0), []);
    t.setMatchState(match);
    expect(input).not.toHaveBeenCalled();
    expect(snap).not.toHaveBeenCalled();
    expect(ms).not.toHaveBeenCalled();
    expect(t.isClosed).toBe(true);
    expect(t.players()).toEqual([]);

    const join = vi.fn();
    t.onPlayerJoin(join)();
    expect(join).not.toHaveBeenCalled();
    t.close(); // idempotent
  });
});
