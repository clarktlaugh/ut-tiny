/**
 * Shared helpers for the Playwright scripts (screenshot.ts, smoke.ts).
 *
 * Playwright lives in scripts/package.json, apart from the game's
 * dependencies; install it with `npm ci --prefix scripts`. Chromium is found
 * through PLAYWRIGHT_BROWSERS_PATH, or fetched with
 * `npx --prefix scripts playwright-core install chromium`.
 */
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';

export const DEMO_PATH = '/src/render/scene/demo.html';
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Software WebGL so headless runners without a GPU can render. */
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

export interface Harness {
  browser: Browser;
  baseUrl: string;
  close(): Promise<void>;
}

/** Start a Vite dev server on a free port and a headless Chromium. */
export async function startHarness(): Promise<Harness> {
  const server: ViteDevServer = await createServer({
    root: ROOT,
    logLevel: 'warn',
    server: { port: 0, strictPort: false, host: '127.0.0.1' },
  });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (!url) {
    await server.close();
    throw new Error('vite did not report a local URL');
  }
  let browser: Browser;
  try {
    browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS });
  } catch (err) {
    await server.close();
    throw err;
  }
  return {
    browser,
    baseUrl: url.replace(/\/$/, ''),
    async close() {
      await browser.close();
      await server.close();
    },
  };
}

/** Errors the page reported: uncaught exceptions and console errors. */
export function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  return errors;
}

/** Wait for the demo's first rendered frame (`body[data-ready="1"]`). */
export async function waitForReady(page: Page, timeoutMs = 30_000): Promise<void> {
  await page.waitForFunction(() => document.body.dataset.ready === '1', undefined, {
    timeout: timeoutMs,
  });
}

/** Parse `--name value` / `--name=value` options. */
export function parseArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg?.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) out.set(arg.slice(2, eq), arg.slice(eq + 1));
    else out.set(arg.slice(2), argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[++i]! : '1');
  }
  return out;
}
