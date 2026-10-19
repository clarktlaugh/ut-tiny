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
- Multiplayer before the single-player game is polished (see §13).
- A polished mobile release. Touch controls good enough to play every sign-off
  demo on a phone are required from M1 (§18.8); tuning them into a first-class
  mobile experience is not a goal yet.
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
| 1 | **Teleporter** (translocator) | No disc out: throw disc (28 m/s, bounces, comes to rest). Disc out: **tap** recalls it; **hold** (≥ 0.2 s) switches your view to the disc's camera for as long as you hold, in flight or at rest (see §5.1). | Teleport to the disc, in flight or at rest, from first person or from the disc camera. Telefrag anyone occupying the destination. 1 s recharge. | ∞ |
| 2 | **Assault Rifle** | Hitscan bullets, 7 dmg, 10 shots/s, spread grows while firing. | Grenade: lobbed, bounces, 2.5 s fuse (or on contact with a pawn), 60 dmg, 3.5 m radius. | 100 / 200 bullets, 4 / 8 grenades |
| 3 | **Proximity Mines** | Lob a mine (bounces, lands, arms after 1 s). Up to 4 live per player. Detonates when an enemy is within 4 m: 80 dmg, 5 m radius. | Detonate all your mines now. (Stretch: UT's spider-mine behavior — paint a target with a laser and mines crawl toward it.) | 8 / 16 |
| 4 | **Rocket Launcher** | Rocket, 27 m/s, 90 dmg direct, 4.4 m splash with falloff and knockback. Hold to load up to 3 rockets; release fires a horizontal spread. | Same loading, but fires a tight spiral. Tap alt while loading to toggle grenade mode (bouncing rockets, 2.5 s fuse). | 12 / 30 |
| 5 | **Sniper Rifle** | Hitscan, 70 dmg body, 140 headshot, 1.33 s between shots, tracer + "HEADSHOT" announcer. | Zoom 2×–8× (hold to zoom in, scroll adjusts). Moving while zoomed adds sway. | 20 / 40 |
| 6 | **Super Shock Rifle** | Instant-kill hitscan beam (1000 dmg), 0.75 s between shots. Bright beam that lingers 0.3 s so the shooter can be located. | Shock core projectile for mobility/denial? **No** — keep it pure instagib: alt fire is also the beam. | ∞ |
| 7 | **Super Shock Rifle (scoped)** | Same beam. | Zoom 2×–6× (same scope UX as sniper). | ∞ |
| 8 | **Redeemer** | Slow nuke (20 m/s) fired straight ahead. 250 dmg at center, 50 m radius with falloff, 1.5 s screen flash, kills the shooter too if they're inside. One shot. Can be shot down in flight (the warhead has 50 hp; destroying it causes a small 4 m fizzle, not a nuke). | Guided: your view switches to the **nose camera** and the mouse steers the missile until impact (see §5.1). Fire detonates early. Your body stands still and is vulnerable while guiding. | 1 / 1 |

### 5.1 Remote camera views (translocator cam and Redeemer nose cam)

Both weapons let the player see through a remote object, exactly as in UT2004. They
share one **view-target** system in the renderer: the render camera can be attached
to any entity instead of the local pawn, with its own overlay, while the pawn keeps
existing (and dying) in the world.

**Translocator disc camera**

- With a disc out, hold primary fire to view through the disc. Release to return to first person. A dedicated "disc cam" bind is also offered for players who prefer a toggle.
- **In flight**: the camera sits at the disc, stabilized to look along the disc's velocity (the disc itself tumbles; the camera does not). Mouse look is disabled in flight so the view reads as a thrown camera, with mild smoothing on bounces.
- **At rest**: the camera is gyro-leveled at the disc's position and the mouse gives free look (full yaw, pitch clamped ±80°). This is the scouting use: throw the disc over a washing machine, look around, decide, then alt-fire to arrive or tap primary to recall.
- Teleporting while in the disc cam places you facing the direction the camera was looking. Teleporting from first person keeps your current facing (UT behavior).
- Your body stays where it is, fully vulnerable, shown in third person to everyone else. Damage to the body flashes the cam overlay red and plays the hit sound at normal volume so the player knows to bail. Death ends the cam view and recalls the disc.
- A **disrupted** disc (shot by an enemy, per open decision 3) shows static in the cam with a "DISRUPTED" warning; teleporting to it kills you, so the cam is also how you check.
- Audio: the listener stays with the body by default (so threats near you are audible), with a settings option to move it to the disc.
- Overlay: letterboxed feed with a faint scanline and chromatic aberration, "TRANSLOCATOR CAM" label, disc state (IN FLIGHT / LANDED / DISRUPTED), distance from your body to the disc, and a small picture-in-picture of your own first-person view in the corner so you are not blind at your body (medium quality and above; low quality shows only the body's health bar). No crosshair, since you cannot fire from the cam.

**Redeemer nose camera**

- Alt fire launches the warhead and immediately switches the view to a camera on its nose, looking forward. Primary fire launches unguided with no camera change.
- Steering: mouse input becomes a turn-rate command, clamped at 70°/s yaw and 50°/s pitch, with a little inertia, so the missile banks into turns. Speed is constant at 20 m/s. There is no fuel; the missile flies until it hits something.
- Fire detonates early. Alt fire during flight does nothing (prevents accidental detonation). You cannot switch weapons while guiding.
- The guiding body is frozen (no movement, no firing) and vulnerable. If the shooter dies while guiding, the warhead detonates in place (UT2004 behavior), so hunting the Redeemer user is a real counter alongside shooting the warhead down.
- The warhead can be shot down during guidance; the cam cuts to static for 0.3 s, then returns to first person with a "WARHEAD DESTROYED" message.
- Overlay: full-screen feed with heavier noise and distortion than the disc cam, a targeting reticle at the missile's heading, speed and altitude readouts, time since launch, a flashing "GUIDED MISSILE" label and a body-health bar. A warning tone plays when the body takes damage.
- Audio: listener moves with the warhead (rocket roar, wind), with the body's damage sounds mixed in non-positionally.

**Implementation notes**

- The simulation owns the facts: disc position/velocity/state, warhead position/orientation/alive, and which pawn is "viewing" or "guiding" what. It never knows about cameras. Guidance consumes the guiding pawn's `yaw`/`pitch` input as a steering command instead of as look rotation, and the `camView` button bit marks "I am holding the disc cam".
- The renderer's `ViewTargetController` resolves what the local player should see each frame (own pawn, disc, warhead), swaps camera parent and overlay, hides the first-person view model, and interpolates like any other entity. Switching takes one frame; no transition blend except the static burst on destruction.
- Bots do not need the camera: `BotController` reads disc and warhead state directly and uses the same recall/teleport/steer inputs, so the rules are identical for everyone.
- In multiplayer the view target is purely client-side. The host replicates disc, warhead and "guiding" flags in the snapshot; remote players see the guiding body standing still and the disc/warhead moving. Steering latency is the normal input round trip, which is acceptable at 20 m/s.

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
  buttons: number;    // bitmask: fire, altFire, jump, dodgeL/R/F/B, crouch, use, camView
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
- `ViewTargetController`: the render camera follows a view target that is normally the local pawn but can be the translocator disc or the Redeemer warhead (§5.1). Each target supplies position, orientation rule (eye, velocity-stabilized, gyro-leveled free look, missile nose), overlay, and whether the view model is shown. The optional picture-in-picture body view renders the pawn camera to a small render target.
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
7. Camera view targets (disc cam, nose cam) are decided by the renderer from replicated entity state, never sent over the network.

**Later refinements** (not in v1 multiplayer): client-side prediction for the local pawn with reconciliation, host-side lag compensation for hitscan, delta snapshots, interest management (irrelevant at ≤ 8 players).

---

## 11. Controls, HUD, settings

- **Touch (phones and tablets, required for every sign-off demo, §18.8):** left half of the screen is a floating move stick; dragging on the right half looks around (separate touch sensitivity); on-screen buttons for jump, fire, alt fire, crouch and next/previous weapon; a quick flick of the move stick dodges in that direction (the touch equivalent of a double tap); landscape is recommended with a rotate hint in portrait. Touch input feeds the same `InputCommand` as keyboard and mouse, so nothing downstream changes.
- Mouse look with Pointer Lock; WASD; Space jump (press again at apex for double jump); double-tap WASD or dedicated keys for dodge; Ctrl crouch; LMB fire, RMB alt fire; 1–8 slots, scroll wheel cycles, Q last weapon; Tab scoreboard; F feign death (optional UT flavor); Esc menu.
- HUD: health and shield bottom-left, ammo bottom-right, weapon bar bottom-center (highlights owned weapons), kill feed top-right, announcer text center-top, frag/time status top-left, per-weapon crosshair, zoom overlay with magnification readout, damage direction indicator (optional).
- Remote camera overlays (§5.1): translocator cam and Redeemer nose cam replace the crosshair and view model with a camera-feed treatment, keep the kill feed and the body's health visible, and show the picture-in-picture body view on medium quality and above.
- Extra binds: disc cam toggle (default none, hold primary is the primary path), Redeemer early detonate is primary fire.
- Settings: sensitivity, FOV (80–110, default 100), invert Y, auto-switch on pickup, master/SFX/music/announcer volume, quality preset, render scale, bot count and skill, frag/time limits. Persisted to localStorage.

---

## 12. Performance budget

- Target: 60 fps at 1080p on a 2020-era integrated GPU; 120 fps on discrete.
- Phones (sign-off demos, §18.8): 30 fps or better on a recent iPhone or mid-range Android in landscape. Touch devices start on the low quality preset with render scale capped at 1.0 and device pixel ratio capped at 2.
- Scene: ≤ 1 M triangles visible on the high preset (≤ 400 k on low via LODs), ≤ 300 draw calls (instancing for repeated props like clothespins, crumbs, popcorn, screws; merged static geometry per material), exactly one real-time shadow-casting light per map, everything else baked.
- Textures: ≤ 512 MB of GPU texture memory per map at high (KTX2 keeps most of it compressed on the GPU), ≤ 192 MB at low; 4 k lightmap atlases, 2 k material textures, 1 k detail maps.
- Sim: 60 Hz tick must stay under 2 ms with 8 pawns and 50 projectiles; measured in a Vitest benchmark.
- Pools for projectiles, particles, decals, and audio sources; no per-frame allocation in the hot path.
- Assets: GLTF with Draco/meshopt, KTX2 textures, initial download under 25 MB (menu, UI, weapons); each realistic map is a separate lazy-loaded bundle under 60 MB, served from Netlify's CDN with long-lived cache headers and a loading screen with progress.

---

## 13. Milestones

Each milestone ends with something playable in the browser: a sign-off demo on
Netlify that runs on a phone (§18.8). A milestone is not done until the user has
played that demo and merged its PR.

| # | Milestone | Done when |
|---|---|---|
| **M0** | Scaffold | Vite + TS + Three.js + Rapier running; fixed-step loop; empty grey room; pointer lock camera; Vitest wired. |
| **M1** | Movement in a grey-box laundry room | Full UT movement set feels right against the washer/dryer/table/shelf grey boxes; jump pads; kill volume; fall damage. Movement unit tests. |
| **M2** | Core combat | Assault Rifle, Rocket Launcher, Super Shock Rifle with view models, FX, sounds, damage, death, respawn. Target dummies. |
| **M3** | Bots v1 | Navmesh bake, pathing, roaming for pickups, engaging with M2 weapons at 3 skill levels. First 1v3 match completes with frag limit, kill feed, scoreboard. |
| **M4** | Full arsenal | Sniper, Scoped Super Shock, Mines, Teleporter, Redeemer (guided + shoot-down). Bot tactics for each. Pickups and announcer complete. |
| **M5** | Laundry room realistic art pass | Procedural props replaced with Blender GLTF at real-world dimensions, PBR + detail-map materials, baked lightmaps and probes, environment reflections, ACES tonemapping, ambience. This milestone also establishes the shared material library and the bake/export pipeline. |
| **M6** | More maps | Kid's Bedroom, Kitchen, Home Theater, Bathroom, Master Bedroom, Basement Game Room, Unfinished Basement, each grey-boxed and bot-tested before art, in that order. |
| **M7** | Single-player polish | The game should feel finished as a single-player product before any networking. Movement and weapon tuning from playtests; bot skill curve across all eight levels; menus, settings and quality presets complete; music and full announcer set; loading screens and asset streaming; performance pass against the §12 budget on an integrated GPU; a lighting and material consistency pass across all maps; accessibility basics (remappable keys, FOV, colorblind-safe HUD). Runs as one or more rounds until the user signs off on the production Netlify deploy. |
| **M8** | Multiplayer | PlayroomTransport, HostSession/ClientSession, lobby UI, 2–8 players with bots filling slots. Built on a stable, polished single-player base so network bugs are not confused with gameplay bugs. |
| **M9** | Multiplayer polish | Snapshot rate and bandwidth tuning, host migration, ping display, join-in-progress, a final pass on anything the network layer exposed. |

Sign-off demos per milestone (details in §18.8): M1 laundry walkabout, M2 combat
sandbox, M3 bot deathmatch, M4 arsenal sandbox, M5 laundry art tour, M6 one
layout demo and one art demo per map, M7 release candidate, M8 two-phone match.

M0–M3 are the critical path: if movement and bots are fun in a grey box, everything else is production.
Polish (M7) deliberately precedes multiplayer (M8): networking only multiplies
whatever gameplay and performance problems already exist, so they get fixed first.

---

## 14. Deployment (Netlify)

Netlify is already linked to this repository and is the sole hosting target.

- Build: `npm run build` (Vite) → publish `dist/`. Node version pinned in `.nvmrc` / `netlify.toml`.
- Branch deploys and deploy previews are on, so every PR gets a playable URL for playtesting; `main` is production at https://tinyut.netlify.app.
- **Every demo page is part of the production build** (Vite multi-page input), and the same pages also run under the local dev server (§18.8), so there is never a dev-only or Netlify-only demo. Demos live at `/demos/<slug>.html` and the hub at `/demos/` lists them all; until the game menu exists (P24), the site root redirects to the hub. Each build writes `/version.json` with the commit SHA (from Netlify's `COMMIT_REF`) so a reviewer and the preview smoke check can tell the preview is current. See §18.8.
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
| Playroom RPC throughput | Measure at M8 with 8 players at 20 Hz snapshots; fall back to 10 Hz snapshots + interpolation, or delta compression. |
| Browser audio restrictions | Resume AudioContext on first click (the menu's Play button). |
| Scope creep from eight maps × eight weapons | Everything is data-driven; new weapons/maps are rows and files, not systems. Laundry room must be fun before map two starts. |

---

## 16. Open decisions (defaults chosen; change any of these)

1. **Proximity mines**: baseline is static proximity mines with manual detonate on alt fire; UT's crawling spider mines are a stretch goal. Default: static first.
2. **Weapon stay**: on (UT default). Default: on, Redeemer excepted.
3. **Translocator disc disruption**: in UT, shooting an enemy's disc "disrupts" it so teleporting kills the user. Default: include, it's cheap and fun, and the disc cam is how you check for it.
3a. **Disc cam audio listener**: stays with your body by default, option to follow the disc. Default: body.
3b. **Teleport facing**: when teleporting from the disc cam you arrive facing where the camera looked. Default: yes.
4. **Crouch**: UT2004 has it but it's rarely useful in DM. Default: include, low priority.
5. **UDamage**: not requested. Default: include as a map option, off in the laundry room.
6. **FOV default**: 100 (UT2004 default was 90, modern players expect wider). Default: 100.
7. **Names**: keep UT weapon names in a single strings table. Default: keep.
8. **Hosting**: decided, Netlify (already linked to the repo). See §14.
9. **"Basement" vs "Basement Game Room"**: I read these as two distinct maps, a finished game room and an unfinished utility basement. Default: both, unfinished basement built last.
10. **Map build order**: Laundry → Kid's Bedroom → Kitchen → Home Theater → Bathroom → Master Bedroom → Game Room → Unfinished Basement, chosen to establish the material library early. Reorder freely.

---

## 17. Who does the work: model routing

Development is done by Claude Code sessions, not by hand. Each unit of work (a
"packet", §18) is tagged with the model tier that runs it. The rule: **Fable 5.1
for art generation and the hard, taste-driven problems; Opus 5.5 for implementing
well-specified systems and reviewing; Sonnet 5.5 for everything mechanical.**

A note on what "art generation" means here. No Claude model emits image or mesh
files directly. Art is *generated through code*: Blender Python scripts that model
props at real dimensions and UV/bake them, procedural texture generators (noise,
patterns, wear masks, decal SVGs), shader and material code, lighting setups, and
the scene-assembly scripts that place everything. Photoreal base textures come from
CC0 photoscans (Poly Haven, ambientCG) that scripts download and pack. Fable is the
model that writes and iterates on that code against rendered screenshots.

| Tier | Model ID | Owns |
|---|---|---|
| **Fable** | `claude-fable-5-1` | Map layout and blockout design; Blender modeling scripts for props; procedural texture and detail-map generators; material/shader extensions (macro+detail layering, cloth, water, glass); lighting and lightmap bake setup; FX design (particles, beams, explosions, cam overlays); movement-feel tuning; bot AI design and tuning; sim/net architecture and contract definitions; any bug that two Opus attempts failed to fix. |
| **Opus** | `claude-opus-5-5` | Implementing systems against a written spec: weapon behaviors from §5, pickups and rules, HUD, snapshot codec, navmesh integration, Playroom transport, view-target system; code review of every PR; CI-failure fixing on open PRs; replicating a Fable-authored pattern across the remaining maps or weapons. |
| **Sonnet** | `claude-sonnet-5-5` | Boilerplate and scaffolding, tests from specs, data tables, docs, asset packing and conversion scripts, CI and Netlify config, lint/format fixes, dependency updates, screenshot-capture scripts, backlog grooming, status digests. |
| **Haiku** | `claude-haiku-5-5` | The dispatcher and digest jobs (§18.4), which only read labels and post summaries. |

Routing rules:

1. Fable packets are few and high-leverage. Fable produces the *first* instance of
   a thing (the laundry room, the first PBR material set, the washing machine
   model script, the rocket launcher FX) plus a written pattern; Opus/Sonnet
   replicate the pattern for the other seven maps and seven weapons.
2. Any packet may escalate one tier by relabeling the issue and commenting why.
   Two failed attempts at a tier escalate automatically.
3. Review tier is always at least the implementation tier: Fable work is reviewed
   by Fable (a second session, not the author).
4. Gameplay feel (movement, weapon tuning) and art are signed off by the user
   inside a playable demo on Netlify (§18.8), never from screenshots or a dev
   server; everything else auto-merges when green and reviewed.

---

## 18. Work breakdown for unattended execution

The goal is a backlog that cloud sessions can pull from and finish without anyone
watching, with humans only reviewing deploy previews and the occasional escalation.

### 18.1 Packets

A packet is one GitHub issue that one session can finish in one sitting (target:
under half a day of agent time, under ~800 lines of diff). Every packet has:

- **Scope**: what to build, referencing this document by section number.
- **Owned paths**: the directories/files the packet may change. CI fails a PR that
  touches files outside its packet's owned paths (plus `docs/STATUS.md`).
- **Depends on**: packet numbers that must be merged first.
- **Acceptance**: commands that must pass (`npm run check` = typecheck + lint +
  vitest + build; plus packet-specific tests the packet must add) and, for visual
  work, the screenshot set it must produce.
- **Tier**: `tier:fable` / `tier:opus` / `tier:sonnet`.
- **Sign-off**: `auto` or `human`. `human` is reserved for **demo packets**
  (§18.8): integration points that ship a playable demo on Netlify. Feature
  packets are `auto`, proven by tests and screenshots, and are judged by the
  user inside the next demo.

The issue template lives at `.github/ISSUE_TEMPLATE/work-packet.md`; the initial
backlog for M0–M3 is in `docs/BACKLOG.md`.

### 18.2 Contracts first, then fan out

Parallel unattended work only works when sessions code against stable interfaces.
So each milestone begins with a single Fable "contracts" packet that lands the
types and stubs everyone else depends on (`InputCommand`, `WeaponDef`, `MapDef`,
`SimEvent`, `Transport`, the `World.step` signature, the `ViewTarget` interface),
with doc comments and failing tests that describe intended behavior. After that
merges, the milestone's remaining packets run in parallel, each on its own branch
and PR, because they own disjoint paths. Contract changes after the freeze are a
separate Fable packet, never a side effect of an implementation PR.

### 18.3 Repo scaffolding that makes sessions self-sufficient

- `CLAUDE.md`: how to run, test, build, where the plan is, the owned-paths rule,
  commit and PR conventions, and "read `docs/STATUS.md` first".
- `docs/STATUS.md`: a short, always-current list of what is merged, what is in
  flight, known issues, and the next three packets. Every PR updates its line.
- SessionStart hook (`.claude/settings.json`): installs dependencies, verifies
  Blender and the texture tools are present for art packets, warms the Rapier and
  Recast WASM downloads so the first `npm run check` is fast.
- `scripts/screenshot.ts`: Playwright + headless Chromium loads a map, runs 300 sim
  ticks with scripted inputs, and writes screenshots from fixed camera positions
  named in the map file. Art and FX packets attach these to their PR; reviewers
  and the user compare before/after.
- `scripts/smoke.ts`: headless run of a 1v3 bot match for 60 s of sim time; fails
  on exceptions, NaNs, or a bot that never moves. Runs in CI.
- Netlify deploy previews on every PR give the human sign-off a URL, and the
  demo hub (§18.8) makes every demo reachable from that URL on a phone.
- `docs/AUTOMATION.md`: the dispatcher, worker and digest procedures. The
  scheduled tasks only say "read this file from `main` and follow it", so the
  automation changes through reviewed PRs instead of by editing task prompts.

### 18.4 Dispatcher and feedback loop

Scheduled tasks in Claude Code (cloud) drive the loop. No custom infrastructure.
The exact procedures live in `docs/AUTOMATION.md`; this section is the overview.

Operational lessons, now built into the procedures:

- Scheduled tasks fire into **persistent sessions** created with the repository
  attached; a fresh session per firing has no repository and no GitHub tools.
  A persistent session accumulates context, so replace it every few weeks.
- PRs merged by the auto-merge workflow's `GITHUB_TOKEN` do not close their
  "Closes #n" issue and do not start CI runs on `main`. The dispatcher closes
  such issues itself, and workers close their own issue when the PR merges.
- Branch protection on `main` must require the `check` and `owned-paths` jobs,
  otherwise auto-merge merges before CI has run.
- Netlify's checks are not CI. A PR is green only when the GitHub Actions jobs
  have run and passed on its head commit and it has no merge conflict.

1. **Dispatcher** (Haiku or Sonnet, every hour, fresh session): lists issues
   labeled `ready` whose dependencies are closed, caps concurrency (default 3
   packets in flight, 1 of them Fable), and for each creates a cloud session on
   the repo with the issue's model tier and a standard prompt: read `CLAUDE.md`,
   `docs/STATUS.md`, the design sections the issue cites, implement the packet on
   branch `packet/<n>-<slug>`, run `npm run check`, open a PR that references the
   issue, subscribe to the PR, and drive it to green. It moves the label to
   `in-progress` and records the session ID on the issue.
2. **Worker session** (the packet's tier) does the work and owns its PR: fixes CI,
   answers review comments, merges the base on conflicts, and stops when merged
   or when it has escalated.
3. **Reviewer** (Opus, or Fable for Fable packets; triggered per PR): reviews
   against the packet's acceptance criteria and the design doc, requests changes
   or approves. Auto-merge is enabled for `signoff:auto` packets, so a green,
   approved PR merges itself; `signoff:human` PRs wait for the user with a
   tap-to-play demo link as the first line of the PR description (§18.8).
4. **Digest** (Haiku, daily): posts one summary to the user, written for a phone,
   that opens with "Waiting on you" and a tap-to-play link per demo, then what
   merged, what escalated and why, and what the dispatcher starts next; it
   refreshes `docs/STATUS.md` if a PR forgot.

Priority: the dispatcher starts issues labeled `priority` before all others,
then the lowest packet number.

Guardrails: a packet that fails CI three times in a row, or whose session errors
twice, is relabeled `blocked` with the logs attached and left for the digest;
worker sessions never force-push, never touch files outside owned paths, never
change the contracts, and never merge their own PR. The dispatcher starts nothing
when `main` is red; the first `ready` packet it then creates is "fix main".

### 18.5 How model routing is enforced

A session's model is fixed when the session is created and cannot be changed from
inside it, so routing is decided at creation time and verified at start time.

- **Creation.** Three ways to start work on a given model:
  1. In the Claude Code app or web UI, pick the model when starting a session on
     this repo.
  2. From any session, the `create_session` tool takes a `model` (`claude-sonnet-5-5`,
     `claude-opus-5-5`, `claude-haiku-5-5`, `claude-fable-5-1`), inherits the current
     environment, and accepts the packet prompt. This is what the dispatcher uses.
  3. A scheduled task (`create_trigger` with a fresh session per firing) runs on
     the model set via `update_trigger`; the dispatcher and digest tasks are set to
     Haiku/Sonnet this way.
  Subagents inside a session (the `Agent` tool with a `model` override) are fine
  for small sub-steps but do not change the parent session's model.
- **Verification.** `CLAUDE.md` tells every session, as its first action on a
  packet, to call `get_session` (no arguments), compare `session_context.model`
  with the issue's `tier:*` label, and stop with an issue comment if they differ.
  A Fable session that picks up a Sonnet packet is as much a violation as the
  reverse.
- **Visibility.** `get_session` also reports cost per session; the daily digest
  sums it by tier so drift toward Fable is visible within a day.
- **The planning session.** The session that wrote this document is Fable. It is
  used only for Fable-tier work (contracts, reviews of Fable packets, design
  changes); it spawns Sonnet/Opus sessions for everything else rather than doing
  that work itself.

### 18.6 Bootstrapping order

1. Merge the `docs/design-plan` branch so sessions can read the plan from `main`.
2. Spawn **P1** (scaffold) as a Sonnet session. It lands `CLAUDE.md`, `STATUS.md`,
   `npm run check`, the SessionStart hook and `netlify.toml`.
3. Spawn a Sonnet session to file P1–P25 as issues from `docs/BACKLOG.md` with
   tier and sign-off labels, and to create the dispatcher and digest scheduled
   tasks (set to Haiku).
4. After P1 merges, run **P2** (contracts) on Fable. From then on the dispatcher
   runs the loop; the user reviews `signoff:human` previews and the digest.

### 18.7 What the user does

The user works from a phone. Everything they are asked to do must be doable there.

- Tap the demo link in a `signoff:human` PR (or the digest), play it on the
  phone, then merge the PR in the GitHub app to approve, or comment to ask for
  changes. The worker session is subscribed and answers the comment.
- Read the daily digest; answer escalations by commenting on the issue.
- Add or reprioritize packets by editing issues and labels. Everything else runs.

### 18.8 Playable demos for sign-off

**Rule.** Anything the user is asked to sign off on is a playable demo on the PR's
Netlify deploy preview that runs on a phone. Screenshots, videos and written
descriptions are supporting material. A packet that cannot produce such a demo
is not `signoff:human`; it is `signoff:auto` and gets judged in the next demo.

**Two ways to run every demo.** Each demo is one page that works in both places;
neither is optional.

| Where | How | Use it for |
|---|---|---|
| Netlify | Deploy preview per PR, production at https://tinyut.netlify.app/demos/ | Sign-off from a phone; sharing |
| Local dev server | `npm run dev`, then `/demos/` | Fast iteration with hot reload; debugging |
| Local production build | `npm run build && npm run preview`, then `/demos/` | Performance measurement: the dev server is unminified and unbundled, so its frame times are not representative |
| Phone on the same Wi-Fi | `npm run dev:lan` or `npm run preview:lan`, then open the printed network URL | Real phone GPU and touch against local code, without waiting for a deploy |

Over plain HTTP on the LAN some browser features need a secure context (for
example the clipboard used by Copy feedback); the shell falls back to showing the
text to copy. Performance sign-off later (M5, M7) uses the local production build
and the Netlify preview, never the dev server.

**Demo hub** (packet P26).

- Vite builds every demo page into `dist/`. Demos are `demos/<slug>.html` entries
  backed by `src/demos/<slug>/`; a registry (`src/demos/registry.ts`) lists slug,
  title, milestone, status and a one-line "what to check".
- `/demos/` is the hub: one large tap target per demo, newest first, marked with
  the milestone. Until the main menu exists the site root redirects there.
- Every demo uses the shared demo shell, which provides:
  - touch controls on touch devices, keyboard and mouse on desktop (§11);
  - automatic low quality on phones (§12) and an FPS readout;
  - a "What to check" card, three to five items, shown on load and reopenable;
  - a version stamp showing the commit SHA, matching `/version.json`;
  - a **Copy feedback** button that copies the demo name, commit, device, FPS
    and any tuning values, ready to paste into a PR comment;
  - a reset button and, where relevant, a touch-friendly tuning panel;
  - a performance overlay toggled by `?perf=1` or a button: frame time graph,
    FPS, draw calls, triangles, geometries and textures (from `renderer.info`),
    JS heap where the browser exposes it, device pixel ratio and render scale.
    Its numbers are included in Copy feedback.

**Preview smoke check** (packet P28). A CI job waits for the PR's Netlify
deploy preview to serve the head commit's `version.json`, then loads every demo
in the registry with Playwright twice: emulating a phone (touch, landscape
iPhone viewport) and on desktop. It fails on console errors, a failed load, or
blank frames, and uploads screenshots as a workflow artifact. A `signoff:human`
PR is not presented to the user until this job is green.

**Sign-off PR format.** The first line of the PR description is
`▶ Play on your phone: <deploy preview demo URL>`, followed by the "What to
check" list and one line: "Merge to approve, or comment with changes." Keep the
rest short; the user reads it on a phone.

**Feedback loop.** The demo's worker session stays subscribed. A comment becomes
either a fix on the same PR (small, local) or a new tuning packet (anything
larger), so the demo PR does not grow without bound. After merge, the demo stays
on the hub and on production at https://tinyut.netlify.app/demos/.

**Demo packets by milestone.**

| Milestone | Demo | What the user judges |
|---|---|---|
| M1 | Laundry walkabout | Movement feel, jump pads and routes, room scale |
| M2 | Combat sandbox | Assault rifle, rockets, shock rifle against target dummies; view model, FX, sound, HUD |
| M3 | Bot deathmatch | A full 1v3 match against bots from the menu |
| M4 | Arsenal sandbox | Sniper, scoped shock, mines, translocator with disc cam, Redeemer with nose cam |
| M5 | Laundry art tour | Realistic art, lighting and materials, plus frame rate on the phone |
| M6 | Per map: layout demo, then art demo | Layout and routes in grey box first, art second |
| M7 | Release candidate | The whole single-player game on production |
| M8 | Two-phone match | Joining by room code and playing against each other |
