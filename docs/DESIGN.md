# ut-tiny — Design & Architecture Plan

A browser-based arena deathmatch in the spirit of Unreal Tournament 2004, set in
"tiny player, giant room" maps (laundry room, home theater, basement game room,
bathroom). Single-player vs. bots first, with the architecture laid out so a
PlayroomKit-backed multiplayer mode can be added without rewriting the game.

This document is the plan. Nothing here is implemented yet.

---

## 1. Goals and non-goals

**Goals**

- Fast, UT2004-feel movement: run, jump, double jump, dodge, wall dodge, air control.
- Eight weapons: Redeemer, Super Shock Rifle, Super Shock Rifle (scoped), Sniper
  Rifle, Rocket Launcher, Assault Rifle, Proximity Mines, Teleporter (translocator).
- Deathmatch rules: frag limit, time limit, respawns, weapon/health/shield pickups.
- Eight "tiny" maps, laundry room first: laundry room, home theater, basement game
  room, bathroom, kid's bedroom, master bedroom, unfinished basement, kitchen.
- Realistic appearance: physically based materials, baked global illumination,
  real-world reference dimensions, and photoreal-leaning textures. The rooms should
  read as photographs of real homes, not cartoons.
- Bots that path through the map, pick up items, and fight with per-weapon tactics
  at selectable skill levels.
- Runs at 60 fps in Chrome/Firefox/Safari on a mid-range laptop with integrated graphics.
- Simulation is separated from input and rendering so that a host-authoritative
  multiplayer mode (PlayroomKit) is an additive layer, not a rewrite.

**Non-goals (for now)**

- Other game modes (CTF, Onslaught, etc.).
- Client-side prediction and lag compensation. The multiplayer design leaves room
  for them, but v1 multiplayer is "host simulates, clients interpolate".
- Mobile/touch controls.
- Copying Epic's assets. All models, textures, sounds, and voice lines must be
  original or CC0. Weapon *names* are kept for personal, non-commercial use; they
  are trivially renameable via a single strings table if that ever matters.

---

## 2. Technology choices

| Concern | Choice | Why |
|---|---|---|
| Language / build | TypeScript, Vite | Fast dev loop, tree-shaking, static hosting. |
| Rendering | Three.js | Mature, good GLTF support, instancing, postprocessing. |
| Physics / collision | Rapier (`@dimforge/rapier3d-compat`) for collision queries, **custom kinematic character controller** on top | UT movement feel needs full control over acceleration, dodge, air control. Rapier gives fast raycasts, shape casts, and sensor volumes without writing a broadphase. |
| Navigation | `recast-navigation-js` (Recast/Detour in WASM) | Industry-standard navmesh generation and pathfinding; off-mesh links for jump pads and ledges. |
| Audio | Web Audio via Three.js `AudioListener` / `PositionalAudio` | Spatialized shots, explosions, footsteps; announcer on a non-positional bus. |
| Multiplayer (later) | PlayroomKit | Handles lobby, room codes, player presence, host election, RPC, and synced state with no server to run. |
| Assets | Blender (Cycles for lightmap bakes) → GLTF with KTX2 textures; procedural kitbash in code for the grey-box phase only | Realistic PBR art. CC0 photoscanned textures and HDRIs from Poly Haven / ambientCG; original models. |
| Hosting | Netlify (already linked to this repository) | Static Vite build, deploy previews per branch/PR for playtesting, CDN for large asset downloads. |
| Tests | Vitest for simulation logic (movement, weapons, rules, snapshot encode/decode) | Simulation is DOM-free and can be unit-tested headlessly. |

Rapier's JS build is not guaranteed deterministic across machines, which is fine:
the multiplayer design is host-authoritative, not lockstep, so determinism is not
a requirement.

---

## 3. World scale

The player is normal UT size and the room is built giant. This keeps movement
numbers, gravity, and weapon tuning in familiar units.

- 1 world unit = 1 meter (player scale). UT2004 conversion used for tuning: 50 UU ≈ 1 m.
- Player: 1.8 m tall capsule (radius 0.4 m), eye height 1.6 m.
- **Room scale factor S = 40.** Real furniture dimensions are multiplied by 40.
  The player is effectively 4.5 cm tall in real terms.

Examples at S = 40:

| Real object | Real size | In-game size |
|---|---|---|
| Laundry room | 3.0 × 2.5 × 2.4 m | 120 × 100 × 96 m |
| Washing machine | 0.6 × 0.6 × 0.85 m | 24 × 24 × 34 m tower |
| Detergent bottle | 0.15 × 0.1 × 0.3 m | 6 × 4 × 12 m pillar |
| Clothespin | 0.07 m long | 2.8 m — a crate-sized object |
| Shelf 1.8 m off the floor | 1.8 m | 72 m up — the "high ground" |

A 120 × 100 m playable floor with 30–35 m tall furniture platforms is roughly the
footprint of a mid-size UT2004 DM map, which is the target feel.

---

## 4. Movement

Numbers are converted from UT2004 (50 UU = 1 m) and will be tuned by feel.

