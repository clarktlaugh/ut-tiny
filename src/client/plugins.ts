/**
 * Adapters that mount the FX system (P16) and the HUD (P19) on a client
 * through `Client.use`, so demos add them without touching the shell:
 *
 * ```ts
 * const fx = new FxSystem({ seed, surface: raycastProbe([client.view.mapView.brushes]) });
 * client.use(fxPlugin(client.scene, fx));
 * client.use(hudPlugin(new Hud(root, document, { weapons: WEAPONS, localPawn: client.localPawn })));
 * ```
 *
 * The adapters only depend on the methods they call, so this module does not
 * pull FX or HUD code into pages that do not use them.
 */
import type { Camera, Object3D } from 'three';
import type { SimEvent, WorldState } from '../sim/types';
import type { ClientPlugin } from './client';

/** The part of `FxSystem` the adapter drives. */
export interface FxLike {
  readonly root: Object3D;
  handleEvents(events: readonly SimEvent[], state?: Readonly<WorldState>): void;
  update(dt: number, camera: Camera, state?: Readonly<WorldState>): void;
  dispose(): void;
}

/** Adds `fx.root` to `scene`, feeds it tick events and updates it every frame. */
export function fxPlugin(
  scene: Object3D,
  fx: FxLike,
  options: { dispose?: boolean } = {},
): ClientPlugin {
  scene.add(fx.root);
  return {
    tick: (events, state) => fx.handleEvents(events, state),
    frame: (f) => fx.update(f.dt, f.camera, f.state),
    dispose: () => {
      scene.remove(fx.root);
      if (options.dispose !== false) fx.dispose();
    },
  };
}

/** The part of `Hud` the adapter drives. */
export interface HudLike {
  handleEvents(events: readonly SimEvent[], state: Readonly<WorldState>): void;
  update(state: Readonly<WorldState>): void;
}

/** Feeds a HUD tick events and refreshes it after every drawn frame. */
export function hudPlugin(hud: HudLike, options: { dispose?: () => void } = {}): ClientPlugin {
  return {
    tick: (events, state) => hud.handleEvents(events, state),
    afterRender: (f) => hud.update(f.state),
    ...(options.dispose ? { dispose: options.dispose } : {}),
  };
}
