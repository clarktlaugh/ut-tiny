/**
 * The simulation world (docs/DESIGN.md §8.1). `createWorld(options)` builds a
 * `World` from `src/sim/types.ts` with every sim system wired in; see
 * `src/sim/world/simWorld.ts` for the per-tick order.
 */
export { DEFAULT_WEAPON_MODULES, SimWorld, createWorld, type WorldExtras } from './world/simWorld';
export { BasicMatchRules, type MatchRules, type MatchView } from './world/matchRules';
export { DISC_PLACEHOLDER_MODULE } from './world/discPlaceholder';
export { sanitizeInput } from './world/input';
