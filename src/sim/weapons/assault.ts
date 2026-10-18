/**
 * Assault Rifle (docs/DESIGN.md §5, slot 2).
 *
 * Both modes are fully described by the `WEAPONS.assault` row, so the generic
 * path in `core/` runs them and this module adds no hooks:
 *
 * - **Primary**: hitscan bullets, 7 damage, 10 shots/s (`rate` 0.1 s), one
 *   bullet each. Spread heat makes the first shot after a pause exact and
 *   opens the cone up to `spread` under sustained fire.
 * - **Alt**: a grenade lobbed at `projectileSpeed`; it bounces, detonates on
 *   contact with a pawn or after its 2.5 s fuse, 60 damage in 3.5 m. Each one
 *   costs `GRENADE_BULLET_COST` bullets from the shared pool (100 / 200 bullets
 *   = 4 / 8 grenades).
 *
 * The module exists so the world can register every weapon the same way and
 * so a later tweak has an obvious home.
 */
import type { WeaponModule } from './core';

export const ASSAULT_MODULE: WeaponModule = { id: 'assault' };
