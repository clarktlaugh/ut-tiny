/**
 * Match rules (docs/DESIGN.md §6, §8.1). `DeathmatchRules` plugs into the
 * world through `createWorld(options, { rules })`.
 */
export { DeathmatchRules } from './deathmatch';
export { DEATHMATCH_RULES, DEFAULT_DEATHMATCH_OPTIONS, type DeathmatchOptions } from './config';
export {
  COUNTDOWN_LINES,
  FRAGS_LEFT_LINES,
  MULTI_KILL_LINES,
  MultiKillTracker,
  SPREE_LINES,
  multiKillLine,
  spreeLine,
} from './announcer';
export {
  buildScoreboard,
  compareScores,
  efficiencyOf,
  killsOf,
  leaderFrags,
  leaders,
  type Scoreboard,
  type ScoreboardRow,
} from './scoreboard';
