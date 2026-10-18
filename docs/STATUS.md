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

## Known issues

- None.

## Next three packets

1. P3: Fixed-step game loop, `LocalSession`, `LoopbackTransport` (Opus), depends on P2.
2. P6: Rapier physics glue (Opus), depends on P2.
