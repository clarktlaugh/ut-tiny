/**
 * Rocket Launcher (docs/DESIGN.md §5, slot 4).
 *
 * The generic path in `core/` already does most of it from the `WEAPONS.rocket`
 * row: straight rockets at 27 m/s, 90 direct, 4.4 m splash with falloff and
 * knockback, hold to load up to three (one every `loadTime`), release fires
 * them, and primary's salvo is the default horizontal fan `spread` apart.
 *
 * This module adds the two things the row cannot say:
 *
 * - **Alt salvo: tight spiral.** Loaded alt rockets leave on a small ring
 *   around the aim (`SPIRAL_ANGLE` off-axis, evenly spaced, first one on top)
 *   instead of a fan, so they arrive as a tight cluster.
 * - **Grenade mode.** Tapping alt while loading primary toggles grenade mode
 *   for that load: the salvo leaves as bouncing grenades (`lob` motion,
 *   `GRENADE_FUSE` seconds, detonate on contact with a pawn) in the same fan.
 *   The toggle lives in `state.custom` and clears once the load is fired,
 *   dropped, or the weapon is put away.
 */
import { deflect, fanSalvoDirection, fireLob, fireProjectile, type WeaponModule } from './core';

/** Off-axis angle of each rocket in an alt (spiral) salvo, rad (≈1.1°). */
export const SPIRAL_ANGLE = 0.02;
/** Fuse of a grenade-mode rocket, s (§5). */
export const GRENADE_FUSE = 2.5;
/** `state.custom` key: 1 while the current primary load is in grenade mode, else 0. */
export const GRENADE_MODE_KEY = 'grenadeMode';

export const ROCKET_MODULE: WeaponModule = {
  id: 'rocket',

  update: (ctx) => {
    const { state } = ctx;
    if (!state.loading) {
      // Grenade mode belongs to one load; a new load starts as rockets.
      state.custom[GRENADE_MODE_KEY] = 0;
      return;
    }
    if (state.loading.mode === 'primary' && ctx.pressed.alt) {
      state.custom[GRENADE_MODE_KEY] = state.custom[GRENADE_MODE_KEY] ? 0 : 1;
    }
  },

  salvoDirection: (ctx) => {
    if (ctx.mode === 'primary') return fanSalvoDirection(ctx);
    // Ring around the aim, first rocket on top, the rest evenly spaced.
    const theta = Math.PI / 2 + (2 * Math.PI * ctx.index) / ctx.count;
    return deflect(ctx.aim, SPIRAL_ANGLE, theta);
  },

  // Alt keeps the generic straight rocket; only the salvo shape differs.
  fire: {
    primary: (ctx) => {
      if (!ctx.state.custom[GRENADE_MODE_KEY]) {
        fireProjectile(ctx);
        return;
      }
      fireLob({ ...ctx, def: { ...ctx.def, fuse: GRENADE_FUSE } });
    },
  },
};
