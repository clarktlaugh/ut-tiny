# FX system (P16)

Pooled visual effects for the renderer (docs/DESIGN.md §8.3, budget §12). The sim
emits `SimEvent`s; `FxSystem` turns them into particles, beams, light flashes, decals
and gibs under one `root` group added to the scene.

## Pieces

| File           | What it owns                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| `fxSystem.ts`  | `FxSystem`: `handleEvents(events, state)` → recipes; `update(dt, camera, state)` → pools; `screenFlash`. |
| `effects.ts`   | The recipes and their tuning tables: muzzle flashes, tracers, lingering beams, impacts, explosions, trails, gibs. |
| `particles.ts` | `ParticleLayer`: one instanced-quad draw call per blend mode (additive light, alpha matter).             |
| `beams.ts`     | `BeamPool`: camera-facing ribbons; `linger` beams (shock, `BEAM_LINGER`) and travelling `tracer`s.      |
| `flashes.ts`   | `LightFlashPool`: a few `PointLight`s borrowed for a fraction of a second.                              |
| `decals.ts`    | `DecalPool`: capped ring of surface quads (bullet holes, scorch marks) that fade out.                   |
| `gibs.ts`      | `GibPool`: `InstancedMesh` chunks with ballistic motion, one bounce, shrink-out.                        |
| `atlas.ts`     | Procedural 4 × 4 sprite sheet (`Frame.*`), generated on the CPU, no image assets.                       |
| `surface.ts`   | `SurfaceProbe`: how decals find the wall/floor (`raycastProbe` over the map meshes).                    |
| `pool.ts`      | `SlotPool` / `RingPool`: fixed-capacity slots, oldest recycled when full, allocation counter.           |
| `timeline.ts`  | Scripted combat for the demo and the screenshot set (`FX_SHOTS`).                                       |
| `demo.ts`      | Dev page: `npm run dev` → `/src/render/fx/demo.html` (`?tick=N` freezes, `?camera=<name>`).             |

## Rules

- Every pool is sized in the constructor (`DEFAULT_CAPACITIES`) and never grows. When a
  pool is full the oldest live member is recycled. `fx.stats().allocations` and
  `.children` must not change after construction; `fx.test.ts` hammers the system past
  every capacity and asserts exactly that, plus that the typed arrays stay the same objects.
- Randomness comes from a seeded `Rng`, so the same events at the same ticks give the same
  frame. The demo steps the system with `TICK_DT` per sim tick for that reason.
- Recipes never allocate per emission: they fill module-level scratch structs and pass
  them to `emit` / `place` / `flash`, which copy.
- The sim knows nothing about any of this; the system reads events and `WorldState` only.

## Screenshots

`screenshots/` holds the fixed-tick set from `FX_SHOTS` (`<camera>-t<tick>.png`, 1280 × 720,
SwiftShader): assault burst with tracer and bullet holes, rocket impact with trail and scorch,
shock beam kill with gibs (two ticks), three-rocket salvo, grenade, Redeemer blast and the
smoke column from the overview camera. They were produced by a copy of `scripts/screenshot.ts`
pointed at `/src/render/fx/demo.html?camera=<name>&tick=<tick>`; teaching the shared script a
`--demo` option is outside this packet's owned paths.
