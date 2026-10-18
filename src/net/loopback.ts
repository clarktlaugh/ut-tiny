/**
 * In-process transport for single-player (docs/DESIGN.md §10).
 *
 * The local peer is both host and only client: inputs it sends come straight
 * back through `onInput` tagged with `localPlayerId`, snapshots it sends come
 * straight back through `onSnapshot`. Delivery is synchronous and in call
 * order, so a loopback session is fully deterministic.
 */
import type { InputCommand, MatchState, PlayerId, PlayerProfile, SimEvent } from '../sim/types';
import type { Transport, Unsubscribe } from './transport';

export interface LoopbackOptions {
  /** Defaults to `'local'` (see `PlayerId`). */
  localPlayerId?: PlayerId;
  /** Defaults to `{ name: 'Player', isBot: false }`. */
  profile?: PlayerProfile;
}

/** A set of listeners whose `add` returns an unsubscribe function. */
class Listeners<A extends unknown[]> {
  private readonly set = new Set<(...args: A) => void>();

  add(cb: (...args: A) => void): Unsubscribe {
    this.set.add(cb);
    return () => {
      this.set.delete(cb);
    };
  }

  emit(...args: A): void {
    // Copy so a callback that unsubscribes (or subscribes) does not disturb this pass.
    for (const cb of [...this.set]) cb(...args);
  }

  clear(): void {
    this.set.clear();
  }
}

export class LoopbackTransport implements Transport {
  readonly isHost = true;
  readonly localPlayerId: PlayerId;
  readonly profile: Readonly<PlayerProfile>;

  private closed = false;
  private matchState: MatchState | undefined;

  private readonly joinListeners = new Listeners<[PlayerId, PlayerProfile]>();
  private readonly leaveListeners = new Listeners<[PlayerId]>();
  private readonly inputListeners = new Listeners<[PlayerId, InputCommand]>();
  private readonly snapshotListeners = new Listeners<[ArrayBuffer, readonly SimEvent[]]>();
  private readonly matchListeners = new Listeners<[MatchState]>();
  private readonly hostListeners = new Listeners<[]>();

  constructor(options: LoopbackOptions = {}) {
    this.localPlayerId = options.localPlayerId ?? 'local';
    this.profile = Object.freeze({ ...(options.profile ?? { name: 'Player', isBot: false }) });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  players(): readonly PlayerId[] {
    return this.closed ? [] : [this.localPlayerId];
  }

  /**
   * Fires immediately for the local player (who is already present), matching
   * how a networked transport reports peers that joined before the subscription.
   */
  onPlayerJoin(cb: (id: PlayerId, profile: PlayerProfile) => void): Unsubscribe {
    if (this.closed) return noop;
    const off = this.joinListeners.add(cb);
    cb(this.localPlayerId, { ...this.profile });
    return off;
  }

  /** The local player never leaves a loopback session, so this never fires. */
  onPlayerLeave(cb: (id: PlayerId) => void): Unsubscribe {
    if (this.closed) return noop;
    return this.leaveListeners.add(cb);
  }

  sendInput(cmd: InputCommand): void {
    if (this.closed) return;
    this.inputListeners.emit(this.localPlayerId, cmd);
  }

  onInput(cb: (playerId: PlayerId, cmd: InputCommand) => void): Unsubscribe {
    if (this.closed) return noop;
    return this.inputListeners.add(cb);
  }

  sendSnapshot(buffer: ArrayBuffer, events: readonly SimEvent[]): void {
    if (this.closed) return;
    this.snapshotListeners.emit(buffer, events);
  }

  onSnapshot(cb: (buffer: ArrayBuffer, events: readonly SimEvent[]) => void): Unsubscribe {
    if (this.closed) return noop;
    return this.snapshotListeners.add(cb);
  }

  setMatchState(state: MatchState): void {
    if (this.closed) return;
    this.matchState = state;
    this.matchListeners.emit(state);
  }

  onMatchState(cb: (state: MatchState) => void): Unsubscribe {
    if (this.closed) return noop;
    const off = this.matchListeners.add(cb);
    if (this.matchState) cb(this.matchState);
    return off;
  }

  /** Loopback is always the host, so host migration never happens. */
  onBecomeHost(cb: () => void): Unsubscribe {
    if (this.closed) return noop;
    return this.hostListeners.add(cb);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.matchState = undefined;
    this.joinListeners.clear();
    this.leaveListeners.clear();
    this.inputListeners.clear();
    this.snapshotListeners.clear();
    this.matchListeners.clear();
    this.hostListeners.clear();
  }
}

function noop(): void {}
