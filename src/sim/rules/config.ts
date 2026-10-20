/**
 * Deathmatch defaults (docs/DESIGN.md §6).
 *
 * `DEATHMATCH_RULES` is the `RulesConfig` a standard match uses: frag limit
 * 20, time limit 10 min, weapon stay, 2 s spawn protection (ended early by
 * firing, enforced by the damage pipeline in `src/sim/pawn.ts` /
 * `src/sim/damage.ts`), 1 s minimum respawn delay.
 *
 * `DeathmatchOptions` holds the announcer and flow timings that are not part
 * of the `RulesConfig` contract.
 */
import type { RulesConfig, Seconds } from '../types';

export const DEATHMATCH_RULES: Readonly<RulesConfig> = Object.freeze({
  fragLimit: 20,
  timeLimit: 600,
  weaponStay: true,
  spawnProtection: 2,
  respawnDelay: 1,
  udamageEnabled: true,
});

export interface DeathmatchOptions {
  /** Seconds of countdown before play starts; 0 starts playing on the first tick. */
  countdown: Seconds;
  /** Kills closer together than this chain into multi kills (§6: 3 s). */
  multiKillWindow: Seconds;
}

export const DEFAULT_DEATHMATCH_OPTIONS: Readonly<DeathmatchOptions> = Object.freeze({
  countdown: 3,
  multiKillWindow: 3,
});
