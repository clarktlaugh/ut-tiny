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
  /** Packet that added or last changed the demo, such as `P15`. */
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
