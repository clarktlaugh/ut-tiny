import { describe, expect, it } from 'vitest';
import { DEMOS, demosNewestFirst, findDemo, type DemoEntry } from './registry';

/** Page and entry sources, keyed by root-relative path (`/demos/scene.html`). */
const PAGES = import.meta.glob<string>('/demos/*.html', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const ENTRIES = import.meta.glob<string>('/src/demos/*/main.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

describe('demo registry', () => {
  it('has unique, URL-safe slugs', () => {
    const slugs = DEMOS.map((d) => d.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(slugs).not.toContain('index');
  });

  it.each(DEMOS.map((d) => [d.slug, d] as const))('%s is well formed', (_slug, demo) => {
    expect(demo.title.trim()).not.toBe('');
    expect(demo.milestone).toMatch(/^M\d+$/);
    expect(demo.packet).toMatch(/^(P\d+|#\d+)$/);
    expect(['dev', 'signoff', 'approved']).toContain(demo.status);
    expect(demo.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(demo.updated))).toBe(false);
    expect(demo.whatToCheck.trim()).not.toBe('');
    expect(demo.whatToCheck).not.toContain('\n');
    expect(demo.checklist.length).toBeGreaterThanOrEqual(3);
    expect(demo.checklist.length).toBeLessThanOrEqual(5);
  });

  it.each(DEMOS.map((d) => [d.slug]))('%s has a page and an entry module', (slug) => {
    const html = PAGES[`/demos/${slug}.html`];
    const entry = ENTRIES[`/src/demos/${slug}/main.ts`];
    expect(html, `demos/${slug}.html`).toBeTypeOf('string');
    expect(entry, `src/demos/${slug}/main.ts`).toBeTypeOf('string');
    expect(html).toContain(`src="/src/demos/${slug}/main.ts"`);
    // The module must create the shell with its own slug.
    expect(entry).toContain(`slug: '${slug}'`);
  });

  it('registers every demo page in demos/', () => {
    const registered = new Set(DEMOS.map((d) => `/demos/${d.slug}.html`));
    for (const page of Object.keys(PAGES)) {
      if (page !== '/demos/index.html') expect(registered, page).toContain(page);
    }
  });

  it('has the hub page', () => {
    expect(PAGES['/demos/index.html']).toContain('/src/demos/hub/main.ts');
  });

  it('orders newest first, keeping registry order for equal dates', () => {
    const base = DEMOS[0]!;
    const make = (slug: string, updated: string): DemoEntry => ({ ...base, slug, updated });
    const ordered = demosNewestFirst([
      make('a', '2026-01-01'),
      make('b', '2026-03-01'),
      make('c', '2026-01-01'),
      make('d', '2026-02-01'),
    ]);
    expect(ordered.map((d) => d.slug)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('finds demos by slug', () => {
    expect(findDemo('scene')?.title).toBe('Scene view');
    expect(findDemo('nope')).toBeUndefined();
  });
});
