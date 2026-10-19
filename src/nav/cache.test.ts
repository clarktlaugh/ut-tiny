import { describe, expect, it } from 'vitest';
import { bakeNavMesh, type NavMeshData } from './bake';
import { IndexedDbNavCache, loadNavMesh, MemoryNavCache, navMapHash, type NavCache } from './cache';
import { span, testRoom, v } from './testMaps';

/** Minimal in-memory IDBFactory: one database, object stores as Maps. */
function fakeIndexedDb(): IDBFactory {
  const stores = new Map<string, Map<string, unknown>>();
  const req = <T>(fn: () => T) => {
    const r: { result?: T; error?: unknown; onsuccess?: () => void; onerror?: () => void } = {};
    queueMicrotask(() => {
      r.result = fn();
      r.onsuccess?.();
    });
    return r;
  };
  const db = {
    objectStoreNames: { contains: (n: string) => stores.has(n) },
    createObjectStore: (n: string) => stores.set(n, new Map()),
    transaction: (n: string) => ({
      objectStore: () => ({
        get: (k: string) => req(() => stores.get(n)!.get(k)),
        put: (val: unknown, k: string) => req(() => stores.get(n)!.set(k, structuredClone(val))),
      }),
    }),
  };
  return {
    open: () => {
      const r: Record<string, unknown> = { result: db };
      queueMicrotask(() => {
        (r.onupgradeneeded as (() => void) | undefined)?.();
        (r.onsuccess as () => void)();
      });
      return r;
    },
  } as unknown as IDBFactory;
}

describe('navMapHash', () => {
  it('is stable and changes with geometry, links and config', () => {
    const a = testRoom();
    expect(navMapHash(a)).toBe(navMapHash(testRoom()));
    expect(navMapHash(a)).not.toBe(navMapHash(testRoom([span(v(0, 0, 0), v(1, 1, 1))])));
    expect(navMapHash(a)).not.toBe(
      navMapHash(testRoom([], { navLinks: [{ kind: 'jump', from: v(0, 0, 0), to: v(1, 0, 0) }] })),
    );
    expect(navMapHash(a)).not.toBe(navMapHash(a, { agentRadius: 0.5 }));
    expect(navMapHash(a).startsWith('test-room:')).toBe(true);
  });
});

describe('loadNavMesh', () => {
  it('bakes on a miss and reads the cache afterwards', async () => {
    const cache = new MemoryNavCache();
    const map = testRoom();
    const first = await loadNavMesh(map, { cache });
    expect(first.fromCache).toBe(false);
    expect(cache.entries.has(first.key)).toBe(true);
    const second = await loadNavMesh(map, { cache });
    expect(second.fromCache).toBe(true);
    expect(second.bakeMs).toBe(0);
    expect(second.mesh.nodeCount).toBe(first.mesh.nodeCount);
  });

  it('re-bakes stale or corrupt entries', async () => {
    const cache = new MemoryNavCache();
    const map = testRoom();
    const key = navMapHash(map);
    const stale = { ...bakeNavMesh(map), version: -1 } as NavMeshData;
    cache.entries.set(key, stale);
    expect((await loadNavMesh(map, { cache })).fromCache).toBe(false);
    cache.entries.set(key, {
      ...stale,
      version: bakeNavMesh(map).version,
      neighbors: new Int32Array(1),
    });
    expect((await loadNavMesh(map, { cache })).fromCache).toBe(false);
  });

  it('falls back to baking when the cache throws', async () => {
    const broken: NavCache = {
      get: () => Promise.reject(new Error('boom')),
      put: () => Promise.reject(new Error('boom')),
    };
    const r = await loadNavMesh(testRoom(), { cache: broken });
    expect(r.fromCache).toBe(false);
    expect(r.mesh.nodeCount).toBeGreaterThan(0);
  });

  it('bakes without a cache when IndexedDB is missing (node)', async () => {
    const r = await loadNavMesh(testRoom());
    expect(r.fromCache).toBe(false);
    expect(await loadNavMesh(testRoom(), { cache: null })).toMatchObject({ fromCache: false });
  });

  it('round-trips through IndexedDB', async () => {
    const cache = new IndexedDbNavCache(fakeIndexedDb());
    expect(cache.available).toBe(true);
    const map = testRoom([span(v(2, 0, -10), v(10, 0.4, 10))]);
    await loadNavMesh(map, { cache });
    const hit = await loadNavMesh(map, { cache });
    expect(hit.fromCache).toBe(true);
    expect(hit.mesh.data.nodeY).toBeInstanceOf(Float32Array);
    expect(hit.mesh.findPath(v(-5, 0, 0), v(6, 0.4, 0))).not.toBeNull();
  });
});
