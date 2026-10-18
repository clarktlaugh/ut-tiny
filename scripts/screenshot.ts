/**
 * Writes a PNG per named map camera (docs/DESIGN.md §18.3).
 *
 *   node scripts/screenshot.ts [--out dir] [--camera name[,name]] [--width 1280] [--height 720]
 *
 * Loads the scene demo (frozen at tick 0 when `camera=` is set), waits for
 * the first rendered frame and screenshots the canvas. Camera names come from
 * the demo's map. Output defaults to `$TMPDIR/ut-tiny-screenshots`.
 */
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEMO_PATH, collectPageErrors, parseArgs, startHarness, waitForReady } from './browser.ts';

const args = parseArgs(process.argv.slice(2));
const outDir = resolve(args.get('out') ?? join(tmpdir(), 'ut-tiny-screenshots'));
const width = Number(args.get('width') ?? 1280);
const height = Number(args.get('height') ?? 720);
const only = args.get('camera')?.split(',');

mkdirSync(outDir, { recursive: true });
const harness = await startHarness();
let failed = false;
try {
  const context = await harness.browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();

  // Camera names are read from the same fixture the demo renders.
  await page.goto(`${harness.baseUrl}${DEMO_PATH}`);
  await waitForReady(page);
  const names = await page.evaluate(async () => {
    const mod = await import('/src/render/scene/fixtures/laundrySketch.ts');
    return mod.LAUNDRY_SKETCH.cameras.map((c: { name: string }) => c.name);
  });
  const wanted = only ?? names;
  const unknown = wanted.filter((n) => !names.includes(n));
  if (unknown.length)
    throw new Error(`unknown camera(s) ${unknown.join(', ')}; have ${names.join(', ')}`);

  for (const name of wanted) {
    const errors = collectPageErrors(page);
    await page.goto(`${harness.baseUrl}${DEMO_PATH}?camera=${encodeURIComponent(name)}`);
    await waitForReady(page);
    // Let a few frames settle so shadows and interpolation are stable.
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    );
    const file = join(outDir, `${name}.png`);
    await page.screenshot({ path: file });
    console.log(file);
    if (errors.length) {
      failed = true;
      console.error(`${name}: ${errors.join('; ')}`);
    }
  }
} finally {
  await harness.close();
}
process.exit(failed ? 1 : 0);
