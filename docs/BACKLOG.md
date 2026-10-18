# Backlog: initial work packets (M0–M3)

Each row becomes a GitHub issue using `.github/ISSUE_TEMPLATE/work-packet.md`.
Packet numbers are stable references; issue numbers are assigned on creation.
Sections cite `docs/DESIGN.md`. "Paths" are owned paths (see DESIGN §18.1).
Tier: F = Fable, O = Opus, S = Sonnet. Sign-off: A = auto-merge when green and
reviewed, H = human sign-off on the Netlify deploy preview.

## M0 — Scaffold

| # | Packet | Tier | Sign | Depends | Paths | Acceptance |
|---|---|---|---|---|---|---|
| P1 | Repo scaffold: Vite + TS + Three.js + Rapier + Vitest, `npm run check`, ESLint/Prettier, `netlify.toml`, `CLAUDE.md`, `docs/STATUS.md`, SessionStart hook | S | A | none | root configs, `src/main.ts`, `.claude/`, `docs/STATUS.md` | `npm run check` green; Netlify preview serves a blank canvas page |
| P2 | Contracts v1: `InputCommand`, `SimEvent`, `WeaponDef`, `PickupDef`, `MapDef`, `Transport`, `World.step` signature, `ViewTarget` interface, seeded RNG; doc comments; skipped tests describing intended behavior (§8, §5.1, §10) | F | A | P1 | `src/sim/types.ts`, `src/sim/rng.ts`, `src/net/transport.ts`, `src/render/viewTarget.ts`, `tests/contracts/` | Types compile; RNG tests pass; contract tests exist as `it.todo` |
| P3 | Fixed-step game loop + `LocalSession` + `LoopbackTransport`; render interpolation alpha; pause on blur (§8, §10) | O | A | P2 | `src/session/`, `src/net/loopback.ts` | Unit test: 1000 ticks at variable frame dt produce exactly 1000 steps |
| P4 | Owned-paths CI check + PR template + auto-merge config + Claude review workflow stub (§18) | S | A | P1 | `.github/`, `scripts/check-owned-paths.ts` | A PR touching a path outside its issue's list fails CI (tested with a fixture) |
| P5 | `scripts/screenshot.ts` and `scripts/smoke.ts` with Playwright/headless Chromium; CI runs smoke (§18.3) | S | A | P3 | `scripts/`, `.github/workflows/` | Smoke runs 60 s sim in CI under 2 min wall clock; screenshot script writes PNGs for named cameras |

## M1 — Movement in the grey-box laundry room

| # | Packet | Tier | Sign | Depends | Paths | Acceptance |
|---|---|---|---|---|---|---|
| P6 | Rapier physics glue: static colliders from `MapDef` brushes, shape-cast and raycast helpers, sensor volumes (§8.1) | O | A | P2 | `src/sim/physics/` | Tests: ray/shape casts against a box world; sensor enter/exit events |
| P7 | Kinematic character controller with full UT movement set (§4): run, jump, double jump, dodge, wall dodge, air control, step-up, ground snap, fall damage; live tuning panel behind a dev flag | F | H | P6 | `src/sim/movement/`, `src/app/devTuning.ts` | Tests for jump apex, double-jump window, dodge cooldown, step height; human feel check on preview |
| P8 | Player controller: pointer lock, key bindings, double-tap dodge detection, settings persistence (§8.2, §11) | O | A | P2 | `src/controllers/player/`, `src/app/settings.ts` | Tests: double-tap timing emits dodge for one tick; bindings round-trip through localStorage |
| P9 | Laundry room grey-box `MapDef` (§7.1): brushes for machines, shelf, table, basket, sink, hose tunnel, ironing board ramp, clothesline, drain; spawns, pickup markers, jump pads, kill volumes, nav links, named screenshot cameras | F | H | P2 | `src/maps/laundry-room.ts` | Loads; smoke passes; screenshots from 6 named cameras; route checklist in the issue is walkable |
| P10 | Scene view: `MapDef` → Three.js meshes with placeholder materials, pawn capsule, debug camera, basic directional + ambient light (§8.3) | O | A | P2 | `src/render/scene/` | Screenshot of P9 matches layout; 60 fps on the CI runner's software GL is not required, no exceptions is |
| P11 | Jump pads, kill/damage/water volumes, respawn at spawn points with spawn scoring (§6) | O | A | P6, P7 | `src/sim/volumes.ts`, `src/sim/spawn.ts` | Tests: pad launch velocity; kill volume death event; spawn picks the farthest from enemies |

## M2 — Core combat

