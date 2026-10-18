/**
 * Mixer buses (docs/DESIGN.md §8.4).
 *
 * - `world`: positional sounds from other pawns and the environment.
 * - `local`: the local player's own weapon, footsteps, pain and pickups,
 *   played non-positionally so they sit in the middle of the mix.
 * - `ui`: hit confirmation and menu sounds.
 * - `announcer`: announcer lines.
 * - `music`: map ambience beds and music.
 *
 * The user's `VolumeSettings` (src/app/settings.ts) map onto them:
 * `sfx` scales world, local and ui; `music` and `announcer` scale their own
 * bus; `master` scales everything.
 */
import type { VolumeSettings } from '../app/settings';

export const BUSES = ['world', 'local', 'ui', 'announcer', 'music'] as const;
export type Bus = (typeof BUSES)[number];

/** Fixed trim per bus, applied under the user's volume so the mix is balanced by default. */
export const BUS_TRIM: Readonly<Record<Bus, number>> = {
  world: 1,
  local: 0.8,
  ui: 0.7,
  announcer: 1,
  music: 0.6,
};

/** Linear gains for each bus (excluding master) from the user's volume settings. */
export function busGains(volume: Readonly<VolumeSettings>): Record<Bus, number> {
  const sfx = clamp01(volume.sfx);
  return {
    world: BUS_TRIM.world * sfx,
    local: BUS_TRIM.local * sfx,
    ui: BUS_TRIM.ui * sfx,
    announcer: BUS_TRIM.announcer * clamp01(volume.announcer),
    music: BUS_TRIM.music * clamp01(volume.music),
  };
}

export function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}
