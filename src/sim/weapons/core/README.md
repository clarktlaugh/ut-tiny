# Weapon framework (P13)

How weapons work in the sim and how to add one (P14 and later). Design: `docs/DESIGN.md` §5, §5.1, §8.1.

## Pieces

| File               | What it owns                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `host.ts`          | The contracts: `WeaponHost` (what the world provides), `WeaponModule` (per-weapon hooks), contexts, `damageTypeFor`. |
| `weaponSystem.ts`  | `WeaponSystem`: fire control per pawn, the projectile list, module registry, pawn lifecycle hooks.             |
| `fireControl.ts`   | Rate, loading (`loadMax`), spread heat, salvo fan.                                                             |
| `behaviors.ts`     | The generic `FireBehavior` functions: `hitscan`, `projectile`, `lob` (`action`/`none` need a module).           |
| `hitscan.ts`       | Ray from the eye, headshots, shooting down warheads / disrupting discs.                                        |
| `projectile.ts`    | Projectile entity: sphere-sweep motion, gravity and bounce for lobs, fuse, guidance (§5.1), detonation.        |
| `splash.ts`        | Radius damage with linear falloff, line of sight, knockback.                                                   |
| `geometry.ts`      | Eye position, head line, capsule distance.                                                                     |
| `testing.ts`       | `TestHost`: a `WeaponHost` over a `PhysicsWorld` for tests (yours too).                                         |
| `../../../data/weapons.ts` | The `WeaponDef` table.                                                                                 |

The world calls, per tick, for each pawn in ascending id: `tickPawn` from `src/sim/pawn.ts`
(life rules, switching) then `WeaponSystem.tickPawn(rec, input, tick)`; after all pawns,
`WeaponSystem.step(tick, inputs)` moves projectiles. On any death it calls `onPawnDied`, on
`removePlayer` it calls `removeOwner`, and the snapshot takes `projectileStates()`.

## What the generic path already does

A weapon whose two `FireModeDef` rows describe it needs **no code**:

- **Rate**: `rate` seconds between shots, one cooldown shared by both modes; primary wins
  when both buttons are held.
- **Ammo**: `ammoPerShot` from the weapon's single pool; no ammo, no shot; emptying the
  weapon switches to the best one (`switchIfEmpty`).
- **Spread**: `spread` is the cone half-angle at full heat; heat rises per shot and cools
  while idle, so the first shot is exact and sustained fire opens up.
- **Loading** (`loadMax` > 1): press loads one, holding loads one more every `loadTime`,
  release fires them all; the default salvo is a horizontal fan `spread` radians apart.
  A pending weapon switch releases the salvo.
- **`hitscan`**: ray up to `HITSCAN_RANGE`, `damage` (× `headshotMultiplier` above the head
  line), knockback `momentum` along the ray, `hitscan` event for beams.
- **`projectile`**: straight at `projectileSpeed`, detonates on anything.
- **`lob`**: `projectileSpeed` launch, gravity, bounces (restitution 0.5, friction 0.8),
  rests when slow on a floor, `fuse` seconds, detonates on a pawn when it has `damage`.
- **Detonation**: direct hit = `damage` to the pawn hit with `momentum` along the flight;
  then `splashDamage` (default `damage`) within `splashRadius` with linear falloff and
  line of sight, excluding the direct victim. Self splash is halved by the damage
  pipeline, momentum kept (rocket jumps).
- **Guidance**: a projectile spawned with `guided: true` sets `pawn.guiding`, turns toward
  the owner's yaw/pitch input at 70°/s / 50°/s, detonates on a Fire press, on the owner's
  death, and on impact. `guidanceStarted` / `guidanceEnded` events bracket it.
- **Shootable projectiles**: `projectileHealth` makes hitscan shots hit the projectile;
  at 0 hp it fizzles (`FIZZLE_RADIUS`). A disc hit by an enemy becomes `disrupted`.

## Adding a weapon (the P14 pattern)

1. **Row**: check the two modes in `src/data/weapons.ts`. If the generic path covers
   them, stop here.
2. **Module**: create `src/sim/weapons/<weapon>.ts` exporting a `WeaponModule`:

   ```ts
   import type { WeaponModule } from './core';

   export const ROCKET_MODULE: WeaponModule = {
     id: 'rocket',
     // Alt: same loading, tight spiral instead of a fan.
     salvoDirection: (ctx) => (ctx.mode === 'alt' ? spiral(ctx) : fan(ctx)),
     // Tap alt while loading primary → grenade mode (stash it in state.custom).
     update: (ctx) => {
       if (ctx.state.loading?.mode === 'primary' && ctx.pressed.alt) {
         ctx.state.custom.grenadeMode = ctx.state.custom.grenadeMode ? 0 : 1;
       }
     },
     // Grenade mode: lob with a fuse instead of a straight rocket.
     fire: { primary: (ctx) => (ctx.state.custom.grenadeMode ? fireLob(ctx) : fireProjectile(ctx)) },
   };
   ```

   Hooks, all optional:
   - `fire.primary` / `fire.alt`: replace the generic behavior for a mode. Required for
     `action` modes (zoom toggles, teleport, detonate mines). Ammo and rate are already
     handled; you get a `FireContext` with origin, aim, spread direction, salvo index and
     `services.spawnProjectile`.
   - `salvoDirection`: direction of each projectile in a loaded salvo.
   - `onImpact`: `'detonate' | 'bounce' | 'destroy'` for a projectile hit; default is
     `defaultImpact` in `projectile.ts`.
   - `update`: every tick the pawn holds the weapon, before fire control. `pressed` has
     the button edges; `state.custom` and `projectile.custom` are your scratch space
     (reset on switch / respawn).
   - `onProjectileRemoved`: bookkeeping when a projectile leaves (clear `pawn.disc`,
     mine counts).

3. **Register**: the world passes modules to `new WeaponSystem(host, [ROCKET_MODULE, ...])`.
4. **Test**: use `TestHost` from `core/testing.ts` (arena map with a floor and a wall at
   z = −40, pawns with their spawn protection over) and drive `system.tickPawn` /
   `system.step` with ticks; assert on the events and pawn state. See the `*.test.ts`
   files here for the shape.

Rules that stay in the core: everything reads the `WeaponDef` row for numbers; no
`Math.random()` (use `host.rng`), no wall-clock, no Three.js; projectiles never move
except through `stepProjectile`; damage only through `host.damage`.
