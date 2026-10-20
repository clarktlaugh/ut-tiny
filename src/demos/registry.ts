/**
 * Every demo on the hub (docs/DESIGN.md §18.8). Each entry is built as
 * `demos/<slug>.html`, backed by `src/demos/<slug>/main.ts`; `vite.config.ts`
 * reads this list for the multi-page build, so this file must stay free of
 * browser-only imports.
 */

/** Where a demo stands in review. */
export type DemoStatus =
  /** A component bench for developers; judged as part of a later milestone demo. */
  | 'dev'
  /** Waiting for the user's sign-off on a PR. */
  | 'signoff'
  /** Signed off and merged. */
  | 'approved';

export interface DemoEntry {
  /** URL and folder name: `demos/<slug>.html`, `src/demos/<slug>/`. Lowercase, digits, dashes. */
  readonly slug: string;
  readonly title: string;
  /** Milestone from docs/DESIGN.md §18.8, such as `M2`. */
  readonly milestone: string;
  readonly status: DemoStatus;
  /** Packet (`P15`) or, for work outside a packet, pull request (`#59`) that added or last changed it. */
  readonly packet: string;
  /** When it was added or last changed (YYYY-MM-DD); the hub lists newest first. */
  readonly updated: string;
  /** One line for the hub tile. */
  readonly whatToCheck: string;
  /** Three to five items for the demo's What-to-check card. */
  readonly checklist: readonly string[];
}

export const DEMOS: readonly DemoEntry[] = [
  {
    slug: 'laundry-walkabout',
    title: 'Laundry walkabout',
    milestone: 'M1',
    status: 'signoff',
    packet: 'P31',
    updated: '2026-10-20',
    whatToCheck:
      'The full movement set in the grey-box laundry room: feel, dodge and double jump, every jump pad route, room scale.',
    checklist: [
      'Movement feel: run, jump, crouch and air control; the room reads as a giant laundry room.',
      'Dodge (double-tap a direction, or flick the stick) and double jump (jump again near the top of a jump).',
      'Each jump pad route from the Go-to panel: clothespins to the machine tops, the sink pad, the washer cap to the towel, the dryer corner cap and wall dodge to the shelf.',
      'Hazards and respawn: the iron burns, the sump kills, a drop from a machine top is lethal with the §4 numbers.',
      'Tuning: change the movement numbers in the Tuning panel; Copy feedback includes them.',
    ],
  },
  {
    slug: 'playable',
    title: 'Quick playable (stopgap)',
    milestone: 'M2',
    status: 'dev',
    packet: '#59',
    updated: '2026-10-19',
    whatToCheck: 'Run, jump and shoot target dummies in the laundry room, with FX, HUD and sound.',
    checklist: [
      'Tap or click to start; on desktop the mouse locks for looking.',
      'Move, jump and look around the laundry room, by touch or keyboard and mouse.',
      'Shoot the target dummies: hits show FX, the HUD updates, and they die and respawn.',
      'View model, sound and frame rate all hold up together on a phone.',
    ],
  },
  {
    slug: 'fx',
    title: 'Combat FX',
    milestone: 'M2',
    status: 'dev',
    packet: 'P16',
    updated: '2026-10-19',
    whatToCheck: 'A looping scripted fight: tracers, beams, explosions, gibs, decals and flashes.',
    checklist: [
      'The script loops: assault burst, rocket, shock kill with gibs, rocket salvo, grenade, Redeemer.',
      'Explosions light the room briefly and leave scorch decals on the surfaces they hit.',
      'The shock beam lingers and keeps facing you as the camera moves.',
      'The Redeemer blast flashes the whole screen and fades out.',
      'Frame rate holds during the big explosions on a phone.',
    ],
  },
  {
    slug: 'viewmodel',
    title: 'View model',
    milestone: 'M2',
    status: 'dev',
    packet: 'P15',
    updated: '2026-10-18',
    whatToCheck:
      'The held weapon never clips into walls; bob, sway, recoil and switches feel right.',
    checklist: [
      'Walk up to each test position (chips at the top): the weapon never pokes into the wall.',
      'Tap "Single pass (clips)" (or press N) to compare: that render does poke into walls.',
      'Walking bobs the weapon, looking sways it, strafing rolls it, landing dips it.',
      'Fire and Alt show a muzzle flash and recoil; switching weapons lowers and raises.',
    ],
  },
  {
    slug: 'audio',
    title: 'Sound board',
    milestone: 'M2',
    status: 'dev',
    packet: 'P17',
    updated: '2026-10-18',
    whatToCheck: 'Every placeholder sound plays; positional sounds pan and fade with distance.',
    checklist: [
      'Tap anywhere first so the browser lets audio start.',
      'Every sound button plays something recognisable for its name.',
      'Switch to "world at distance": sounds pan with angle and get quieter further away.',
      'Simulated firefight plays footsteps, rockets, shock hits and a first-blood call.',
      'Volume sliders change their bus right away.',
    ],
  },
  {
    slug: 'scene',
    title: 'Scene view',
    milestone: 'M1',
    status: 'dev',
    packet: 'P10',
    updated: '2026-10-17',
    whatToCheck: 'The laundry sketch renders with lights, shadows and moving pawn capsules.',
    checklist: [
      'The room, brushes and props render with shadows and no flicker.',
      'Three pawn capsules circle smoothly (interpolated between ticks).',
      'Desktop: WASD/QE fly, right-drag looks, [ ] cycles the named cameras, M toggles markers.',
      'Frame rate stays smooth on a phone.',
    ],
  },
];

/** Demos in hub order: newest first (stable for equal dates). */
export function demosNewestFirst(demos: readonly DemoEntry[] = DEMOS): DemoEntry[] {
  return demos
    .map((d, i) => ({ d, i }))
    .sort((a, b) => b.d.updated.localeCompare(a.d.updated) || a.i - b.i)
    .map(({ d }) => d);
}

export function findDemo(slug: string): DemoEntry | undefined {
  return DEMOS.find((d) => d.slug === slug);
}