| Parameter | Value |
|---|---|
| Ground speed | 8.8 m/s |
| Ground acceleration | reaches full speed in ~0.15 s |
| Gravity | 19 m/s² (UT uses ~2× Earth) |
| Jump | 6.8 m/s up → ~1.2 m apex |
| Double jump | second jump within 0.75 s of apex adds 4.5 m/s → ~2.4 m total |
| Dodge | double-tap a direction within 0.25 s: 12 m/s horizontal burst + 3.2 m/s up, 0.5 s cooldown |
| Wall dodge | dodge while airborne and within 0.6 m of a wall, once per jump |
| Air control | 35 % of ground acceleration while airborne |
| Crouch | 50 % height, 50 % speed (may be dropped if it doesn't earn its keep) |
| Fall damage | starts at 20 m/s impact, lethal at 35 m/s |

Movement runs in the fixed-step simulation (see §8) against Rapier colliders using
a custom kinematic controller: shape-cast move → slide along surfaces → step up
(≤ 0.45 m) → ground snap. Jump pads are sensor volumes that set velocity.

---

## 5. Weapons

Slot order follows UT convention. Each weapon has one pickup per map (weapon stay
on by default: the pickup stays, each player can only take it once per life).
All weapons except the Super Shock Rifle have finite ammo with separate ammo pickups.

| Slot | Weapon | Primary | Alt fire | Ammo (start / max) |
|---|---|---|---|---|
| 1 | **Teleporter** (translocator) | Throw disc (28 m/s, bounces, sticks). | Teleport to disc. Telefrag anyone occupying the destination. 1 s recharge. | ∞ |
| 2 | **Assault Rifle** | Hitscan bullets, 7 dmg, 10 shots/s, spread grows while firing. | Grenade: lobbed, bounces, 2.5 s fuse (or on contact with a pawn), 60 dmg, 3.5 m radius. | 100 / 200 bullets, 4 / 8 grenades |
| 3 | **Proximity Mines** | Lob a mine (bounces, lands, arms after 1 s). Up to 4 live per player. Detonates when an enemy is within 4 m: 80 dmg, 5 m radius. | Detonate all your mines now. (Stretch: UT's spider-mine behavior — paint a target with a laser and mines crawl toward it.) | 8 / 16 |
| 4 | **Rocket Launcher** | Rocket, 27 m/s, 90 dmg direct, 4.4 m splash with falloff and knockback. Hold to load up to 3 rockets; release fires a horizontal spread. | Same loading, but fires a tight spiral. Tap alt while loading to toggle grenade mode (bouncing rockets, 2.5 s fuse). | 12 / 30 |
| 5 | **Sniper Rifle** | Hitscan, 70 dmg body, 140 headshot, 1.33 s between shots, tracer + "HEADSHOT" announcer. | Zoom 2×–8× (hold to zoom in, scroll adjusts). Moving while zoomed adds sway. | 20 / 40 |
| 6 | **Super Shock Rifle** | Instant-kill hitscan beam (1000 dmg), 0.75 s between shots. Bright beam that lingers 0.3 s so the shooter can be located. | Shock core projectile for mobility/denial? **No** — keep it pure instagib: alt fire is also the beam. | ∞ |
| 7 | **Super Shock Rifle (scoped)** | Same beam. | Zoom 2×–6× (same scope UX as sniper). | ∞ |
| 8 | **Redeemer** | Slow nuke (20 m/s). 250 dmg at center, 50 m radius with falloff, 1.5 s screen flash, kills the shooter too if they're inside. One shot. Can be shot down in flight (the warhead has 50 hp; destroying it causes a small 4 m fizzle, not a nuke). | Guided: the camera rides the missile; the shooter steers it until impact or until they are killed. Shooter is stationary and vulnerable while guiding. | 1 / 1 |

Common rules:

- Headshots apply to hitscan weapons only (sniper, both shock rifles).
- Self-damage from splash weapons is 50 %. Rocket jumping works.
- Knockback: every damage event has a momentum vector; splash pushes pawns.
- Weapon switch time 0.3 s; "best weapon" auto-switch on pickup when the current weapon is weaker (toggleable).
- Hit confirmation is audio only (UT style), no hit markers by default.
- Each weapon has: a view model (first person), a world model (dropped/third person), a pickup model, muzzle flash, projectile/tracer FX, impact FX, sounds for fire/alt/reload/pickup/empty.

Because a single Redeemer dominates a small room, the Redeemer respawns slowly
(60 s after being picked up, it does not use weapon stay) and lives in the
hardest-to-reach spot of each map, announced with a global "Redeemer available" tone.

---

## 6. Pickups and rules

**Pawn stats:** 100 health (vials raise it to 199, decays back toward 100 at 1/s above 100), 0 shield (max 150).

| Pickup | Effect | Respawn |
|---|---|---|
| Health vial | +5 health up to 199 | 27 s |
| Health pack | +25 health up to 100 | 20 s |
| Shield pack | +50 shield up to 150 | 30 s |
| Super Shield | +100 shield up to 150 | 60 s |
| Ammo | per-weapon amount | 30 s |
| Weapon | gives weapon + base ammo | weapon stay (except Redeemer: 60 s) |
| UDamage (optional) | 2× damage for 30 s, purple glow and sound | 90 s |

**Deathmatch rules**

- Frag limit (default 20) or time limit (default 10 min); first reached wins. Overtime on ties.
- Suicide = −1 frag. Telefrags count as frags.
- Respawn after 1–2 s (press fire to respawn sooner), 2 s spawn protection that ends when you fire.
- Spawn point selection: score each spawn by distance to enemies and recency; pick the best with noise so it isn't predictable.
- Announcer events: First Blood, Double / Multi / Mega / Ultra / Monster Kill (kills within 3 s of each other), Killing Spree / Rampage / Dominating / Unstoppable / Godlike (5/10/15/20/25 kills without dying), Headshot, "X frags remaining" at 3/2/1, countdown.
- Kill feed with weapon icons; scoreboard on Tab with frags, deaths, efficiency, ping (multiplayer).
- Match flow: Main menu → Map / bots / limits → Load → Countdown (3 s) → Play → End (scoreboard, 10 s) → Menu or rematch.

---

## 7. Maps

All maps share: a few giant props as the main platforms, a jump-pad mechanic themed
per room, an unreachable-without-skill Redeemer spot, and realistic lighting from
real fixtures (a window, a ceiling light, a lamp) baked into lightmaps.
Pickups follow UT placement logic: the strongest items are in the open or high up,
health vials in trails along movement routes, ammo near (but not at) its weapon.

**Art direction: realistic.** Every room is modeled from a real floor plan and real
furniture dimensions, then scaled by 40. Materials are PBR with photoscanned
textures. Lighting is baked global illumination from Blender Cycles with real-world
light temperatures (2700 K bulbs, 5500 K daylight). Dust, scuffs, fingerprints and
lint are the signature detail at this scale: a tiny player sees surfaces the way a
macro lens does, so every material needs a close-up detail layer (see §8.3).

Build order: Laundry Room → Kid's Bedroom → Kitchen → Home Theater → Bathroom →
Master Bedroom → Basement Game Room → Unfinished Basement. The first three cover the
widest range of materials (appliances, fabric and toys, tile and stainless), so later
maps mostly reuse the material library.

### 7.1 Laundry Room (first map, grey-box target)

Real room 3.0 × 2.5 × 2.4 m → 120 × 100 × 96 m.

Layout (top-down, long axis left→right):

- **Washer and dryer** side by side along the back wall: two 24 × 24 × 34 m towers. Their tops are the prime mid-level fighting positions, connected by a 4 m gap (dodge-jumpable). The washer lid is open — jumping in is a kill volume (water) that drains over 3 s so you can escape if quick. The dryer door is open and its drum is a round room with a hidden Super Shield.
- **Shelf** above the machines at 72 m: detergent bottles and a box of dryer sheets. The **Redeemer** sits on the shelf, reached only by: dryer top → double jump onto the bleach bottle → wall dodge onto the shelf, or via translocator.
- **Dryer vent hose** (6 m diameter ribbed tube) runs from floor level behind the dryer up to a wall vent at 40 m: an interior tunnel with ammo along it, lit by gaps in the ribbing.
- **Folding table** (opposite wall, 30 m tall) with a laundry basket on top. The basket (woven, light passes through) is a cage room with the Rocket Launcher. Gaps in the weave let rockets in and out.
- **Clothes pile** on the floor: soft, lumpy terrain that provides cover and a ramp partway up the table leg.
- **Ironing board** leaning against the table forms a 35° ramp from floor to table top. The iron at the top is a hazard: standing on its plate deals 10 dmg/s.
- **Utility sink** in the corner: the Sniper Rifle is on its rim; the basin is a low pit with health vials.
- **Clothesline** across the room at 60 m with hanging socks and shirts: narrow walkway, sniper lane, swaying cloth blocks line of sight intermittently.
- **Jump pads:** spring-loaded clothespins on the floor; stepping on one launches you 30 m up to the machine tops. Detergent cap "trampolines".
- **Floor drain** center room: round grate, Shield pack on top, exposed from every direction.
- Light: one bare bulb (warm, hard shadow) plus a cool daylight slit from a small window above the shelf.
- Audio bed: dryer tumble hum, distant washer slosh, occasional pipe tick.

Pickups: AR near spawns (×2), Mines by the sink pipe, Rockets in the basket, Sniper on sink rim, Super Shock on the dryer top, Scoped Super Shock on the clothesline midpoint, Teleporter at the room entrance (floor), Redeemer on the shelf. 8 spawn points spread between floor corners, machine tops, and the table.

### 7.2 Home Theater

- Couch cushions as a stepped amphitheater; the gaps between cushions are trenches with health.
- Coffee table with a popcorn bowl (climb-in pit of popcorn, Super Shield) and a giant remote control whose buttons are jump pads.
- Speaker towers left and right of a wall-size screen: the screen plays an animated shader loop and casts colored light that shifts over time, changing visibility.
- Subwoofer pulses on a beat; standing on it bounces you.
- Redeemer on top of the screen's bezel, reached from the right speaker tower via a dodge chain along a hanging cable.
- Dim lighting; the screen is the main light source. Sniper lanes along the couch back.

### 7.3 Basement Game Room

- Pool table as the central plateau: balls are heavy rolling hazards you can shoot to push (they do knockback damage). Pockets are drop tunnels to the floor.
- Dartboard on the wall: darts stuck in it are platforms leading to the Redeemer in the bullseye.
- Foosball table: a tight lane room with rotating player rods as moving cover.
- Arcade cabinet with a flickering screen; the coin door is a hidden room.
- Bar counter with beer bottles as pillars, a bowl of pretzels (shield), a neon sign (colored light).
- Beer-tap handles as jump pads.

### 7.4 Bathroom

- Bathtub as a sunken arena with a draining-water hazard that cycles (fills and drains every 60 s).
- Toilet: the lid is a high platform; the tank top holds the Redeemer; the bowl is a kill volume ("flushed" death message).
- Sink and counter: soap dish, toothbrush holder (pillars), a running tap that pushes you off the counter.
- Toilet paper roll: an unrolled runway from the holder to the floor, a ramp with cover.
- Towel rack: walkway; towels are soft cover.
- Shower curtain: translucent, blocks sight but not shots.
- Bright, specular tile; wet floor reflections (screen-space or planar, quality option).

### 7.5 Kid's Bedroom

- Real room 3.5 × 3.0 × 2.4 m → 140 × 120 × 96 m. The largest floor, broken up by toys.
- Bed: the mattress is a sprawling soft plateau at 22 m with a rumpled duvet (soft terrain, cover). Under the bed is a dark crawl-space with a Super Shield and dust bunnies that block sight.
- Toy chest with the lid propped open: a two-level room. Building blocks spilled from it form stairs to the bed.
- Bookshelf: shelves as floors, books as walls, a missing book is a window. Redeemer on the top shelf next to a trophy, reached via the desk lamp arm.
- Desk with a laptop (screen is a light source and a ramp when half-closed), pencil cup (pillars), and a rolling chair whose wheels and base form a bridge to the bed.
- Toy train track around the floor: a train runs on a loop as a moving platform and knockback hazard.
- Jump pads: a pile of foam blocks and a whoopee cushion.
- Light: a window with blinds casting bar shadows that slowly move; a night-light in the wall socket; a ceiling fixture with a paper shade.
- Audio: a distant TV through the wall, a ticking clock, the train.

### 7.6 Master Bedroom

- Real room 4.5 × 4.0 × 2.6 m → 180 × 160 × 104 m. Fewer objects than the kid's room, so sight lines are long: a sniper map.
- King bed: a wide plateau at 26 m. Pillows are soft cover; the headboard is a wall; the gap between bed and wall is a trench.
- Nightstands either side: lamp (light source, climbable shade), phone charging (cable as a rope-bridge to the bed), a glass of water (translucent, refracts).
- Dresser with one drawer open: drawer interior is a room; the mirror above reflects (planar reflection, quality option) and gives a view of the Redeemer ledge.
- Walk-in closet: a side arena of hanging clothes (soft occluders) and shoes as crates; a shoe box with the Rocket Launcher.
- Ceiling fan: slowly rotating blades are a moving platform at 90 m; the Redeemer sits on the fan housing and is reached by riding a blade from the top of the wardrobe.
- Jump pads: the mattress edge (bouncy) and a slipper.
- Light: dawn light through curtains, warm bedside lamps; the mood is soft and low contrast, so the HDR and tonemapping must keep the dark side readable.

### 7.7 Unfinished Basement

- Real space 6.0 × 5.0 × 2.2 m → 240 × 200 × 88 m, the largest and most vertical map. Exposed joists overhead are a full upper level.
- Concrete floor with a floor drain, a crack, and a damp patch (slippery, reduces friction).
- Furnace and water heater: two industrial towers with ducts and pipes connecting them to the joists, forming the main vertical routes. The pilot light glows in a hatch (damage volume).
- Metal storage shelves stacked with cardboard boxes and plastic bins: a three-storey structure; one box is open and holds the Redeemer among holiday decorations.
- Workbench with tools: a vise, a hanging pegboard (hooks as climbable pegs), a dropped screwdriver as a ramp, a can of screws spilled (rolling hazards).
- Washer-drain utility sink and a sump pit (kill volume, "sumped" death message).
- Jump pads: a bike pump and a mousetrap.
- Light: a single bare bulb with a pull chain, a sliver of daylight from a window well. Deep shadows, dust in the light shafts (volumetric effect at high quality).
- Audio: furnace ignition, pipes knocking, muffled footsteps upstairs.

### 7.8 Kitchen

- Real room 4.0 × 3.5 × 2.6 m → 160 × 140 × 104 m. Hard, bright, reflective: the showcase map for material realism.
- Counter run along two walls at 36 m: the main upper level, with a sink (water hazard with disposal kill volume), a drying rack (climbable ribs), a cutting board with a knife (edge is a thin bridge), a fruit bowl (oranges roll), and a toaster (pops a slice as a jump pad on a timer).
- Stovetop: burners cycle on and off as damage volumes; a pot on the stove is a round room with a steam vent that lifts you.
- Fridge with the door ajar: shelves inside are a cold-lit side arena; the door's egg tray is a ladder. Magnets on the door are platforms up to the Redeemer on the fridge top, next to a cereal box.
- Kitchen table and chairs: mid-level platforms; a chair knocked over is a ramp.
- Floor: tile with grout lines, crumbs, a spill of juice (slippery), a dog bowl (water hazard) and kibble (cover).
- Jump pads: a sponge and a bag of flour (puff of dust on launch).
- Light: window daylight over the sink, under-cabinet LEDs, the fridge interior light; stainless steel and glossy tile demand environment reflections (prefiltered room cubemap captured at bake time).

---

## 8. Architecture

The core principle: **the simulation is a pure, DOM-free state machine driven by
input commands at a fixed tick rate.** Everything else (local input, bots, rendering,
audio, networking) attaches to it through narrow interfaces. This is what lets
single-player and multiplayer share the same game.

```
┌─────────────────────────────────────────────────────────────┐
│ app/              Menu, settings, match flow, map loading   │
└─────────────┬───────────────────────────────────────────────┘
              │ creates a Session
┌─────────────▼───────────────────────────────────────────────┐
│ session/          LocalSession | HostSession | ClientSession│
│                   owns the loop; wires controllers↔sim↔net  │
└──┬──────────────┬─────────────────────┬──────────────────────┘
   │ inputs       │ reads state/events  │ snapshots/inputs
┌──▼───────────┐ ┌▼────────────────┐  ┌─▼───────────────────────┐
│ controllers/ │ │ render/         │  │ net/                    │
│ Player (kbm) │ │ Three.js scene  │  │ Transport interface     │
│ Bot (AI)     │ │ view models, FX │  │ LoopbackTransport       │
│ Remote (net) │ │ HUD (DOM/canvas)│  │ PlayroomTransport       │
└──┬───────────┘ └─▲───────────────┘  └─────────────────────────┘
   │ InputCommand   │ interpolated state + event stream
┌──▼────────────────┴─────────────────────────────────────────┐
│ sim/              World: fixed 60 Hz tick                   │
│   entities (Pawn, Projectile, Mine, Disc, Pickup, JumpPad…) │
│   movement, weapons, damage, rules, spawn logic             │
│   physics glue (Rapier), seeded RNG, snapshot encode/decode │
└─────────────────────────────────────────────────────────────┘
```

### 8.1 Simulation (`sim/`)

- `World.step(tick, inputs: Map<PawnId, InputCommand>)` advances exactly one tick (1/60 s). No `Date.now()`, no `Math.random()` (uses a seeded RNG owned by the world), no Three.js, no DOM.
- Entities are plain objects in typed arrays/maps keyed by numeric IDs allocated by the world. Entity types: `Pawn`, `Projectile` (rocket, grenade, redeemer, disc), `Mine`, `Pickup`, `JumpPad`, `Volume` (kill, damage, water), `Beam` (transient hitscan record for FX).
- Weapons are data-driven: a `WeaponDef` table (damage, rates, speeds, ammo) plus a small set of `fire` behaviors (hitscan, projectile, lob, deploy, translocate). Adding a weapon is adding a row and, at most, one behavior function.
- Damage pipeline: `applyDamage(target, amount, momentum, instigator, damageType)` → shield absorbs first → health → death event with killer/weapon for the kill feed and announcer.
- Rules: `DeathmatchRules` listens to world events (death, pickup) and emits match events (score change, announcer, match end). Rules are an entity-free module so other modes can be added later.
- Events: every tick the world emits a list of `SimEvent`s (shot fired, hit, explosion, pickup taken, death, respawn, announcer). Renderer and audio consume them; the network layer forwards them to clients.
- Snapshot: `encode(world) → ArrayBuffer`, `decode(buf) → WorldState`. Quantized positions (int16 cm), quaternions (smallest-three), health/ammo as uint8/uint16. Used for multiplayer, and also for replays and tests.

### 8.2 Input (`controllers/`)

All three controller types produce the same thing each tick:

```ts
interface InputCommand {
  seq: number;        // client-side sequence number
  moveX: number;      // -1..1 strafe
  moveY: number;      // -1..1 forward/back
  yaw: number;        // radians
  pitch: number;      // radians
  buttons: number;    // bitmask: fire, altFire, jump, dodgeL/R/F/B, crouch, use
  weapon: number;     // requested slot, 0 = no change
}
```

- `PlayerController`: pointer lock + keyboard. Detects double-tap for dodges and emits the dodge bit for exactly one tick.
- `BotController`: AI (see §9). Importantly, bots are *just another controller*: they move using the same movement code and the same command format as players, so they can't cheat and so a host can run them in multiplayer with no special-casing.
- `RemoteController`: replays commands received from the network for a remote player's pawn (host side).

### 8.3 Rendering (`render/`)

- A `SceneView` mirrors world entities to Three.js objects via an ID → object map, created/destroyed from world events.
- Render runs at display refresh; state is interpolated between the last two sim ticks (alpha = accumulator / dt).
- First-person view model rendered in a second camera pass (separate FOV, never clips into walls). Weapon bob/sway driven from pawn velocity.
- FX: pooled particles (sprite sheets), beams (ribbon meshes), explosion light flash, decals (capped), gibs (ragdoll-free: a few physics-less chunks with simple ballistic motion), screen flash for Redeemer, zoom overlay.
- HUD is a DOM overlay (health/shield/ammo/weapon bar/kill feed/announcer/scoreboard), scaled by CSS. Crosshair is per-weapon SVG.
- Quality presets: shadows on/off and resolution, postprocessing (bloom, SSAO) on/off, render scale.

**Realistic look pipeline**

- Physically based materials everywhere (`MeshStandardMaterial` / `MeshPhysicalMaterial`): albedo, normal, roughness, metalness, AO; clearcoat for appliance enamel and gloss paint; transmission for glass, water glasses, the shower curtain; sheen for fabric.
- **Macro + detail layering.** At 40× scale a 2 k tile texture covers a few meters of in-game surface and looks blurry up close. Every material gets a second, tiling detail normal/roughness map (fabric weave, brushed metal, concrete grain, wood pores, dust) blended in via a small material extension (`onBeforeCompile`). This is the single most important technique for selling the "tiny" effect.
- Baked lighting: lightmaps (second UV set) for all static geometry, baked in Blender Cycles with real fixture positions and color temperatures; exported as RGBM or HDR-encoded KTX2. Dynamic objects (pawns, projectiles, pickups) are lit by light probes (spherical harmonics sampled from a probe grid baked alongside the lightmaps) plus one real-time shadow-casting light per map for the key fixture.
- Reflections: a prefiltered environment cubemap captured per map at bake time; planar reflections for mirrors and wet floors on the high preset; screen-space reflections optional.
- Postprocessing: ACES filmic tonemapping with per-map exposure, bloom (low threshold, subtle), SSAO on medium and above, a mild vignette and film grain, FXAA/SMAA or TAA. No stylization filters.
- Surface detail meshes: decals for scuffs, stains, labels and fingerprints; instanced small props (crumbs, lint, screws, popcorn) placed by scatter tools in Blender.
- Physical camera: 100° FOV but with realistic depth of field only when zoomed (scope), so the giant-room scale stays legible.
- Cloth and soft objects (duvet, towels, clothes pile) are sculpted and baked, not simulated at runtime; collision uses simplified convex hulls.

**Asset pipeline**

1. Block out the room in code or Blender from a real floor plan and furniture measurements (grey box).
2. Playtest layout with bots; iterate until routes and pickup timing are right.
3. Model props in Blender at real scale (meters), parent to the room, apply the 40× scale on export. Reuse a shared material library.
4. Bake lightmaps, probes and the environment cubemap in Blender (Cycles, denoised); pack to KTX2 (`toktx`, BasisU UASTC for normal maps, ETC1S for albedo).
5. Export GLTF with Draco or meshopt compression and custom properties for collision mode, nav mesh layer, pickup/spawn/jump pad markers. A script converts the exported scene into a `MapDef`.
6. CI (Netlify build) runs the GLTF → `MapDef` conversion and the texture packing so the repo stores source assets, not derivatives, where size permits; large bakes are committed as compressed KTX2 via Git LFS.

### 8.4 Audio (`audio/`)

- Three.js `PositionalAudio` for world sounds attached to entity views; a non-positional bus for the announcer, UI, and the player's own weapon.
- Distance model tuned for the giant room (rolloff lower than default, rooms are 100 m across).
- Announcer lines generated with a TTS voice and processed (pitch down, compressor, slight reverb) or recorded by you. Not Epic's.

### 8.5 Maps (`maps/`)

A map is a declarative description, so the same file feeds the collision world, the render scene, the navmesh bake, and (later) a Blender exporter:

```ts
interface MapDef {
  name: string;
  scale: number;                       // 40
  brushes: Brush[];                    // boxes / cylinders / ramps with material & collision
  props: PropRef[];                    // GLTF path, transform, collision mode (box|convex|trimesh|none)
  spawns: Transform[];
  pickups: { type: PickupType; pos: Vec3 }[];
  jumpPads: { pos: Vec3; size: Vec3; launch: Vec3 }[];
  volumes: { kind: 'kill'|'damage'|'water'; box: Box; params?: unknown }[];
  lights: LightDef[];
  navLinks: { from: Vec3; to: Vec3; kind: 'jump'|'pad'|'drop' }[];   // off-mesh links for bots
  ambience: { loops: string[]; reverb: string };
}
```

The laundry room starts as code-defined brushes and procedural props (a washer is a
box with a cylinder door and a bevel). Once gameplay is proven, props move to
Blender/GLTF with custom properties mapped to the same `MapDef` fields.

### 8.6 Project structure

```
ut-tiny/
  index.html
  package.json
  vite.config.ts
  public/
    models/  textures/  sounds/
  src/
    main.ts
    app/          menu, settings store, match flow
    session/      LocalSession, HostSession, ClientSession, game loop
    sim/          world, entities, movement, weapons, damage, rules, rng, snapshot, physics (Rapier glue)
    controllers/  player, bot (ai/*), remote
    render/       scene view, view models, fx, hud, materials, quality
    audio/        buses, positional sources, announcer
    net/          Transport, loopback, playroom
    nav/          navmesh bake and query (recast-navigation-js)
    maps/         laundry-room.ts, home-theater.ts, game-room.ts, bathroom.ts
    data/         weapon defs, pickup defs, strings
  tests/          vitest: movement, weapons, rules, snapshot roundtrip, bot decisions
  docs/           this file, art notes
```

---

## 9. Bots

Bots are the whole single-player experience, so they get real investment.

**Navigation**

- Navmesh baked from the map's collision geometry on load (recast-navigation-js, ~100–300 ms for these map sizes; cache the result in IndexedDB keyed by map hash).
- Off-mesh links from `MapDef.navLinks` for jump pads, double-jump ledges, and drop-downs. Links carry the input sequence needed to traverse them (e.g. "jump at entry, double-jump at apex").
- Path following steers through the same `InputCommand` interface: desired velocity → moveX/moveY relative to yaw, with look direction decoupled from movement so bots can strafe while aiming.

**Perception**

- Vision: cone (120°) + line-of-sight raycast to each enemy at 10 Hz, staggered across bots.
- Hearing: weapon fire and footsteps within a radius create "noise" memories.
- Memory: last-known position and velocity per enemy, confidence decays over 4 s.

**Decision making** (utility scores re-evaluated every 0.25 s, with hysteresis)

| Goal | Scored by |
|---|---|
| Attack | visible enemy, own health/weapon strength vs theirs |
| Hunt | recent memory of an enemy, not visible |
| Get weapon | lack of good weapon, distance to pickup, pickup availability |
| Get health / shield | health deficit, distance |
| Get ammo | low ammo on preferred weapon |
| Camp Redeemer | Redeemer about to respawn, skill ≥ Adept |
| Roam | default: visit high-value pickups weighted by distance and time since visited |
| Retreat | low health and enemy stronger |

**Combat**

- Preferred range per weapon (rockets close/mid, snipers long, instagib any); bot moves toward the ring of preferred range while strafing.
- Strafe pattern changes direction on a random timer (0.5–1.5 s) and on detecting an incoming projectile (dodge away from its path). Jumps and dodges mixed in by skill.
- Aim: target position + velocity × projectile travel time for projectiles; rockets aimed at feet when the target is grounded; aim error = Gaussian noise whose standard deviation and reaction delay come from skill; aim converges on the target over time (tracking) rather than snapping.
- Weapon choice from a range × weapon table with a bias toward whatever has ammo; Redeemer fired at clusters or at targets far away with a clear path.
- Translocator use (skill ≥ Skilled): to reach the Redeemer shelf and to escape when low.

**Skill levels** (Novice → Average → Experienced → Skilled → Adept → Masterful → Inhuman → Godlike) map to: aim error, reaction time, movement complexity (dodge/double-jump usage), perception range, and pickup-timing awareness. Exposed as a slider in the match setup, plus bot count 1–7.

---

## 10. Multiplayer-ready design (PlayroomKit later)

**Model: host-authoritative.** One browser (the Playroom host) runs the real
`World` plus all bots. Clients send `InputCommand`s; the host broadcasts snapshots
and events. Clients render interpolated snapshots.

Why this fits the sim design: `World` already consumes a map of inputs per tick
and emits snapshots and events. The host session is `LocalSession` plus "also
accept inputs from remote controllers and also publish snapshots." The client
session is "render from snapshots, send my inputs."

**Transport interface** (used from day one, with a loopback implementation):

```ts
interface Transport {
  readonly isHost: boolean;
  readonly localPlayerId: string;
  onPlayerJoin(cb: (id: string, profile: PlayerProfile) => void): void;
  onPlayerLeave(cb: (id: string) => void): void;
  // client → host
  sendInput(cmd: InputCommand): void;
  onInput(cb: (playerId: string, cmd: InputCommand) => void): void;
  // host → clients
  sendSnapshot(buf: ArrayBuffer, events: SimEvent[]): void;
  onSnapshot(cb: (buf: ArrayBuffer, events: SimEvent[]) => void): void;
  // match metadata (map, limits, scores) as replicated state
  setMatchState(state: MatchState): void;
  onMatchState(cb: (state: MatchState) => void): void;
}
```

**PlayroomKit mapping**

- `insertCoin()` provides the lobby and room code; `isHost()` selects `HostSession` vs `ClientSession`; `onPlayerJoin` / `player.onQuit` drive pawn spawn/despawn.
- Inputs: `RPC.call('input', cmd, RPC.Mode.HOST)` at 60 Hz, coalesced to 30 Hz if bandwidth is an issue (send the last 2 commands per packet for loss tolerance).
- Snapshots: host `RPC.call('snap', {buf, events}, RPC.Mode.OTHERS)` at 20 Hz. Clients buffer ~100 ms and interpolate. Full snapshot every packet at first (a few KB for 8 pawns + projectiles); delta compression is a later optimization.
- Match metadata and scores through Playroom's synced `setState` so late joiners get them for free.
- Host migration: if the host leaves, Playroom elects a new host; the new host starts a fresh world from the last match state (scores preserved, positions reset). Acceptable for casual play.

**Rules the single-player code follows now so this works later**

1. Gameplay never touches Three.js objects, the DOM, or wall-clock time.
2. All randomness goes through the world's seeded RNG.
3. Bots are controllers, so the host runs them unchanged.
4. Rendering is driven only from world state + event stream, so a client that receives snapshots instead of stepping a local world renders identically.
5. Entity IDs are numeric and allocated by the world, never by the renderer.
6. The local-player view model and HUD read from "my pawn ID," which a client gets from the host rather than assuming pawn 0.

**Later refinements** (not in v1 multiplayer): client-side prediction for the local pawn with reconciliation, host-side lag compensation for hitscan, delta snapshots, interest management (irrelevant at ≤ 8 players).

---

## 11. Controls, HUD, settings

- Mouse look with Pointer Lock; WASD; Space jump (press again at apex for double jump); double-tap WASD or dedicated keys for dodge; Ctrl crouch; LMB fire, RMB alt fire; 1–8 slots, scroll wheel cycles, Q last weapon; Tab scoreboard; F feign death (optional UT flavor); Esc menu.
- HUD: health and shield bottom-left, ammo bottom-right, weapon bar bottom-center (highlights owned weapons), kill feed top-right, announcer text center-top, frag/time status top-left, per-weapon crosshair, zoom overlay with magnification readout, damage direction indicator (optional).
- Settings: sensitivity, FOV (80–110, default 100), invert Y, auto-switch on pickup, master/SFX/music/announcer volume, quality preset, render scale, bot count and skill, frag/time limits. Persisted to localStorage.

---

## 12. Performance budget

- Target: 60 fps at 1080p on a 2020-era integrated GPU; 120 fps on discrete.
- Scene: ≤ 1 M triangles visible on the high preset (≤ 400 k on low via LODs), ≤ 300 draw calls (instancing for repeated props like clothespins, crumbs, popcorn, screws; merged static geometry per material), exactly one real-time shadow-casting light per map, everything else baked.
- Textures: ≤ 512 MB of GPU texture memory per map at high (KTX2 keeps most of it compressed on the GPU), ≤ 192 MB at low; 4 k lightmap atlases, 2 k material textures, 1 k detail maps.
- Sim: 60 Hz tick must stay under 2 ms with 8 pawns and 50 projectiles; measured in a Vitest benchmark.
- Pools for projectiles, particles, decals, and audio sources; no per-frame allocation in the hot path.
- Assets: GLTF with Draco/meshopt, KTX2 textures, initial download under 25 MB (menu, UI, weapons); each realistic map is a separate lazy-loaded bundle under 60 MB, served from Netlify's CDN with long-lived cache headers and a loading screen with progress.

---

## 13. Milestones

Each milestone ends with something playable in the browser.

| # | Milestone | Done when |
|---|---|---|
| **M0** | Scaffold | Vite + TS + Three.js + Rapier running; fixed-step loop; empty grey room; pointer lock camera; Vitest wired. |
| **M1** | Movement in a grey-box laundry room | Full UT movement set feels right against the washer/dryer/table/shelf grey boxes; jump pads; kill volume; fall damage. Movement unit tests. |
| **M2** | Core combat | Assault Rifle, Rocket Launcher, Super Shock Rifle with view models, FX, sounds, damage, death, respawn. Target dummies. |
| **M3** | Bots v1 | Navmesh bake, pathing, roaming for pickups, engaging with M2 weapons at 3 skill levels. First 1v3 match completes with frag limit, kill feed, scoreboard. |
| **M4** | Full arsenal | Sniper, Scoped Super Shock, Mines, Teleporter, Redeemer (guided + shoot-down). Bot tactics for each. Pickups and announcer complete. |
| **M5** | Laundry room realistic art pass | Procedural props replaced with Blender GLTF at real-world dimensions, PBR + detail-map materials, baked lightmaps and probes, environment reflections, ACES tonemapping, ambience. This milestone also establishes the shared material library and the bake/export pipeline. |
| **M6** | More maps | Kid's Bedroom, Kitchen, Home Theater, Bathroom, Master Bedroom, Basement Game Room, Unfinished Basement, each grey-boxed and bot-tested before art, in that order. |
| **M7** | Multiplayer | PlayroomTransport, HostSession/ClientSession, lobby UI, 2–8 players with bots filling slots. |
| **M8** | Polish | Settings, quality presets, menus, music, a final lighting and material pass across all maps, production Netlify deployment with asset caching tuned. |

M0–M3 are the critical path: if movement and bots are fun in a grey box, everything else is production.

---

## 14. Deployment (Netlify)

Netlify is already linked to this repository and is the sole hosting target.

- Build: `npm run build` (Vite) → publish `dist/`. Node version pinned in `.nvmrc` / `netlify.toml`.
- Branch deploys and deploy previews are on, so every PR gets a playable URL for playtesting; `main` is production.
- `netlify.toml` sets: SPA redirect (`/* → /index.html 200`), `Cache-Control: immutable` for hashed assets under `/assets/`, correct `Content-Type` for `.wasm`, `.ktx2`, `.glb`, and `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` headers only if we later adopt multithreaded WASM (not needed for Rapier or Recast single-threaded builds).
- Large binary assets (baked lightmaps, GLTF) live in Git LFS; Netlify's build fetches LFS objects (enable in site settings) or, if LFS bandwidth becomes a problem, baked assets move to Netlify Blobs / Large Media and the build pulls them.
- PlayroomKit later needs no server-side pieces, so Netlify static hosting still suffices for multiplayer. Netlify Functions are reserved for optional extras (leaderboards, match stats).

---

## 15. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Movement doesn't feel like UT | Build the controller first with a tuning panel (live sliders); compare against recorded UT2004 footage; keep numbers in a single `movement.ts` table. |
| Bots feel dumb or robotic | Invest in perception memory and strafe/dodge variety early (M3); add skill-based noise rather than perfect aim with a handicap. |
| Realistic giant-scale art is expensive | Grey box every map and prove the layout before any art; one shared material library and prop set reused across maps (bottles, cloth, cords, cardboard, wood, tile); CC0 photoscanned textures; strict macro + detail-map approach so textures stay cheap. Budget roughly 2–3× the time of the gameplay work for art. |
| Realistic look tanks frame rate in browsers | Baked lighting with a single real-time shadow light; LODs; KTX2 textures; quality presets measured on an integrated GPU at every milestone, not at the end. |
| Textures look blurry up close at 40× | Detail normal/roughness layer on every material from M5 onward; test with the camera 0.5 m from a surface as the acceptance check. |
| Navmesh on soft/lumpy geometry (clothes pile) | Author simplified nav collision for organic props; bake from a dedicated nav mesh layer, not render geometry. |
| Playroom RPC throughput | Measure at M7 with 8 players at 20 Hz snapshots; fall back to 10 Hz snapshots + interpolation, or delta compression. |
| Browser audio restrictions | Resume AudioContext on first click (the menu's Play button). |
| Scope creep from eight maps × eight weapons | Everything is data-driven; new weapons/maps are rows and files, not systems. Laundry room must be fun before map two starts. |

---

## 16. Open decisions (defaults chosen; change any of these)

1. **Proximity mines**: baseline is static proximity mines with manual detonate on alt fire; UT's crawling spider mines are a stretch goal. Default: static first.
2. **Weapon stay**: on (UT default). Default: on, Redeemer excepted.
3. **Translocator disc disruption**: in UT, shooting an enemy's disc "disrupts" it so teleporting kills the user. Default: include, it's cheap and fun.
4. **Crouch**: UT2004 has it but it's rarely useful in DM. Default: include, low priority.
5. **UDamage**: not requested. Default: include as a map option, off in the laundry room.
6. **FOV default**: 100 (UT2004 default was 90, modern players expect wider). Default: 100.
7. **Names**: keep UT weapon names in a single strings table. Default: keep.
8. **Hosting**: decided, Netlify (already linked to the repo). See §14.
9. **"Basement" vs "Basement Game Room"**: I read these as two distinct maps, a finished game room and an unfinished utility basement. Default: both, unfinished basement built last.
10. **Map build order**: Laundry → Kid's Bedroom → Kitchen → Home Theater → Bathroom → Master Bedroom → Game Room → Unfinished Basement, chosen to establish the material library early. Reorder freely.
