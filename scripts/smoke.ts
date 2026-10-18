/**
 * Smoke test: loads the scene demo in headless Chromium and lets the sim run
 * for `--seconds` (default 60) of wall clock (docs/DESIGN.md §18.3).
 *
 *   node scripts/smoke.ts [--seconds 60]
 *
 * Fails on any uncaught page error or console error, if the first frame never
 * renders, or if the render loop stalls (no frames for 5 s).
 */
import { DEMO_PATH, collectPageErrors, parseArgs, startHarness, waitForReady } from './browser.ts';

const seconds = Number(parseArgs(process.argv.slice(2)).get('seconds') ?? 60);
const STALL_MS = 5_000;

const started = Date.now();
const harness = await startHarness();
const failures: string[] = [];
try {
  const page = await harness.browser.newPage({ viewport: { width: 960, height: 540 } });
  const errors = collectPageErrors(page);
  await page.addInitScript(() => {
    const w = window as unknown as { __frames: number };
    w.__frames = 0;
    const count = (): void => {
      w.__frames++;
      requestAnimationFrame(count);
    };
    requestAnimationFrame(count);
  });
  await page.goto(`${harness.baseUrl}${DEMO_PATH}`);
  await waitForReady(page);

  let frames = 0;
  let lastProgress = Date.now();
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 1000));
    const now = await page.evaluate(() => (window as unknown as { __frames: number }).__frames);
    if (now > frames) lastProgress = Date.now();
    else if (Date.now() - lastProgress > STALL_MS) {
      failures.push(`render loop stalled at frame ${now}`);
      break;
    }
    frames = now;
  }
  console.log(`ran ${seconds}s, ${frames} frames`);
  failures.push(...errors);
} catch (err) {
  failures.push(err instanceof Error ? err.message : String(err));
} finally {
  await harness.close();
}

console.log(`wall clock ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (failures.length) {
  console.error(`smoke FAILED:\n${failures.join('\n')}`);
  process.exit(1);
}
console.log('smoke ok');
