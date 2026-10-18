# Status

Always current. Every PR updates its own line. Last updated by P4.

## Merged

- Design plan and backlog (`docs/DESIGN.md`, `docs/BACKLOG.md`), PR #1.
- P1: Repo scaffold, PR #24 (merged to `docs/design-plan`; promoted to `main` by PR #28).

## In flight

- P2: Contracts v1 (branch `packet/2-contracts`, issue #3): `src/sim/types.ts`, `src/sim/rng.ts`, `src/net/transport.ts`, `src/render/viewTarget.ts`, contract tests under `tests/contracts/`.
- P3: Fixed-step game loop + `LocalSession` + `LoopbackTransport` (branch `packet/3-game-loop`, issue #4): `src/session/gameLoop.ts` (fixed 60 Hz accumulator, render alpha, pause on blur/hidden), `src/session/localSession.ts`, `src/net/loopback.ts`; tests in `src/session/*.test.ts`.
- P4: Owned-paths CI check, PR template, auto-merge and Claude review workflows (branch `packet/4-owned-paths-ci`, issue #5): `.github/`, `scripts/check-owned-paths.ts`.
- P6: Rapier physics glue (branch `packet/6-rapier-glue`, issue #7): `src/sim/physics/` — `PhysicsWorld` with static colliders from `MapDef` brushes (box, cylinder, ramp) and optional prop geometry, raycast / shape-cast / overlap queries with hit masks and actor ignore, actor capsules, and deterministic sensor enter/exit events for volumes, jump pads and custom boxes.
- P10: Scene view (branch `packet/10-scene-view`, issue #11): `src/render/scene/` — `SceneView` (map → placeholder-material meshes for box/cylinder/ramp brushes matching the physics conventions, prop placeholder boxes, map lights or a default directional + ambient rig, debug markers; pawn capsules and other entities mirrored by id with tick interpolation), free-fly `DebugCameraControls` with named-camera cycling, and a dev demo at `/src/render/scene/demo.html` using a laundry sketch fixture.
- P8: Player controller (branch `packet/8-player-controller`, issue #9): `src/controllers/player/` — `PlayerController` (keyboard/mouse → `InputCommand`, mouse look with sensitivity/invert, respawn view sync, weapon slots/wheel/last weapon), `InputState` (sub-tick press latching), `DodgeDetector` (double-tap within 250 ms emits the dodge bit for one tick), rebindable `Bindings`, pointer-lock DOM wiring; `src/app/settings.ts` — sanitised `Settings` + `SettingsStore` persisted to localStorage.

- P7: Kinematic character controller (branch `packet/7-character-controller`, issue #8): `src/sim/movement/` — `CharacterMover` (per-pawn `MoverState`, capsule sweeps against `PhysicsWorld`: slide, step-up ≤ 0.45 m, ground snap, walls, ramps), full UT set from §4 (run 8.8 m/s, 19 m/s² gravity, jump, near-apex double jump, dodge with 0.5 s cooldown, wall dodge off a wall behind the dodge, 35 % air control, crouch, fall damage, `launch()` for jump pads), `jump`/`dodge`/`land`/`footstep` events, pure kinematics helpers; `src/app/devTuning.ts` — live slider panel over `MovementConfig` behind `?tuning=1` / Vite dev, persisted to localStorage (not yet mounted by `main.ts`).
- P12: Damage pipeline, health/shield, death and respawn flow, inventory (branch `packet/12-damage-pipeline`, issue #13): `src/sim/damage.ts` (`applyDamage`: spawn protection → UDamage ×2 → own splash ×0.5 → shield absorbs first → health; `damage` then `death` events with killer/weapon/message; momentum → velocity change for knockback; telefrag/kill volume/suicide are lethal through shield and protection), `src/sim/inventory.ts` (owned weapons and ammo capped at `AmmoDef.max`, 0.3 s switch via `pendingWeapon` → `weaponSwitched`, slot/next/prev requests, no switching while guiding, auto-switch on stronger pickup, switch to best when empty), `src/sim/pawn.ts` (`PawnRecord`, respawn after `respawnDelay` + Fire press or 2 s, spawn loadout translocator + assault rifle, spawn protection ended by firing, overheal decay 1/s, `syncFromMover`); tests in `src/sim/pawn.test.ts`.
- Fix main (issue #36): `.github/workflows/claude-review.yml` was invalid YAML (unquoted `stub: PR` in `run:`), so every run failed with zero jobs; `run` is now a block scalar.

## Known issues

- None.

## Next three packets

1. P3: Fixed-step game loop, `LocalSession`, `LoopbackTransport` (Opus), depends on P2.
2. P6: Rapier physics glue (Opus), depends on P2.
