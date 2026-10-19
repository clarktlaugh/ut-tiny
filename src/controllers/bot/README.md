# Bot controller (P21)

Bots are just another `Controller` (docs/DESIGN.md §8.2, §9): each tick they read
the previous `WorldState` and return an `InputCommand`. Nothing here touches the
simulation, so bots cannot cheat and a multiplayer host runs them like players.

## Wiring a bot into a session

```ts
import { bakeNavMesh, NavMesh } from '../../nav';
import { BotController, worldSenses } from '../../controllers/bot';

const nav = new NavMesh(bakeNavMesh(map)); // or loadNavMesh for the IndexedDB cache
const senses = worldSenses(world); // SimWorld: line of sight + pickup take rules
const pawnId = world.addPlayer('bot:0', { name: 'Bot', isBot: true, skill: 3 });
const bot = new BotController({ pawnId, nav, senses, skill: 3, seed: 1, map });
session.addController(bot);
// After each tick, if the session has the events (hearing, pickup bookkeeping):
session.onTick((events, state) => bot.observe(events, state));
```

The first `BotController` on a mesh builds the shared `RouteGraph` (about 0.6 s
for the laundry room in Node); do it during loading, or call
`routeGraphFor(nav, { hazards: padHazards(map) })` ahead of time.

## Pieces

| File               | What it does                                                                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `botController.ts` | The `Controller`: respawn press, perception update, goal decision every 0.25 s with hysteresis, path following, combat aim, command composition.                                   |
| `perception.ts`    | Vision cone + line-of-sight at 10 Hz (staggered per bot), hearing from events and new enemy projectiles, per-enemy memory decaying over 4 s.                                        |
| `goals.ts`         | Utility scores for attack, hunt, get weapon / health / shield / ammo, camp Redeemer, roam, retreat; pickup valuation by need, distance, visits and respawn timers.                   |
| `pathFollower.ts`  | Waypoint steering through `InputCommand`, off-mesh link traversal (`walkOnto`, `jump`, `doubleJumpAtApex`), landing control, stuck nudges, link blocking, edge and hazard guards.   |
| `routeGraph.ts`    | Fast planner over the navmesh: a 1 m lattice joined by local cell walks, portal tables per link endpoint, landmark heuristic; returns `NavPath`s like `NavMesh.findPath`.           |
| `hazards.ts`       | Jump pad triggers as boxes to walk around, with the entry point to use a pad on purpose.                                                                                             |
| `combat.ts`        | `CombatBehavior` seam with `BasicCombat` (aim, fire in range after the skill's reaction time, hold the best weapon, strafe). P22 replaces it under `combat/`.                       |
| `skill.ts`         | Skill 0–7 → vision and hearing range, reaction, memory, pickup timing, allowed link kinds.                                                                                          |
| `senses.ts`        | `worldSenses(world)`: the two world queries a bot needs.                                                                                                                             |

## Tests

`smoke.test.ts` is the packet's acceptance run: three bots on the laundry room
for 60 s must take six distinct pickups and none may stay within 1 m for 5 s
while alive. `pathFollower.test.ts` drives the real sim on a small arena through
walking, a jump link, a pad link and a pad detour.
