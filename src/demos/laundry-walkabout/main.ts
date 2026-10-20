/**
 * Demo D1, Laundry walkabout (P31; docs/DESIGN.md §4, §7.1, §18.8), built
 * as `/demos/laundry-walkabout.html`: the full movement set in the grey-box
 * laundry room on the client shell (P30), with the map's jump pads, kill and
 * damage volumes and respawn, a Go-to panel that teleports to the named
 * cameras and to the start of every §7.1 route, a touch-friendly movement
 * tuning panel whose values go into Copy feedback, and a movement readout.
 *
 * Query parameters (besides the shell's `card=0`, `quality=`, `perf=1` and
 * the client's `touch=1|0`): `at=<place>` starts at a Go-to place, by id
 * (`camera:shelf`, `route:R4`) or short name (`shelf`, `R4`). When the first
 * frame has rendered, `document.body.dataset.ready` is `"1"`.
 */
import { WebGLRenderer } from 'three';
import { CLIENT_RULES, createClient, type Client } from '../../client';
import { PICKUPS } from '../../data/pickups';
import { WEAPONS } from '../../data/weapons';
import { LAUNDRY_ROOM } from '../../maps/laundry-room';
import { createMovementConfig } from '../../sim/movement';
import { HitMask } from '../../sim/physics';
import { createWorld, type SimWorld } from '../../sim/world';
import { createDemoShell } from '../shell';
import { allPlaces, type GroundProbe, type Place } from './places';
import { readoutPlugin } from './readout';
import { createToolbar, el } from './sheet';
import { installTeleporter, type Teleporter } from './teleport';
import { mountTeleportSheet } from './teleportSheet';
import { loadTuning, mountTuningSheet, tuningFeedback } from './tuning';
import './walkabout.css';

const found = document.querySelector<HTMLCanvasElement>('#game');
if (!found) throw new Error('laundry-walkabout.html is missing #game');
const canvas: HTMLCanvasElement = found;

export interface WalkaboutDemo {
  readonly client: Client;
  readonly world: SimWorld;
  readonly teleporter: Teleporter;
  readonly places: readonly Place[];
  goTo(place: Place | string): boolean;
}

declare global {
  interface Window {
    /** The running demo, for the console and headless checks. */
    __walkabout?: WalkaboutDemo;
  }
}

const params = new URLSearchParams(location.search);
const movement = createMovementConfig();
loadTuning(movement);
let lastPlace: Place | null = null;

const shell = createDemoShell({
  slug: 'laundry-walkabout',
  tuning: () => ({ ...tuningFeedback(movement), lastTeleport: lastPlace?.id ?? 'none' }),
});

/** A place by id or by the part after the colon (`R4`, `shelf`), case-insensitively. */
export function findPlace(places: readonly Place[], query: string): Place | undefined {
  const q = query.trim().toLowerCase();
  return (
    places.find((p) => p.id.toLowerCase() === q) ??
    places.find((p) => p.id.slice(p.id.indexOf(':') + 1).toLowerCase() === q)
  );
}

async function start(): Promise<WalkaboutDemo> {
  const world = await createWorld(
    { map: LAUNDRY_ROOM, seed: 31, rules: CLIENT_RULES, weapons: WEAPONS, pickups: PICKUPS },
    { movement },
  );
  const teleporter = installTeleporter(world.mover);

  const hint = el(
    'div',
    'lw-hint',
    'Click to play. WASD move · Space jump (again near the top: double jump) · double-tap a direction to dodge · Ctrl crouch · Esc frees the mouse',
  );
  const client = await createClient({
    canvas,
    world,
    mountInputOverlay: (overlay) => shell.setInputOverlay(overlay),
    pixelRatio: () => shell.pixelRatio(),
    shadows: shell.quality.shadows,
    antialias: shell.quality.antialias,
    onLockChange: (locked) => {
      hint.hidden = locked;
    },
  });
  if (client.renderer instanceof WebGLRenderer) shell.trackRenderer(client.renderer);
  if (client.touch) hint.hidden = true;
  document.body.append(hint);

  const ground: GroundProbe = (from, maxDrop) =>
    world.physics.raycast(from, { x: 0, y: -1, z: 0 }, maxDrop, { mask: HitMask.World })?.point ??
    null;
  const places = allPlaces(LAUNDRY_ROOM, ground);

  const goTo = (target: Place | string): boolean => {
    const place = typeof target === 'string' ? findPlace(places, target) : target;
    if (!place) return false;
    lastPlace = place;
    teleporter.request(client.localPawn, place.pose);
    // The controller owns the view; face the way the place faces from the next command on.
    client.player.setView(place.pose.yaw, place.pose.pitch);
    teleportSheet.setCurrent(place);
    return true;
  };

  const bar = createToolbar(document.body);
  const teleportSheet = mountTeleportSheet({ root: document.body, places, onPick: goTo });
  const tuningSheet = mountTuningSheet({ root: document.body, config: movement });
  bar.button('Go to', 'Teleport to a view, a route start or a hazard', () =>
    teleportSheet.sheet.open(),
  );
  bar.button('Tuning', 'Movement tuning (§4)', () => tuningSheet.sheet.open());

  client.use(
    readoutPlugin({
      root: document.body,
      localPawn: client.localPawn,
      movement,
      inWater: (pawn) => world.inWater(pawn),
      touch: client.touch !== null,
    }),
  );

  const at = params.get('at');
  if (at) goTo(at);

  await client.firstFrame;
  return { client, world, teleporter, places, goTo };
}

start()
  .then((demo) => {
    window.__walkabout = demo;
    document.body.dataset.ready = '1';
  })
  .catch((err: unknown) => {
    console.error(err);
    const pre = document.createElement('pre');
    pre.style.cssText =
      'position:fixed;inset:16px;color:#f88;font:14px monospace;white-space:pre-wrap';
    pre.textContent = `Failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;
    document.body.append(pre);
  });
