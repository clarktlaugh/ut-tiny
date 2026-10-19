/**
 * Navmesh cache (docs/DESIGN.md §9): bakes are stored in IndexedDB keyed by a
 * hash of the map geometry, links, volumes, bake config and bake version, so
 * a map is baked once per change rather than on every load.
 */
import type { MapDef } from '../sim/types';
import { bakeNavMesh, type NavMeshData } from './bake';
import { DEFAULT_NAV_CONFIG, NAV_BAKE_VERSION, type NavBakeConfig } from './config';
import { NavMesh } from './navMesh';

export interface NavCache {
  get(key: string): Promise<NavMeshData | undefined>;
  put(key: string, data: NavMeshData): Promise<void>;
}

/** cyrb53: fast 53-bit string hash, returned as hex. */
function hashString(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/** Cache key for `map` baked with `config`. Changes when anything the bake reads changes. */
export function navMapHash(map: MapDef, config: Partial<NavBakeConfig> = {}): string {
  const input = JSON.stringify({
    v: NAV_BAKE_VERSION,
    config: { ...DEFAULT_NAV_CONFIG, ...config },
    brushes: map.brushes.map((b) => [b.shape, b.position, b.size, b.yaw ?? 0]),
    volumes: map.volumes,
    navLinks: map.navLinks,
  });
  return `${map.name}:${hashString(input)}`;
}

export class MemoryNavCache implements NavCache {
  readonly entries = new Map<string, NavMeshData>();
  async get(key: string): Promise<NavMeshData | undefined> {
    return this.entries.get(key);
  }
  async put(key: string, data: NavMeshData): Promise<void> {
    this.entries.set(key, data);
  }
}

const DB_NAME = 'ut-tiny-nav';
const STORE = 'navmesh';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** IndexedDB-backed cache. Typed arrays are stored directly via structured clone. */
export class IndexedDbNavCache implements NavCache {
  private db: Promise<IDBDatabase> | undefined;

  constructor(private readonly factory: IDBFactory | undefined = globalThis.indexedDB) {}

  /** True when IndexedDB exists in this environment. */
  get available(): boolean {
    return this.factory !== undefined;
  }

  private open(): Promise<IDBDatabase> {
    if (!this.factory) return Promise.reject(new Error('IndexedDB unavailable'));
    this.db ??= new Promise((resolve, reject) => {
      const req = this.factory!.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  }

  async get(key: string): Promise<NavMeshData | undefined> {
    const db = await this.open();
    const store = db.transaction(STORE, 'readonly').objectStore(STORE);
    return (await request(store.get(key))) as NavMeshData | undefined;
  }

  async put(key: string, data: NavMeshData): Promise<void> {
    const db = await this.open();
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
    await request(store.put(data, key));
  }
}

export interface LoadNavMeshOptions {
  config?: Partial<NavBakeConfig>;
  /** Defaults to IndexedDB when available; pass `null` to always bake. */
  cache?: NavCache | null;
  /** Clock for `bakeMs`; defaults to `performance.now`. */
  now?: () => number;
}

export interface LoadNavMeshResult {
  mesh: NavMesh;
  fromCache: boolean;
  /** Bake time in ms, 0 on a cache hit. */
  bakeMs: number;
  key: string;
}

function looksValid(d: NavMeshData | undefined): d is NavMeshData {
  return (
    !!d &&
    d.version === NAV_BAKE_VERSION &&
    d.nodeY instanceof Float32Array &&
    d.neighbors instanceof Int32Array &&
    d.neighbors.length === d.nodeY.length * 4 &&
    d.colStart instanceof Int32Array &&
    d.colStart.length === d.width * d.depth + 1
  );
}

/**
 * Cached navmesh for `map`: reads the cache, bakes on a miss and stores the
 * result. Cache failures fall back to baking, so this never throws for I/O.
 */
export async function loadNavMesh(
  map: MapDef,
  options: LoadNavMeshOptions = {},
): Promise<LoadNavMeshResult> {
  const key = navMapHash(map, options.config);
  const now = options.now ?? (() => performance.now());
  let cache: NavCache | null;
  if (options.cache !== undefined) cache = options.cache;
  else {
    const idb = new IndexedDbNavCache();
    cache = idb.available ? idb : null;
  }
  if (cache) {
    try {
      const hit = await cache.get(key);
      if (looksValid(hit)) return { mesh: new NavMesh(hit), fromCache: true, bakeMs: 0, key };
    } catch {
      // Fall through to a fresh bake.
    }
  }
  const t0 = now();
  const data = bakeNavMesh(map, options.config);
  const bakeMs = now() - t0;
  if (cache) {
    try {
      await cache.put(key, data);
    } catch {
      // A failed write only costs a re-bake next time.
    }
  }
  return { mesh: new NavMesh(data), fromCache: false, bakeMs, key };
}
