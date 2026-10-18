/**
 * Network transport contract (docs/DESIGN.md §10).
 *
 * The game is host-authoritative. One peer (the host) runs the real `World`
 * and all bots; clients send `InputCommand`s and render the snapshots the host
 * broadcasts. This interface is the only thing the session layer talks to, so
 * single-player (`LoopbackTransport`, P3) and multiplayer (`PlayroomTransport`,
 * M8) are interchangeable.
 *
 * Implementations must never be imported by `src/sim`.
 */
import type { InputCommand, MatchState, PlayerId, PlayerProfile, SimEvent } from '../sim/types';

/** Callback registration returns an unsubscribe function. */
export type Unsubscribe = () => void;

export interface Transport {
  /** True on the peer that runs the simulation. Always true for loopback. */
  readonly isHost: boolean;

  /** This peer's participant id, stable for the session. */
  readonly localPlayerId: PlayerId;

  /** Participants currently connected, including the local one. */
  players(): readonly PlayerId[];

  // --- presence -----------------------------------------------------------

  onPlayerJoin(cb: (id: PlayerId, profile: PlayerProfile) => void): Unsubscribe;
  onPlayerLeave(cb: (id: PlayerId) => void): Unsubscribe;

  // --- client → host ------------------------------------------------------

  /**
   * Send this tick's command to the host. Implementations may coalesce
   * consecutive commands into one packet; ordering is by `seq`.
   */
  sendInput(cmd: InputCommand): void;

  /** Host side: receive a remote participant's command. */
  onInput(cb: (playerId: PlayerId, cmd: InputCommand) => void): Unsubscribe;

  // --- host → clients -----------------------------------------------------

  /**
   * Broadcast an encoded `WorldState` (see `SnapshotCodec`) plus the events
   * since the previous snapshot. Target cadence 20 Hz (§10).
   */
  sendSnapshot(buffer: ArrayBuffer, events: readonly SimEvent[]): void;

  /** Client side: receive a snapshot. Buffers ~100 ms and interpolates. */
  onSnapshot(cb: (buffer: ArrayBuffer, events: readonly SimEvent[]) => void): Unsubscribe;

  // --- replicated match metadata -----------------------------------------

  /** Host side: publish match metadata so late joiners receive it. */
  setMatchState(state: MatchState): void;

  /** Any side: observe match metadata changes. Fires once on subscribe with the current value if known. */
  onMatchState(cb: (state: MatchState) => void): Unsubscribe;

  // --- lifecycle ----------------------------------------------------------

  /** Called when the host leaves and this peer has been elected (§10 host migration). */
  onBecomeHost(cb: () => void): Unsubscribe;

  /** Tear down connections and listeners. */
  close(): void;
}
