// The project has no @types/node; Vite runs this file in Node, so this import is safe.
// @ts-expect-error -- untyped Node built-in (no @types/node in devDependencies).
import { execSync } from 'node:child_process';
import { loadEnv, type Plugin, type UserConfig } from 'vite';
import type { InlineConfig } from 'vitest/node';
import { DEMOS } from './src/demos/registry';

/** Build-time environment (Netlify sets `COMMIT_REF` and `CONTEXT`). */
const ENV = loadEnv('production', '.', '');

/** Commit being built: Netlify's `COMMIT_REF`, else `git rev-parse HEAD`, else `dev`. */
function commitSha(): string {
  const fromNetlify = ENV.COMMIT_REF?.trim();
  if (fromNetlify) return fromNetlify;
  try {
    const out: unknown = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] });
    const sha = String(out).trim();
    return /^[0-9a-f]{7,64}$/.test(sha) ? sha : 'dev';
  } catch {
    return 'dev';
  }
}

const COMMIT = commitSha();

/**
 * Writes `/version.json` into the build (and serves it from the dev server) so
 * a reviewer or the preview smoke check can tell which commit a deploy runs.
 */
function versionJson(): Plugin {
  const body = (): string =>
    JSON.stringify(
      {
        commit: COMMIT,
        context: ENV.CONTEXT || 'local',
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n';
  return {
    name: 'ut-tiny:version-json',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: body() });
    },
    configureServer(server) {
      server.middlewares.use('/version.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(body());
      });
    },
  };
}

/** Multi-page build: the root page, the hub and one page per registered demo (paths from the root). */
function pages(): Record<string, string> {
  const input: Record<string, string> = { main: 'index.html', hub: 'demos/index.html' };
  for (const demo of DEMOS) input[`demo-${demo.slug}`] = `demos/${demo.slug}.html`;
  return input;
}

// Not wrapped in vitest's defineConfig: vitest bundles older Vite types that reject
// this Vite's plugins and `rolldownOptions`.
export default {
  define: {
    __DEMO_COMMIT__: JSON.stringify(COMMIT),
  },
  plugins: [versionJson()],
  build: {
    target: 'es2022',
    rolldownOptions: {
      input: pages(),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
  },
} satisfies UserConfig & { test: InlineConfig };
