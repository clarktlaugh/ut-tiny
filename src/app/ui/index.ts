/** Menus: main menu, match setup, settings and end-of-match scoreboard (docs/DESIGN.md §11). */
export { MenuUi, type MenuOptions } from './menus';
export type { UiDocument, UiNode } from './dom';
export { MENU_CSS, injectMenuStyle } from './style';
export {
  DEFAULT_MAPS,
  SCORE_HEADERS,
  limitLabel,
  scoreRowCells,
  setupFromSettings,
  settingsFromSetup,
  skillName,
  type MapOption,
} from './model';