| # | Packet | Tier | Sign | Depends | Paths | Acceptance |
|---|---|---|---|---|---|---|
| P12 | Damage pipeline, health/shield, death and respawn flow, kill events, weapon inventory and switching (§5 common rules, §6) | O | A | P7 | `src/sim/damage.ts`, `src/sim/inventory.ts`, `src/sim/pawn.ts` | Tests: shield absorbs first; self-splash 50 %; switch time 0.3 s |
| P13 | Weapon framework: `WeaponDef` table, fire behaviors (hitscan, projectile, lob), ammo, projectile entity with shape-cast motion and splash (§5, §8.1) | F | A | P12 | `src/sim/weapons/core/`, `src/data/weapons.ts` | Tests: hitscan hit at range; rocket splash falloff; grenade bounce and fuse |
| P14 | Assault Rifle + Rocket Launcher + Super Shock Rifle behaviors following the P13 pattern (§5) | O | A | P13 | `src/sim/weapons/{assault,rocket,shock}.ts` | Tests per weapon: rates, damage, load-3 rockets spread, instagib one-shot |
| P15 | First-person view model pass, weapon bob/sway, muzzle flash, placeholder weapon meshes (§8.3) | O | H | P10, P12 | `src/render/viewmodel/` | Screenshot set; no clipping into walls in the test positions |
| P16 | FX system: pooled particles, beam ribbons, explosion flash, decals, gibs; AR/rocket/shock effects (§8.3) | F | H | P10, P14 | `src/render/fx/` | Screenshot set at fixed sim ticks; pool never allocates after warm-up (test) |
| P17 | Audio: buses, positional sources from events, weapon/impact/footstep placeholder sounds, AudioContext resume (§8.4) | O | A | P3, P14 | `src/audio/`, `public/sounds/` | Unit tests on event→sound mapping; manual check on preview |
| P18 | Pickups: weapon stay, ammo, health vials/packs, shields; respawn timers; pickup FX hooks (§6) | O | A | P12, P9 | `src/sim/pickups.ts`, `src/data/pickups.ts` | Tests: vial cap 199 and decay; weapon-stay once per life; respawn times |
| P19 | HUD v1: health, shield, ammo, weapon bar, crosshairs, kill feed, announcer text (§11) | S | A | P12 | `src/render/hud/` | Renders from a mocked state in a DOM test; screenshot set |

## M3 — Bots v1 and a complete match

| # | Packet | Tier | Sign | Depends | Paths | Acceptance |
|---|---|---|---|---|---|---|
| P20 | Navmesh bake from `MapDef` with recast-navigation-js, off-mesh links from `navLinks`, IndexedDB cache, debug draw (§9) | O | A | P9, P6 | `src/nav/` | Test: path exists floor→dryer top via pad link; bake under 300 ms in the smoke run |
| P21 | Bot controller: path following through `InputCommand`, perception with memory, utility goal selection, roaming for pickups (§9) | F | A | P20, P18 | `src/controllers/bot/` | Smoke: 3 bots visit ≥ 6 distinct pickups in 60 s; no bot stuck > 5 s |
| P22 | Bot combat: per-weapon ranges, strafe/dodge patterns, projectile leading, skill-based aim error and reaction, 3 initial skill levels (§9) | F | H | P21, P14 | `src/controllers/bot/combat/` | Headless 1v1 bot-vs-bot at Godlike vs Novice: Godlike wins ≥ 90 % of 20 matches; human feel check |
| P23 | Deathmatch rules: frag/time limits, suicides, spawn protection, announcer events, scoreboard data, match flow states (§6) | O | A | P12, P18 | `src/sim/rules/`, `src/app/matchFlow.ts` | Tests for every announcer trigger and the end-of-match condition |
| P24 | Menus: main menu, match setup (map, bots, skill, limits), end-of-match scoreboard, settings screen (§11) | S | A | P23, P8 | `src/app/ui/` | DOM tests; preview walk-through screenshots |
| P25 | Status, docs and CLAUDE.md refresh after M3; backlog for M4 drafted from DESIGN §5, §5.1 | S | A | P21–P24 | `docs/`, `CLAUDE.md` | Digest reads clean; M4 packets filed |

## Later milestones

M4 (full arsenal incl. disc cam and nose cam), M5 (laundry room realistic art),
M6 (seven more maps), M7 (single-player polish, one or more rounds), M8
(PlayroomKit), M9 (multiplayer polish) are broken down the same way
when their predecessor is one packet from done. Expected Fable packets in them:
view-target system and both cam overlays; translocator and Redeemer behaviors;
the first PBR material set with macro+detail layering; the washing machine and
dryer Blender model scripts (pattern for all props); lightmap/probe/cubemap bake
pipeline; each map's layout and lighting; Playroom host/client session design.
Everything else in those milestones is Opus or Sonnet replication of a pattern.
