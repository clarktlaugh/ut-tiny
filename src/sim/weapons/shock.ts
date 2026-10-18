/**
 * Super Shock Rifle (docs/DESIGN.md §5, slot 6): pure instagib.
 *
 * Both modes are the same `hitscan` beam from the `WEAPONS.shock` row: 1000
 * damage, more than the most a pawn can carry (199 health + 150 shield), so
 * any hit on a pawn without spawn protection kills; 0.75 s between shots shared by both buttons; no
 * ammo. The `hitscan` event carries the beam for the renderer, which keeps it
 * visible for `BEAM_LINGER` seconds so the shooter can be located.
 *
 * The generic path does all of that; this module adds no hooks. The scoped
 * variant (slot 7) shares the beam but its alt is the zoom action, which
 * belongs with the sniper's scope UX in a later packet.
 */
import type { WeaponModule } from './core';

/** How long the renderer shows a shock beam, s (§5). */
export const BEAM_LINGER = 0.3;

export const SHOCK_MODULE: WeaponModule = { id: 'shock' };
