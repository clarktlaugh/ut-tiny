/**
 * Stand-in translocator primary until the translocator packet (M4) lands.
 *
 * The generic `lob` behavior would leave every thrown disc lying in the map
 * forever. This module keeps one disc per pawn: a throw recalls (removes) the
 * pawn's earlier discs, throws a new one and records it in `PawnState.disc`.
 * The alt (teleport) stays unimplemented. The real module replaces this one
 * by registering under the same id (`createWorld(options, { modules })`).
 */
import { fireLob, type WeaponModule } from '../weapons/core';

export const DISC_PLACEHOLDER_MODULE: WeaponModule = {
  id: 'teleporter',
  fire: {
    primary: (ctx) => {
      const { services, shooter, tick, events } = ctx;
      for (const p of services.projectilesOf(shooter.id)) {
        if (p.weapon === 'teleporter') services.destroy(p.state.id, tick, events);
      }
      fireLob(ctx);
      let newest = 0;
      for (const p of services.projectilesOf(shooter.id)) {
        if (p.weapon === 'teleporter') newest = Math.max(newest, p.state.id);
      }
      shooter.disc = newest;
    },
  },
};
