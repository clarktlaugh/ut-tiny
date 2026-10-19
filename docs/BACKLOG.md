# Backlog: initial work packets (M0–M3)

Each row becomes a GitHub issue using `.github/ISSUE_TEMPLATE/work-packet.md`.
Packet numbers are stable references; issue numbers are assigned on creation.
Sections cite `docs/DESIGN.md`. "Paths" are owned paths (see DESIGN §18.1).
Tier: F = Fable, O = Opus, S = Sonnet. Sign-off: A = auto-merge when green and
reviewed, H = human sign-off by playing the demo on the Netlify deploy preview on
a phone (DESIGN §18.8). Only demo packets are H.

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
| P15 | First-person view model pass, weapon bob/sway, muzzle flash, placeholder weapon meshes (§8.3) | O | H (merged before §18.8; judged again in P32) | P10, P12 | `src/render/viewmodel/` | Screenshot set; no clipping into walls in the test positions |
| P16 | FX system: pooled particles, beam ribbons, explosion flash, decals, gibs; AR/rocket/shock effects (§8.3) | F | A (judged in P32) | P10, P14 | `src/render/fx/` | Screenshot set at fixed sim ticks; pool never allocates after warm-up (test) |
| P17 | Audio: buses, positional sources from events, weapon/impact/footstep placeholder sounds, AudioContext resume (§8.4) | O | A | P3, P14 | `src/audio/`, `public/sounds/` | Unit tests on event→sound mapping; manual check on preview |
| P18 | Pickups: weapon stay, ammo, health vials/packs, shields; respawn timers; pickup FX hooks (§6) | O | A | P12, P9 | `src/sim/pickups.ts`, `src/data/pickups.ts` | Tests: vial cap 199 and decay; weapon-stay once per life; respawn times |
| P19 | HUD v1: health, shield, ammo, weapon bar, crosshairs, kill feed, announcer text (§11) | S | A | P12 | `src/render/hud/` | Renders from a mocked state in a DOM test; screenshot set |

## M3 — Bots v1 and a complete match

| # | Packet | Tier | Sign | Depends | Paths | Acceptance |
|---|---|---|---|---|---|---|
| P20 | Navmesh bake from `MapDef` with recast-navigation-js, off-mesh links from `navLinks`, IndexedDB cache, debug draw (§9) | O | A | P9, P6 | `src/nav/` | Test: path exists floor→dryer top via pad link; bake under 300 ms in the smoke run |
| P21 | Bot controller: path following through `InputCommand`, perception with memory, utility goal selection, roaming for pickups (§9) | F | A | P20, P18 | `src/controllers/bot/` | Smoke: 3 bots visit ≥ 6 distinct pickups in 60 s; no bot stuck > 5 s |
| P22 | Bot combat: per-weapon ranges, strafe/dodge patterns, projectile leading, skill-based aim error and reaction, 3 initial skill levels (§9) | F | A (judged in P33) | P21, P14 | `src/controllers/bot/combat/` | Headless 1v1 bot-vs-bot at Godlike vs Novice: Godlike wins ≥ 90 % of 20 matches |
| P23 | Deathmatch rules: frag/time limits, suicides, spawn protection, announcer events, scoreboard data, match flow states (§6) | O | A | P12, P18 | `src/sim/rules/`, `src/app/matchFlow.ts` | Tests for every announcer trigger and the end-of-match condition |
| P24 | Menus: main menu, match setup (map, bots, skill, limits), end-of-match scoreboard, settings screen (§11) | S | A | P23, P8 | `src/app/ui/` | DOM tests; preview walk-through screenshots |
| P25 | Status, docs and CLAUDE.md refresh after M3; backlog for M4 drafted from DESIGN §5, §5.1, with an M4 arsenal-sandbox demo packet | S | A | P21–P24, P33 | `docs/`, `CLAUDE.md` | Digest reads clean; M4 packets filed |

## Demo track (added 2026-10-19, runs ahead of everything else)

Playable sign-off demos on Netlify, usable on a phone (DESIGN §18.8). These
issues carry the `priority` label, so the dispatcher starts them first. P29
also fills a gap: no earlier packet implements `World`, so none of the sim
systems were wired together.

