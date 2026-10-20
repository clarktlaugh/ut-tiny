/**
 * Preview smoke check (docs/DESIGN.md §18.8): proves every hub demo plays on
 * a deployed build, on an emulated landscape phone and on desktop.
 *
 *   node scripts/preview-smoke.ts --pr 51 --sha <head sha> [--out dir]
 *   node scripts/preview-smoke.ts --base https://host --sha <sha>
 *   node scripts/preview-smoke.ts --self-test
 *
 * Waits (up to `--wait` minutes, default 15) until `<base>/version.json`
 * serves the head SHA, then loads each demo in `src/demos/registry.ts` once
 * per device. A demo fails on a console error, an uncaught page error, a
 * failed request, a bad HTTP status, `body[data-ready="1"]` never appearing,
 * or a blank frame (the canvas, or the page when there is none, is
 * screenshotted a few seconds after load and must show several distinct
 * colors with real contrast). Only requests to the page's own host count:
 * the Netlify deploy-preview overlay talks to `app.netlify.com`, and its
 * failed requests, bad statuses and console errors are ignored. Screenshots go to `--out`
 * (default `$TMPDIR/ut-tiny-preview-smoke`).
 *
 * `--self-test` runs the same checks against a local fixture server: a good
 * demo must pass, and demos that throw on load, log an error, never become
 * ready or draw a blank canvas must each fail. A third-party host that fails
 * or answers 404 must not fail a demo; a 404 from the demo's own host must.
 */
import { createServer, type Server } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, devices, type Browser, type BrowserContextOptions } from 'playwright-core';
import { parseArgs } from './browser.ts';
import { DEMOS } from '../src/demos/registry.ts';

const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

/** Time after the first frame before the pixels are sampled. */
const SETTLE_MS = 4_000;
const READY_TIMEOUT_MS = 60_000;
const POLL_MS = 15_000;

interface Device {
  readonly name: string;
  readonly options: BrowserContextOptions;
}

const DEVICES: readonly Device[] = [
  {
    name: 'phone',
    // Landscape phone with touch; the Pixel 7 profile, rotated.
    options: { ...devices['Pixel 7 landscape'] },
  },
  { name: 'desktop', options: { viewport: { width: 1280, height: 720 } } },
];

export interface DemoResult {
  readonly slug: string;
  readonly device: string;
  readonly failures: string[];
}

/** Colors and contrast measured from a screenshot. */
export interface FrameStats {
  readonly distinctColors: number;
  readonly lumaStdDev: number;
}

/** A frame is blank when it is one flat color or nearly so. */
export function isBlank(stats: FrameStats): boolean {
  return stats.distinctColors < 8 || stats.lumaStdDev < 3;
}

/** Decode a PNG inside the page and measure it; no image dependency needed. */
async function frameStats(page: import('playwright-core').Page, png: Buffer): Promise<FrameStats> {
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('2d canvas unavailable');
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    const colors = new Set<number>();
    let sum = 0;
    let sumSq = 0;
    let n = 0;
    const step = 4 * 7; // every 7th pixel is plenty
    for (let i = 0; i < data.length; i += step) {
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      colors.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += luma;
      sumSq += luma * luma;
      n++;
    }
    const mean = sum / n;
    return {
      distinctColors: colors.size,
      lumaStdDev: Math.sqrt(Math.max(0, sumSq / n - mean * mean)),
    };
  }, png.toString('base64'));
}

/** True when `url` is served by `host` (a `URL.host`, so port included). */
export function isOwnHost(url: string, host: string): boolean {
  try {
    return new URL(url).host === host;
  } catch {
    return false;
  }
}

