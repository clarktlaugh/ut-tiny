/** HUD v1: health, shield, ammo, weapon bar, crosshairs, kill feed, announcer text (docs/DESIGN.md §11). */
export { Hud, type HudOptions } from './hud';
export type { HudDocument, HudNode } from './dom';
export { HUD_CSS, injectHudStyle } from './style';
export {
  ANNOUNCER_TEXT,
  CROSSHAIRS,
  WEAPON_LABELS,
  feedFromEvents,
  formatClock,
  readoutFor,
  statusFor,
  weaponBarFor,
  type CrosshairKind,
  type KillFeedEntry,
  type Readout,
  type WeaponBarSlot,
} from './model';
