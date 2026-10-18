/**
 * View-target contract (docs/DESIGN.md §5.1, §8.3).
 *
 * The render camera follows a view target: normally the local pawn's eyes, but
 * the translocator disc while the player holds the disc-camera button, or the
 * Redeemer warhead while they guide it. The simulation never knows about
 * cameras; it exposes `viewingDisc`, `disc` and `guiding` on the pawn, and the
 * renderer resolves what to show. In multiplayer this stays client-side (§10
 * rule 7).
 */
import type { EntityId, PawnId, WorldState } from '../sim/types';

export type ViewTargetKind = 'pawn' | 'disc' | 'warhead' | 'spectator';

/** How the camera orientation is derived from the target entity. */
export type OrientationRule =
  /** Pawn eye: yaw/pitch from the pawn. */
  | 'eye'
  /** Look along the entity's velocity, smoothed (disc in flight). */
  | 'velocity'
  /** Gyro-leveled free look driven by the mouse (disc at rest). */
  | 'freeLook'
  /** Entity's own orientation (warhead nose). */
  | 'nose';

export type OverlayKind = 'none' | 'zoom' | 'translocatorCam' | 'redeemerCam' | 'static';

export interface ViewTarget {
  kind: ViewTargetKind;
  /** Entity the camera is attached to. */
  entityId: EntityId;
  orientation: OrientationRule;
  overlay: OverlayKind;
  /** Whether the first-person weapon model is drawn. */
  showViewModel: boolean;
  /** Whether mouse input rotates the camera (false while a disc is in flight or steering a warhead). */
  mouseLook: boolean;
  /** Where the audio listener sits: at the player's body or at the target. */
  listener: 'body' | 'target';
  /** Whether to render the picture-in-picture body view (quality permitting). */
  bodyPip: boolean;
}

export interface ViewTargetSettings {
  /** User preference: disc cam listener follows body (default) or disc (§16 decision 3a). */
  discCamListener: 'body' | 'target';
  /** Quality tier gate for the picture-in-picture body view. */
  allowPip: boolean;
}

/** Decides what the local player should be looking at this frame. */
export interface ViewTargetResolver {
  resolve(
    state: Readonly<WorldState>,
    localPawn: PawnId,
    settings: Readonly<ViewTargetSettings>,
  ): ViewTarget;
}