/** Load one demo URL on one device and return everything that was wrong. */
export async function checkPage(
  browser: Browser,
  device: Device,
  url: string,
  label: string,
  outDir: string,
): Promise<string[]> {
  const failures: string[] = [];
  const context = await browser.newContext(device.options);
  try {
    const page = await context.newPage();
    // Only the deploy-preview host itself counts; the Netlify overlay's
    // requests (and the console errors they cause) are not part of the demo.
    const host = new URL(url).host;
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const from = msg.location().url;
      if (from && !isOwnHost(from, host)) return;
      errors.push(`console.error: ${msg.text()}`);
    });
    page.on('requestfailed', (req) => {
      if (!isOwnHost(req.url(), host)) return;
      failures.push(`request failed: ${req.url()} (${req.failure()?.errorText ?? 'unknown'})`);
    });
    page.on('response', (res) => {
      if (isOwnHost(res.url(), host)) {
        if (res.status() >= 400) failures.push(`HTTP ${res.status()}: ${res.url()}`);
      }
    });

    const nav = await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
    if (!nav || nav.status() >= 400) failures.push(`HTTP ${nav?.status() ?? 'none'} for ${url}`);

    try {
      await page.waitForFunction(() => document.body.dataset.ready === '1', undefined, {
        timeout: READY_TIMEOUT_MS,
      });
      await page.waitForTimeout(SETTLE_MS);
    } catch {
      failures.push(`never became ready (body[data-ready="1"]) within ${READY_TIMEOUT_MS / 1000}s`);
    }

    // The largest visible canvas when there is one; otherwise the whole page.
    const canvas = await page.evaluateHandle(() => {
      let best: HTMLCanvasElement | null = null;
      for (const c of document.querySelectorAll('canvas')) {
        const box = c.getBoundingClientRect();
        const shown =
          box.width > 1 && box.height > 1 && getComputedStyle(c).visibility !== 'hidden';
        if (shown && (!best || c.width * c.height > best.width * best.height)) best = c;
      }
      return best;
    });
    const element = canvas.asElement();
    const png = element ? await element.screenshot() : await page.screenshot();
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `${label}.png`), png);
    const stats = await frameStats(page, png);
    if (isBlank(stats)) {
      failures.push(
        `blank frame (${stats.distinctColors} colors, luma stddev ${stats.lumaStdDev.toFixed(1)})`,
      );
    }

    failures.push(...errors);
  } catch (err) {
    failures.push(err instanceof Error ? err.message : String(err));
  } finally {
    await context.close();
  }
  return [...new Set(failures)];
}

/** Poll `<base>/version.json` until it serves `sha`. */
async function waitForDeploy(base: string, sha: string, minutes: number): Promise<void> {
  const deadline = Date.now() + minutes * 60_000;
  let last: string;
  for (;;) {
    try {
      const res = await fetch(`${base}/version.json?t=${Date.now()}`, {
        headers: { 'Cache-Control': 'no-cache' },
      });
      if (res.ok) {
        const body = (await res.json()) as { commit?: string };
        last = `serving ${body.commit ?? 'unknown commit'}`;
        if (body.commit === sha) return;
      } else {
        last = `HTTP ${res.status}`;
      }
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() > deadline) {
      throw new Error(`${base}/version.json never served ${sha} within ${minutes} min (${last})`);
    }
    console.log(`waiting for deploy: ${last}`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

async function runSlugs(
  browser: Browser,
  base: string,
  slugs: readonly string[],
  outDir: string,
): Promise<DemoResult[]> {
  const results: DemoResult[] = [];
  for (const slug of slugs) {
    for (const device of DEVICES) {
      // card=0 so the What-to-check card does not cover the frame.
      const url = `${base}/demos/${slug}.html?card=0`;
      const failures = await checkPage(browser, device, url, `${slug}-${device.name}`, outDir);
      results.push({ slug, device: device.name, failures });
      console.log(`${failures.length ? 'FAIL' : 'ok  '} ${slug} (${device.name})`);
      for (const f of failures) console.log(`       ${f}`);
    }
  }
  return results;
}

// --- Self-test -----------------------------------------------------------------

const FIXTURES: Record<string, { html: string; expectFail: boolean }> = {
  good: {
    expectFail: false,
    html: `<canvas id=c width=320 height=180></canvas><script>
      const g=document.getElementById('c').getContext('2d');
      for(let i=0;i<24;i++){g.fillStyle='hsl('+i*15+',70%,'+(20+i*2)+'%)';g.fillRect(i*13,(i%5)*30,13,60);}
      document.body.dataset.ready='1';</script>`,
  },
  throws: {
    expectFail: true,
    html: `<canvas id=c width=320 height=180></canvas><script>
      document.body.dataset.ready='1'; throw new Error('boom on load');</script>`,
  },
  'console-error': {
    expectFail: true,
    html: `<canvas id=c width=320 height=180></canvas><script>
      const g=document.getElementById('c').getContext('2d');
      for(let i=0;i<24;i++){g.fillStyle='hsl('+i*15+',70%,50%)';g.fillRect(i*13,0,13,180);}
      console.error('fixture console error'); document.body.dataset.ready='1';</script>`,
  },
  blank: {
    expectFail: true,
    html: `<canvas id=c width=320 height=180></canvas><script>
      const g=document.getElementById('c').getContext('2d'); g.fillStyle='#000'; g.fillRect(0,0,320,180);
      document.body.dataset.ready='1';</script>`,
  },
  'never-ready': {
    expectFail: true,
    html: `<canvas id=c width=320 height=180></canvas><script>
      const g=document.getElementById('c').getContext('2d');
      for(let i=0;i<24;i++){g.fillStyle='hsl('+i*15+',70%,50%)';g.fillRect(i*13,0,13,180);}</script>`,
  },
  // Stands in for the Netlify overlay: a request to another host that 404s,
  // one that is refused, and a console error raised by a script from there.
  'third-party': {
    expectFail: false,
    html: `<canvas id=c width=320 height=180></canvas><script>
      const g=document.getElementById('c').getContext('2d');
      for(let i=0;i<24;i++){g.fillStyle='hsl('+i*15+',70%,'+(20+i*2)+'%)';g.fillRect(i*13,(i%5)*30,13,60);}
      document.body.dataset.ready='1';</script>
      <img src="__OTHER__/overlay.png"><img src="http://127.0.0.1:1/refused.png">
      <script src="__OTHER__/overlay.js"></script>`,
  },
  // A 404 from the demo's own host must still fail.
  'missing-asset': {
    expectFail: true,
    html: `<canvas id=c width=320 height=180></canvas><script>
      const g=document.getElementById('c').getContext('2d');
      for(let i=0;i<24;i++){g.fillStyle='hsl('+i*15+',70%,50%)';g.fillRect(i*13,0,13,180);}
      document.body.dataset.ready='1';</script><img src="/nope.png">`,
  },
};

/** A second host that 404s everything except a script that logs a console error. */
function startOtherServer(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/overlay.js')) {
      res.setHeader('Content-Type', 'text/javascript');
      res.end("console.error('fixture third-party console error');");
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  return new Promise((resolveListen) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolveListen({ server, base: `http://localhost:${port}` });
    });
  });
}

