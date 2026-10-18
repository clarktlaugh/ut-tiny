/**
 * Owned-paths check (docs/DESIGN.md §18.1, §18.4).
 *
 * Fails when a packet PR changes files outside the "Owned paths" list of the
 * issue it closes (docs/STATUS.md is always allowed).
 *
 *   node scripts/check-owned-paths.ts              # CI: reads the PR event + GitHub API
 *   node scripts/check-owned-paths.ts --self-test  # runs the fixtures in .github/fixtures/owned-paths
 *
 * CI environment: GITHUB_EVENT_PATH, GITHUB_TOKEN, GITHUB_REPOSITORY, BASE_SHA, HEAD_SHA.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ALWAYS_ALLOWED = ['docs/STATUS.md'];

/** Extract the bullet list under the "## Owned paths" heading of a packet issue body. */
export function parseOwnedPaths(issueBody: string): string[] {
  const lines = issueBody.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^##\s+Owned paths\s*$/i.test(l));
  if (start === -1) return [];
  const paths: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    const m = /^\s*[-*]\s+(.*\S)\s*$/.exec(line);
    if (!m?.[1]) continue;
    const entry = m[1]
      .replace(/<!--.*?-->/g, '')
      .replace(/`/g, '')
      .trim();
    if (entry) paths.push(entry);
  }
  return paths;
}

function normalize(p: string): string {
  return p.replace(/^\.?\//, '').replace(/\/\*{1,2}$/, '/');
}

/** True if `file` is covered by `owned` (exact file, or a directory entry ending in "/"). */
export function isOwned(file: string, owned: string): boolean {
  const o = normalize(owned);
  const f = normalize(file);
  return o.endsWith('/') ? f.startsWith(o) : f === o;
}

/** Changed files that fall outside the owned paths. */
export function findViolations(changedFiles: string[], ownedPaths: string[]): string[] {
  const allowed = [...ownedPaths, ...ALWAYS_ALLOWED];
  return changedFiles.filter((f) => f && !allowed.some((o) => isOwned(f, o)));
}

/** Issue number from a "Closes #N" style reference in a PR body. */
export function linkedIssue(prBody: string): number | undefined {
  const m = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i.exec(prBody);
  return m?.[1] ? Number(m[1]) : undefined;
}

function selfTest(): number {
  const dir = fileURLToPath(new URL('../.github/fixtures/owned-paths/', import.meta.url));
  const read = (name: string) => readFileSync(dir + name, 'utf8');
  const lines = (name: string) => read(name).split('\n').filter(Boolean);
  const owned = parseOwnedPaths(read('issue-body.md'));
  const failures: string[] = [];
  const expect = (label: string, ok: boolean) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
    if (!ok) failures.push(label);
  };
  expect('parses owned paths', owned.join(',') === '.github/,scripts/check-owned-paths.ts');
  expect('in-scope PR passes', findViolations(lines('changed-ok.txt'), owned).length === 0);
  const bad = findViolations(lines('changed-bad.txt'), owned);
  expect('out-of-scope PR fails', bad.join(',') === 'src/sim/types.ts,package.json');
  expect('linkedIssue parses Closes #5', linkedIssue('Closes #5\n') === 5);
  return failures.length ? 1 : 0;
}

async function ghGet(path: string): Promise<unknown> {
  const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${path}: ${res.status}`);
  return res.json();
}

async function ci(): Promise<number> {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8')) as {
    pull_request?: { body?: string | null; head: { ref: string } };
  };
  const pr = event.pull_request;
  if (!pr) throw new Error('Not a pull_request event');
  if (!pr.head.ref.startsWith('packet/')) {
    console.log(`Branch ${pr.head.ref} is not a packet branch; skipping.`);
    return 0;
  }
  const issueNumber = linkedIssue(pr.body ?? '');
  if (issueNumber === undefined) {
    console.error('Packet PR body must contain "Closes #<issue>".');
    return 1;
  }
  const issue = (await ghGet(`/issues/${issueNumber}`)) as { body?: string | null };
  const owned = parseOwnedPaths(issue.body ?? '');
  if (owned.length === 0) {
    console.error(`Issue #${issueNumber} has no "## Owned paths" list.`);
    return 1;
  }
  const changed = execFileSync(
    'git',
    ['diff', '--name-only', `${process.env.BASE_SHA}...${process.env.HEAD_SHA}`],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean);
  const violations = findViolations(changed, owned);
  if (violations.length) {
    console.error(`Files outside the owned paths of issue #${issueNumber} (${owned.join(', ')}):`);
    for (const v of violations) console.error(`  ${v}`);
    return 1;
  }
  console.log(
    `${changed.length} changed file(s), all within owned paths of issue #${issueNumber}.`,
  );
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const run = process.argv.includes('--self-test') ? Promise.resolve(selfTest()) : ci();
  run.then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err);
      process.exit(1);
    },
  );
}
