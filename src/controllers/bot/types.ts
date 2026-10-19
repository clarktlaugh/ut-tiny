/**
 * What a bot needs from the world beyond the `WorldState` every controller
 * gets (docs/DESIGN.md §8.2, §9). Sessions build one with `worldSenses`.
 */
import type { PawnState, PickupState, Vec3 } from '../../sim/types';

export interface BotSenses {
  /** True when no map geometry blocks the segment (pawns do not block sight). */
  canSee(from: Readonly<Vec3>, to: Readonly<Vec3>): boolean;
  /** Whether the pawn would take the pickup on touching it (`PickupSystem.canTake`). */
  canTake(pawn: Readonly<PawnState>, pickup: Readonly<PickupState>): boolean;
}
