import { validateSnapshot } from '../../js-sdk/src/core/validate-snapshot.js';
import type { GetFlagsResponse } from '../../js-sdk/src/core/types.js';

export interface StoredConfig {
  data: GetFlagsResponse;
  /** Epoch milliseconds at which `data` was fetched from the evaluation API. */
  fetchedAt: number;
}

export interface ConfigStore {
  /** Never throws: any failure is a miss (and warns). */
  get(): Promise<StoredConfig | undefined>;
  /** Never throws: any failure warns. */
  put(config: StoredConfig, maxStaleSeconds: number): Promise<void>;
}

export const FETCHED_AT_HEADER = 'x-featureflip-fetched-at';

const PREFIX = '[featureflip-edge]';

/**
 * Cache API key for one (base URL, SDK key) pair. The cache namespace is shared
 * across every hostname on the zone, so the hashed SDK key is the only tenant
 * isolation: the key is a SHA-256 of both inputs and the raw key never appears.
 */
export async function configCacheKey(baseUrl: string, sdkKey: string): Promise<string> {
  const bytes = new TextEncoder().encode(baseUrl + '\n' + sdkKey);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  return `https://featureflip-edge.invalid/config/${hex}`;
}

/**
 * The header as epoch ms: a positive integer no later than now, else undefined.
 * `Number('')` is 0, so a bare `Number()` check would pass an empty value, and
 * a time in the future would make the entry look fresh until `max-age` evicts it.
 */
function parseFetchedAt(header: string | null): number | undefined {
  if (header === null || !/^[0-9]+$/.test(header)) return undefined;
  const fetchedAt = Number(header);
  return fetchedAt > 0 && fetchedAt <= Date.now() ? fetchedAt : undefined;
}

let warnedNoCache = false;

const noopStore: ConfigStore = {
  get: async () => undefined,
  put: async () => {},
};

export function createCacheApiStore(cacheKey: string, cache?: Cache): ConfigStore {
  const resolved = cache ?? (globalThis as { caches?: { default?: Cache } }).caches?.default;
  if (!resolved) {
    if (!warnedNoCache) {
      warnedNoCache = true;
      console.warn(`${PREFIX} the Cache API is unavailable here; running memory-only (config is not shared between isolates).`);
    }
    return noopStore;
  }

  return {
    async get() {
      try {
        const res = await resolved.match(cacheKey);
        if (!res) return undefined;
        const fetchedAt = parseFetchedAt(res.headers.get(FETCHED_AT_HEADER));
        if (fetchedAt === undefined) {
          // The body will not be read. Cancelling it releases it now.
          void res.body?.cancel().catch(() => {});
          throw new Error(`cache entry has a missing or invalid ${FETCHED_AT_HEADER} header`);
        }
        const data = (await res.json()) as GetFlagsResponse;
        validateSnapshot(data);
        return { data, fetchedAt };
      } catch (err) {
        console.warn(`${PREFIX} ignoring unreadable cached config:`, err);
        return undefined;
      }
    },

    async put(config, maxStaleSeconds) {
      try {
        await resolved.put(
          cacheKey,
          new Response(JSON.stringify(config.data), {
            headers: {
              'content-type': 'application/json',
              'cache-control': `max-age=${Math.max(0, Math.floor(maxStaleSeconds))}`,
              [FETCHED_AT_HEADER]: String(config.fetchedAt),
            },
          }),
        );
      } catch (err) {
        console.warn(`${PREFIX} failed to write config to the Cache API:`, err);
      }
    },
  };
}
