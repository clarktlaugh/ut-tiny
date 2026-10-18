/**
 * Single-player session (docs/DESIGN.md §8, §10).
 *
 * Owns the game loop and wires controllers → world → listeners. It talks to
 * the network only through `Transport`, so the host session in multiplayer is
 * this same class over a real transport: participants that join become
 * players in the world, commands arriving through `onInput` drive their pawns,
 * and, given a codec, snapshots are published at a fixed tick interval.
 */
import { LoopbackTransport } from '../net/loopback';
import type { Transport, Unsubscribe } from '../net/transport';
import {
  NO_ENTITY,
  type Controller,
  type InputCommand,
  type PawnId,
  type PlayerId,
  type SimEvent,
  type SnapshotCodec,
  type World,
  type WorldState,
} from '../sim/types';
import {
  GameLoop,
  pauseOnBlur,
  type FrameResult,
  type GameLoopOptions,
  type PauseReason,
  type VisibilitySource,
} from './gameLoop';

export interface LocalSessionOptions extends GameLoopOptions {
  world: World;
  /** Defaults to a fresh `LoopbackTransport`. The session closes it on `close()`. */
  transport?: Transport;
  /** When set, encoded snapshots and the events since the last one are sent through the transport. */
  codec?: SnapshotCodec;
  /** Ticks between snapshots. Default 3 (20 Hz at 60 Hz, §10). */
  snapshotInterval?: number;
}

export type TickListener = (events: readonly SimEvent[], state: Readonly<WorldState>) => void;
export type FrameListener = (alpha: number, state: Readonly<WorldState>) => void;

export class LocalSession {
  readonly world: World;
  readonly transport: Transport;
  readonly loop: GameLoop;

  private readonly codec: SnapshotCodec | undefined;
  private readonly snapshotInterval: number;
  private readonly controllers = new Set<Controller>();
  private readonly tickListeners = new Set<TickListener>();
  private readonly frameListeners = new Set<FrameListener>();
  /** Latest command per pawn received through the transport since the last tick. */
  private readonly pendingInputs = new Map<PawnId, InputCommand>();
  private readonly unsubscribes: Unsubscribe[] = [];
  private pendingEvents: SimEvent[] = [];
  private ticksSinceSnapshot = 0;
  private detachBlur: Unsubscribe | undefined;
  private closed = false;

  constructor(options: LocalSessionOptions) {
    this.world = options.world;
    this.transport = options.transport ?? new LoopbackTransport();
    this.codec = options.codec;
    this.snapshotInterval = Math.max(1, Math.floor(options.snapshotInterval ?? 3));
    this.loop = new GameLoop(
      { step: () => this.step(), render: (alpha) => this.render(alpha) },
      options,
    );

    this.unsubscribes.push(
      this.transport.onPlayerJoin((id, profile) => {
        if (this.world.pawnFor(id) === NO_ENTITY) this.world.addPlayer(id, profile);
      }),
      this.transport.onPlayerLeave((id) => {
        this.dropInputsFor(id);
        this.world.removePlayer(id);
      }),
      this.transport.onInput((id, cmd) => this.receiveInput(id, cmd)),
    );
  }

  /** The local participant's pawn (§10 rule 6: never assume pawn 0). */
  get localPawnId(): PawnId {
    return this.world.pawnFor(this.transport.localPlayerId);
  }

  get tick(): number {
    return this.world.tick;
  }

  get paused(): boolean {
    return this.loop.paused;
  }

  /** Attach a controller (player, bot, replay). Returns a function that detaches it. */
  addController(controller: Controller): Unsubscribe {
    this.controllers.add(controller);
    return () => {
      this.controllers.delete(controller);
    };
  }

  /** Called after every tick with that tick's events and the new state. */
  onTick(cb: TickListener): Unsubscribe {
    this.tickListeners.add(cb);
    return () => {
      this.tickListeners.delete(cb);
    };
  }