function startFixtureServer(
  sha: string,
  otherBase: string,
): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    if (path === '/version.json') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ commit: sha }));
      return;
    }
    const m = /^\/demos\/(.+)\.html$/.exec(path);
    const fixture = m ? FIXTURES[m[1]!] : undefined;
    if (!fixture) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(
      `<!doctype html><meta charset=utf-8><body>${fixture.html.replaceAll('__OTHER__', otherBase)}</body>`,
    );
  });
  return new Promise((resolveListen) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolveListen({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

async function selfTest(browser: Browser, outDir: string): Promise<boolean> {
  const sha = 'f'.repeat(40);
  const other = await startOtherServer();
  const { server, base } = await startFixtureServer(sha, other.base);
  let ok = true;
  try {
    await waitForDeploy(base, sha, 1);
    const results = await runSlugs(browser, base, Object.keys(FIXTURES), outDir);
    for (const r of results) {
      const expectFail = FIXTURES[r.slug]!.expectFail;
      if (expectFail !== r.failures.length > 0) {
        ok = false;
        console.error(
          `self-test: ${r.slug} (${r.device}) ${expectFail ? 'should have failed but passed' : 'should have passed'}`,
        );
      }
    }
    // The wait must time out against the wrong SHA.
    const timedOut = await waitForDeploy(base, 'a'.repeat(40), 0).then(
      () => false,
      () => true,
    );
    if (!timedOut) {
      ok = false;
      console.error('self-test: waitForDeploy accepted the wrong SHA');
    }
  } finally {
    server.close();
    other.server.close();
  }
  return ok;
}

// --- Main ----------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const outDir = resolve(args.get('out') ?? join(tmpdir(), 'ut-tiny-preview-smoke'));
const browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS });
let failed: boolean;
try {
  if (args.has('self-test')) {
    failed = !(await selfTest(browser, join(outDir, 'self-test')));
    console.log(failed ? 'preview-smoke self-test FAILED' : 'preview-smoke self-test ok');
  } else {
    const sha = args.get('sha');
    const pr = args.get('pr');
    const base = (
      args.get('base') ?? (pr ? `https://deploy-preview-${pr}--tinyut.netlify.app` : '')
    ).replace(/\/$/, '');
    if (!base || !sha) throw new Error('usage: preview-smoke.ts (--pr N | --base URL) --sha SHA');
    await waitForDeploy(base, sha, Number(args.get('wait') ?? 15));
    const only = args.get('demo')?.split(',');
    const slugs = DEMOS.map((d) => d.slug).filter((s) => !only || only.includes(s));
    const results = await runSlugs(browser, base, slugs, outDir);
    failed = results.some((r) => r.failures.length > 0);
    console.log(failed ? 'preview-smoke FAILED' : 'preview-smoke ok');
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  failed = true;
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
