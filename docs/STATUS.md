# Status

Always current. Every PR updates its own line. Last updated by P2.

## Merged

- Design plan and backlog (`docs/DESIGN.md`, `docs/BACKLOG.md`), PR #1.
- P1: Repo scaffold, PR #24 (merged to `docs/design-plan`; promoted to `main` by PR #28).

## In flight

- P2: Contracts v1 (branch `packet/2-contracts`, issue #3): `src/sim/types.ts`, `src/sim/rng.ts`, `src/net/transport.ts`, `src/render/viewTarget.ts`, contract tests under `tests/contracts/`.
- P3: Fixed-step game loop + `LocalSession` + `LoopbackTransport` (branch `packet/3-game-loop`, issue #4): `src/session/gameLoop.ts` (fixed 60 Hz accumulator, render alpha, pause on blur/hidden), `src/session/localSession.ts`, `src/net/loopback.ts`; tests in `src/session/*.test.ts`.

## Known issues

- None.

## Next three packets

1. P4: Owned-paths CI check, PR template, auto-merge config, review workflow stub (Sonnet), depends on P1.
2. P3: Fixed-step game loop, `LocalSession`, `LoopbackTransport` (Opus), depends on P2.
3. P6: Rapier physics glue (Opus), depends on P2.