  /** Called once per frame with the render interpolation factor. */
  onFrame(cb: FrameListener): Unsubscribe {
    this.frameListeners.add(cb);
    return () => {
      this.frameListeners.delete(cb);
    };
  }

  /**
   * Advance the world exactly one tick. Commands from attached controllers
   * win over commands received through the transport for the same pawn;
   * pawns with neither get `NULL_INPUT` from the world.
   */
  step(): readonly SimEvent[] {
    if (this.closed) return [];
    const state = this.world.getState();
    const tick = this.world.tick;
    const inputs = new Map(this.pendingInputs);
    this.pendingInputs.clear();
    for (const controller of this.controllers) {
      inputs.set(controller.pawnId, controller.produce(tick, state));
    }

    const events = this.world.step(inputs);
    const next = this.world.getState();
    for (const cb of [...this.tickListeners]) cb(events, next);
    this.publishSnapshot(events, next);
    return events;
  }

  /** Run one frame of `frameDt` seconds by hand (tests, headless smoke run). */
  advance(frameDt: number): FrameResult {
    return this.loop.frame(frameDt);
  }

  /** Start the frame scheduler (requestAnimationFrame in the browser). */
  start(): void {
    if (this.closed) return;
    this.loop.start();
  }

  stop(): void {
    this.loop.stop();
  }

  pause(reason?: PauseReason): void {
    this.loop.pause(reason);
  }

  resume(reason?: PauseReason): void {
    this.loop.resume(reason);
  }

  /**
   * Pause while the window is blurred or the page hidden. Defaults to the
   * global `window` and `document`. Replaces any previous binding.
   */
  pauseOnBlur(win?: EventTarget, doc?: VisibilitySource): Unsubscribe {
    this.detachBlur?.();
    const target = win ?? (typeof window === 'undefined' ? undefined : window);
    if (!target) throw new Error('pauseOnBlur needs a window');
    const visibility = doc ?? (typeof document === 'undefined' ? undefined : document);
    const detach = pauseOnBlur(this.loop, target, visibility);
    this.detachBlur = detach;
    return () => {
      if (this.detachBlur === detach) this.detachBlur = undefined;
      detach();
    };
  }

  /** Stop the loop, detach every listener and close the transport. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.loop.stop();
    this.detachBlur?.();
    this.detachBlur = undefined;
    for (const off of this.unsubscribes) off();
    this.unsubscribes.length = 0;
    this.controllers.clear();
    this.tickListeners.clear();
    this.frameListeners.clear();
    this.pendingInputs.clear();
    this.pendingEvents = [];
    this.transport.close();
  }

  private receiveInput(playerId: PlayerId, cmd: InputCommand): void {
    const pawn = this.world.pawnFor(playerId);
    if (pawn === NO_ENTITY) return;
    const prev = this.pendingInputs.get(pawn);
    // Several commands can arrive between ticks; keep the newest by sequence.
    if (prev && prev.seq > cmd.seq) return;
    this.pendingInputs.set(pawn, cmd);
  }

  private dropInputsFor(playerId: PlayerId): void {
    const pawn = this.world.pawnFor(playerId);
    if (pawn !== NO_ENTITY) this.pendingInputs.delete(pawn);
  }

  private publishSnapshot(events: readonly SimEvent[], state: Readonly<WorldState>): void {
    if (!this.codec) return;
    for (const e of events) this.pendingEvents.push(e);
    this.ticksSinceSnapshot++;
    if (this.ticksSinceSnapshot < this.snapshotInterval) return;
    const batch = this.pendingEvents;
    this.pendingEvents = [];
    this.ticksSinceSnapshot = 0;
    this.transport.sendSnapshot(this.codec.encode(state), batch);
  }

  private render(alpha: number): void {
    if (this.frameListeners.size === 0) return;
    const state = this.world.getState();
    for (const cb of [...this.frameListeners]) cb(alpha, state);
  }
}