| # | Packet | Tier | Sign | Depends | Paths | Acceptance |
|---|---|---|---|---|---|---|
| P26 | Demo hub: Vite multi-page build so every demo ships in `dist/`; hub page at `/demos/`; site root redirects to the hub; `/version.json` with the commit SHA; shared demo shell (version stamp, What-to-check card, Copy feedback, FPS readout, auto low quality on touch devices, reset, `?perf=1` performance overlay, input-overlay hook for P27); the same pages work under `npm run dev`, `npm run preview` and Netlify; `dev:lan` and `preview:lan` scripts for a phone on Wi-Fi; move the existing dev demos (scene, view model, audio, and FX if P16 has merged) onto the hub (§14, §18.8) | O | A | none | `vite.config.ts`, `index.html`, `src/main.ts`, `netlify.toml`, `package.json` (scripts block only), `demos/`, `src/demos/`, and the existing demo files `src/{render/scene,render/viewmodel,audio,render/fx}/demo.{html,ts}` plus `src/render/viewmodel/demoControls.ts` (issue #49 lists them file by file, because the owned-paths check matches exact files and `dir/` prefixes only) | `npm run build` emits every registered demo page; the hub and every demo load under both `npm run dev` and `npm run preview`; built site served with `vite preview` loads each demo with no console errors (Playwright, phone and desktop viewports); hub and stamp visible on the deploy preview |
| P27 | Touch controls: floating move stick, drag-to-look, buttons for jump, fire, alt fire, crouch, next/previous weapon, flick-to-dodge; touch sensitivity setting; rotate-to-landscape hint; produces `InputCommand` through the same input state as keyboard and mouse; mounted by the demo shell on touch devices. Reuse ideas from `src/render/viewmodel/demoControls.ts` (§11) | O | A | P26, P8 | `src/controllers/touch/`, `src/demos/shell/input.ts` | Unit tests: stick → moveX/moveY, drag → yaw/pitch, flick → dodge bit for exactly one tick, buttons → bits; Playwright phone emulation on a hub demo shows the overlay and moving the stick changes the view |
| P28 | Preview smoke check: CI job that waits for the PR's Netlify deploy preview to serve the head SHA in `/version.json` (timeout 15 min), then loads every registered demo with Playwright on an emulated landscape phone (touch) and on desktop; fails on console errors, load failures or blank frames; uploads screenshots as an artifact (§18.8) | S | A | P26, P5 | `.github/workflows/preview-smoke.yml`, `scripts/preview-smoke.ts` | Job passes on a PR with working demos and fails on a fixture demo that throws on load |
| P29 | World v1: implement `World` from `src/sim/types.ts` by wiring the existing systems into `World.step`: physics, character mover, volumes and jump pads, spawn selection, pawn lifecycle and respawn, damage, inventory, weapon system with the assault, rocket and shock modules, pickups; seeded RNG; ordered events; `getState` (§8.1) | O | A | P11, P12, P13, P14, P18 | `src/sim/world.ts`, `src/sim/world/`, `tests/contracts/world.contract.test.ts` | The `World.step` and participant contract todos become passing tests; determinism test (two worlds, same inputs, identical states); a 60 s headless run on `LAUNDRY_ROOM` with scripted inputs has no exceptions or NaNs |
| P30 | Client shell: one reusable client that runs a `LocalSession` on a `World`, mirrors it with `SceneView`, draws the view model, plays audio from events, resolves the view target, and takes input from the player or touch controller; exposes hooks for FX and HUD so later demos can mount them (§8, §8.3, §8.4) | O | A | P29, P27 | `src/client/` | Mounted in a test page under `vite preview`: a player spawns in the laundry room, walks, jumps, fires the assault rifle; no console errors on phone and desktop viewports |
| P31 | **Demo D1, Laundry walkabout** (M1 sign-off): the full movement set in the grey-box laundry room using the client shell; jump pads, kill and damage volumes, fall damage, respawn; named-camera teleport buttons for each route; touch-friendly movement tuning panel whose values go into Copy feedback; What-to-check: movement feel, dodge and double jump, each pad route, room scale (§4, §7.1, §18.8) | F | H | P26, P27, P28, P30 | `demos/laundry-walkabout.html`, `src/demos/laundry-walkabout/`, `src/demos/registry.ts` | Preview smoke green; PR description starts with the tap-to-play link; every route in §7.1 reachable by the worker in the headless run |
| P32 | **Demo D2, Combat sandbox** (M2 sign-off): laundry room with stationary and strafing target dummies; assault rifle, rocket launcher, Super Shock Rifle; FX (P16), view model, audio, HUD (P19); weapon buttons in the touch overlay (§5, §8.3, §18.8) | O | H | P31, P16, P19 | `demos/combat-sandbox.html`, `src/demos/combat-sandbox/`, `src/demos/registry.ts` | Preview smoke green; dummies take damage, die and respawn; every weapon's primary and alt fire work by touch |
| P33 | **Demo D3, Bot deathmatch** (M3 sign-off): menu → match setup → 1v3 against bots in the laundry room → scoreboard; playable by touch (§6, §9, §18.8) | O | H | P32, P21, P22, P23, P24 | `demos/bot-deathmatch.html`, `src/demos/bot-deathmatch/`, `src/demos/registry.ts` | Preview smoke green; a headless 1v3 bots-only match reaches the frag limit |

## Later milestones

Every later milestone ends with its demo packet from DESIGN §18.8 (the only H
packet in that milestone), and its feature packets are A.

M4 (full arsenal incl. disc cam and nose cam), M5 (laundry room realistic art),
M6 (seven more maps), M7 (single-player polish, one or more rounds), M8
(PlayroomKit), M9 (multiplayer polish) are broken down the same way
when their predecessor is one packet from done. Expected Fable packets in them:
view-target system and both cam overlays; translocator and Redeemer behaviors;
the first PBR material set with macro+detail layering; the washing machine and
dryer Blender model scripts (pattern for all props); lightmap/probe/cubemap bake
pipeline; each map's layout and lighting; Playroom host/client session design.
Everything else in those milestones is Opus or Sonnet replication of a pattern.
