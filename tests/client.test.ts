import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { createEdgeClient } from '../src/index.js';
import { createCacheApiStore } from '../src/store.js';
import {
  FakeCache,
  FakeCtx,
  asCache,
  callsTo,
  deferred,
  fakeFetch,
  flagsPayload,
  headersOf,
  jsonResponse,
  settle,
  urlOf,
} from './fakes.js';

const KEY = 'sdk_server_k';
const T0 = new Date('2026-10-20T12:00:00.000Z').getTime();
const ctxUser = { userId: 'u' };

let cache: FakeCache;
let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  cache = new FakeCache();
  vi.stubGlobal('caches', { default: asCache(cache) });
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function warnings(): string {
  return warn.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
}

/**
 * A store that settles in microtasks only. The default store's first use awaits
 * `crypto.subtle.digest`, which settles off the fake clock, so a test that
 * advances timers during a first, cold load needs this to be deterministic.
 */
function timerFreeStore() {
  return createCacheApiStore('https://featureflip-edge.invalid/config/test', asCache(new FakeCache()));
}

function versionedFetch(...versions: number[]) {
  let i = 0;
  return fakeFetch({
    flags: async () => jsonResponse(flagsPayload(versions[Math.min(i++, versions.length - 1)])),
  });
}

describe('createEdgeClient load path', () => {
  it('cold load fetches once and serves', async () => {
    const fetch = versionedFetch(1);
    const client = createEdgeClient({ sdkKey: KEY, fetch });
    const snap = await client.load(new FakeCtx());

    const flagCalls = callsTo(fetch, '/v1/sdk/flags');
    expect(flagCalls).toHaveLength(1);
    const [input, init] = flagCalls[0];
    expect(urlOf(input)).toBe('https://eval.featureflip.io/v1/sdk/flags');
    expect(init?.method ?? 'GET').toBe('GET');
    expect(headersOf(init).authorization).toBe(KEY);
    expect(snap.ready).toBe(true);
    expect(snap.version).toBe(1);
    expect(snap.boolVariation('on-flag', ctxUser, false)).toBe(true);
  });

  it('warm load does not fetch', async () => {
    const fetch = versionedFetch(1);
    const client = createEdgeClient({ sdkKey: KEY, fetch });
    await client.load(new FakeCtx());
    vi.setSystemTime(T0 + 59_000);
    const snap = await client.load(new FakeCtx());
    expect(callsTo(fetch, '/v1/sdk/flags')).toHaveLength(1);
    expect(snap.version).toBe(1);
  });

  it('stale load serves immediately and refreshes in waitUntil', async () => {
    const second = deferred<Response>();
    let n = 0;
    const fetch = fakeFetch({
      flags: async () => (n++ === 0 ? jsonResponse(flagsPayload(1)) : second.promise),
    });
    const client = createEdgeClient({ sdkKey: KEY, fetch });
    await client.load(new FakeCtx());

    vi.setSystemTime(T0 + 61_000);
    const ctx = new FakeCtx();
    const stale = await client.load(ctx);
    expect(stale.version).toBe(1);
    expect(callsTo(fetch, '/v1/sdk/flags')).toHaveLength(2);

    second.resolve(jsonResponse(flagsPayload(2)));
    await settle(ctx);
    const fresh = await client.load(new FakeCtx());
    expect(fresh.version).toBe(2);
    expect(callsTo(fetch, '/v1/sdk/flags')).toHaveLength(2);
  });

  it('copy older than maxStaleSeconds is not served', async () => {
    const second = deferred<Response>();
    let n = 0;
    const fetch = fakeFetch({
      flags: async () => (n++ === 0 ? jsonResponse(flagsPayload(1)) : second.promise),
    });
    const client = createEdgeClient({ sdkKey: KEY, fetch });
    await client.load(new FakeCtx());

    vi.setSystemTime(T0 + 86_401_000);
    let result: { version: number | undefined } | undefined;
    const pending = client.load(new FakeCtx()).then((s) => (result = s));
    await vi.advanceTimersByTimeAsync(500);
    expect(result).toBeUndefined();

    second.resolve(jsonResponse(flagsPayload(2)));
    await pending;
    expect(result!.version).toBe(2);
  });

  it('copy older than maxStaleSeconds yields defaults when the fetch times out', async () => {
    let n = 0;
    const fetch = fakeFetch({
      flags: async () => (n++ === 0 ? jsonResponse(flagsPayload(1)) : new Promise<Response>(() => {})),
    });
    const client = createEdgeClient({ sdkKey: KEY, fetch });
    await client.load(new FakeCtx());

    vi.setSystemTime(T0 + 86_401_000);
    const pending = client.load(new FakeCtx());
    await vi.advanceTimersByTimeAsync(1000);
    const snap = await pending;
    expect(snap.ready).toBe(false);
  });

  it('refresh failure keeps stale copy', async () => {
    let n = 0;
    const fetch = fakeFetch({
      flags: async () => {
        if (n++ === 0) return jsonResponse(flagsPayload(1));
        throw new Error('network down');
      },
    });
    const client = createEdgeClient({ sdkKey: KEY, fetch });
    await client.load(new FakeCtx());

    vi.setSystemTime(T0 + 61_000);
    const ctx = new FakeCtx();
    await client.load(ctx);
    await settle(ctx);
    const snap = await client.load(new FakeCtx());
    expect(snap.version).toBe(1);
    expect(snap.ready).toBe(true);
    expect(warnings()).toContain('[featureflip-edge] config refresh failed:');
    expect(warnings()).toContain('network down');
  });

  it.each([401, 403])('%i logs key rejected', async (status) => {
    let n = 0;
    const fetch = fakeFetch({
      flags: async () => (n++ === 0 ? jsonResponse(flagsPayload(1)) : new Response('no', { status })),
    });
    const client = createEdgeClient({ sdkKey: KEY, fetch });
    await client.load(new FakeCtx());

    vi.setSystemTime(T0 + 61_000);
    const ctx = new FakeCtx();
    await client.load(ctx);
    await settle(ctx);
    expect(warnings()).toContain(`[featureflip-edge] SDK key rejected (${status})`);
    expect(warnings()).not.toContain('config refresh failed');
    const snap = await client.load(new FakeCtx());
    expect(snap.version).toBe(1);
  });

  it('a non-2xx refresh other than 401/403 warns refresh failed with the status', async () => {
    let n = 0;
    const fetch = fakeFetch({
      flags: async () => (n++ === 0 ? jsonResponse(flagsPayload(1)) : new Response('x', { status: 503 })),
    });
    const client = createEdgeClient({ sdkKey: KEY, fetch });
    await client.load(new FakeCtx());
    vi.setSystemTime(T0 + 61_000);
    const ctx = new FakeCtx();
    await client.load(ctx);
    await settle(ctx);
    expect(warnings()).toMatch(/config refresh failed:.*503/);
    expect((await client.load(new FakeCtx())).version).toBe(1);
  });

  it('a malformed payload keeps the existing copy and warns', async () => {
    let n = 0;
    const fetch = fakeFetch({
      flags: async () => (n++ === 0 ? jsonResponse(flagsPayload(1)) : jsonResponse({ flags: 'nope' })),
    });
    const client = createEdgeClient({ sdkKey: KEY, fetch });
    await client.load(new FakeCtx());
    vi.setSystemTime(T0 + 61_000);
    const ctx = new FakeCtx();
    await client.load(ctx);
    await settle(ctx);
    expect(warnings()).toContain('config refresh failed:');
    expect((await client.load(new FakeCtx())).version).toBe(1);
  });

  it('cold timeout serves defaults then warms', async () => {
    const fetch = fakeFetch({
      flags: () =>
        new Promise<Response>((resolve) => setTimeout(() => resolve(jsonResponse(flagsPayload(1))), 1500)),
    });
    const client = createEdgeClient({ sdkKey: KEY, fetch, store: timerFreeStore() });
    const ctx = new FakeCtx();
    let result: { ready: boolean } | undefined;
    const pending = client.load(ctx).then((s) => (result = s));

    await vi.advanceTimersByTimeAsync(999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(result!.ready).toBe(false);

    await settle(ctx);
    const snap = await client.load(new FakeCtx());
    expect(snap.ready).toBe(true);
    expect(callsTo(fetch, '/v1/sdk/flags')).toHaveLength(1);
  });

  it('a failed cold fetch serves defaults without throwing', async () => {
    const fetch = fakeFetch({ flags: async () => new Response('no', { status: 401 }) });
    const client = createEdgeClient({ sdkKey: KEY, fetch });
    const snap = await client.load(new FakeCtx());
    expect(snap.ready).toBe(false);
    expect(snap.boolVariation('on-flag', ctxUser, false)).toBe(false);
    expect(warnings()).toContain('SDK key rejected (401)');
  });

  it('concurrent cold loads share one fetch', async () => {
    const origin = deferred<Response>();
    const fetch = fakeFetch({ flags: () => origin.promise });
    const client = createEdgeClient({ sdkKey: KEY, fetch, store: timerFreeStore() });
    let resolved = 0;
    const loads = Array.from({ length: 10 }, () =>
      client.load(new FakeCtx()).then((s) => {
        resolved++;
        return s;
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    // All ten are inside the cold load, each racing its own timeout against the
    // one fetch, before that fetch answers.
    expect(vi.getTimerCount()).toBe(10);
    expect(resolved).toBe(0);
    expect(callsTo(fetch, '/v1/sdk/flags')).toHaveLength(1);

    origin.resolve(jsonResponse(flagsPayload(1)));
    const snaps = await Promise.all(loads);
    expect(callsTo(fetch, '/v1/sdk/flags')).toHaveLength(1);
    expect(snaps.every((s) => s.ready)).toBe(true);
  });

  it.each([401, 403, 503])('a %i config response has its body cancelled', async (status) => {
    const response = new Response('no', { status });
    const cancel = vi.spyOn(response.body!, 'cancel');
    const client = createEdgeClient({ sdkKey: KEY, fetch: fakeFetch({ flags: async () => response }) });
    await client.load(new FakeCtx());
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('fresh isolate reads the Cache API before origin', async () => {
    const fetchA = versionedFetch(1);
    const ctxA = new FakeCtx();
    await createEdgeClient({ sdkKey: KEY, fetch: fetchA }).load(ctxA);
    await settle(ctxA);
    expect(cache.entries.size).toBe(1);

    const fetchB = versionedFetch(2);
    const snap = await createEdgeClient({ sdkKey: KEY, fetch: fetchB }).load(new FakeCtx());
    expect(fetchB).not.toHaveBeenCalled();
    expect(snap.version).toBe(1);
  });

  it('a stale store copy is served and refreshed', async () => {
    const ctxA = new FakeCtx();
    await createEdgeClient({ sdkKey: KEY, fetch: versionedFetch(1) }).load(ctxA);
    await settle(ctxA);

    vi.setSystemTime(T0 + 61_000);
    const fetchB = versionedFetch(2);
    const clientB = createEdgeClient({ sdkKey: KEY, fetch: fetchB });
    const ctxB = new FakeCtx();
    expect((await clientB.load(ctxB)).version).toBe(1);
    await settle(ctxB);
    expect(callsTo(fetchB, '/v1/sdk/flags')).toHaveLength(1);
    expect((await clientB.load(new FakeCtx())).version).toBe(2);
  });

  it('two clients with different keys never share config', async () => {
    const fetch1 = fakeFetch({ flags: async () => jsonResponse(flagsPayload(1, 'on')) });
    const fetch2 = fakeFetch({ flags: async () => jsonResponse(flagsPayload(2, 'off')) });
    const c1 = createEdgeClient({ sdkKey: 'k1', fetch: fetch1 });
    const c2 = createEdgeClient({ sdkKey: 'k2', fetch: fetch2 });
    const ctx = new FakeCtx();
    const s1 = await c1.load(ctx);
    const s2 = await c2.load(ctx);
    await settle(ctx);
    expect(s1.boolVariation('on-flag', ctxUser, false)).toBe(true);
    expect(s2.boolVariation('on-flag', ctxUser, true)).toBe(false);
    expect(cache.entries.size).toBe(2);

    // Fresh isolates for each key read their own entry from the shared cache.
    const f1 = await createEdgeClient({ sdkKey: 'k1', fetch: fetch1 }).load(new FakeCtx());
    const f2 = await createEdgeClient({ sdkKey: 'k2', fetch: fetch2 }).load(new FakeCtx());
    expect(f1.boolVariation('on-flag', ctxUser, false)).toBe(true);
    expect(f2.boolVariation('on-flag', ctxUser, true)).toBe(false);
    expect(callsTo(fetch1, '/v1/sdk/flags')).toHaveLength(1);
    expect(callsTo(fetch2, '/v1/sdk/flags')).toHaveLength(1);
  });

  it('missing sdkKey throws at construction', () => {
    expect(() => createEdgeClient({ sdkKey: '' })).toThrow(/sdkKey/);
    expect(() => createEdgeClient({} as { sdkKey: string })).toThrow(/sdkKey/);
  });

  it('construction does no I/O', () => {
    const fetch = versionedFetch(1);
    createEdgeClient({ sdkKey: KEY, fetch });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('honours baseUrl (trailing slashes stripped), ttlSeconds and an explicit store', async () => {
    const fetch = versionedFetch(1, 2);
    const own = new FakeCache();
    const client = createEdgeClient({
      sdkKey: KEY,
      fetch,
      baseUrl: 'https://flags.example.com//',
      ttlSeconds: 5,
      store: createCacheApiStore('https://featureflip-edge.invalid/config/own', asCache(own)),
    });
    const ctx = new FakeCtx();
    await client.load(ctx);
    await settle(ctx);
    expect(urlOf(callsTo(fetch, '/v1/sdk/flags')[0][0])).toBe('https://flags.example.com/v1/sdk/flags');
    expect(own.entries.size).toBe(1);
    expect(cache.entries.size).toBe(0);

    vi.setSystemTime(T0 + 6_000);
    const ctx2 = new FakeCtx();
    await client.load(ctx2);
    await settle(ctx2);
    expect(callsTo(fetch, '/v1/sdk/flags')).toHaveLength(2);
  });

  it('writes the store with maxStaleSeconds as its lifetime', async () => {
    const ctx = new FakeCtx();
    await createEdgeClient({ sdkKey: KEY, fetch: versionedFetch(1), maxStaleSeconds: 600 }).load(ctx);
    await settle(ctx);
    const [entry] = [...cache.entries.values()];
    expect(entry.headers.get('cache-control')).toBe('max-age=600');
  });

  it('runs memory-only when the cache key cannot be derived', async () => {
    vi.stubGlobal('crypto', {});
    const fetch = versionedFetch(1);
    const client = createEdgeClient({ sdkKey: KEY, fetch });
    const ctx = new FakeCtx();
    const snap = await client.load(ctx);
    await settle(ctx);
    expect(snap.ready).toBe(true);
    expect(cache.entries.size).toBe(0);
    expect(warnings()).toMatch(/\[featureflip-edge\].*memory-only/);
    expect((await client.load(new FakeCtx())).version).toBe(1);
    expect(callsTo(fetch, '/v1/sdk/flags')).toHaveLength(1);
  });

  it('without waitUntil warns once per client and still serves', async () => {
    const fetch = versionedFetch(1);
    const client = createEdgeClient({ sdkKey: KEY, fetch });
    expect((await client.load()).ready).toBe(true);
    await client.load();
    const lines = warn.mock.calls.filter((c) => String(c[0]).includes('running without waitUntil'));
    expect(lines).toHaveLength(1);
    expect(String(lines[0][0])).toContain('[featureflip-edge]');
  });

  it('load never rejects, even when fetch throws synchronously', async () => {
    const fetch = vi.fn(() => {
      throw new Error('sync boom');
    }) as unknown as typeof globalThis.fetch;
    const client = createEdgeClient({ sdkKey: KEY, fetch });
    const snap = await client.load(new FakeCtx());
    expect(snap.ready).toBe(false);
    expect(warnings()).toContain('sync boom');
  });

  it('a stalled in-flight fetch is abandoned after 30s', async () => {
    let n = 0;
    const fetch = fakeFetch({
      flags: async () => (n++ === 0 ? new Promise<Response>(() => {}) : jsonResponse(flagsPayload(1))),
    });
    const client = createEdgeClient({ sdkKey: KEY, fetch, store: timerFreeStore() });
    const first = client.load(new FakeCtx());
    await vi.advanceTimersByTimeAsync(1000);
    expect((await first).ready).toBe(false);

    // The timeout started a backoff: a later load neither waits nor refetches.
    vi.setSystemTime(T0 + 10_000);
    expect((await client.load(new FakeCtx())).ready).toBe(false);
    expect(callsTo(fetch, '/v1/sdk/flags')).toHaveLength(1);

    // Past 30s the fetch is abandoned as a failure, which backs off again.
    vi.setSystemTime(T0 + 31_000);
    expect((await client.load(new FakeCtx())).ready).toBe(false);
    expect(callsTo(fetch, '/v1/sdk/flags')).toHaveLength(1);
    expect(warnings()).toMatch(/config refresh failed:.*did not settle/);

    vi.setSystemTime(T0 + 46_001);
    expect((await client.load(new FakeCtx())).ready).toBe(true);
    expect(callsTo(fetch, '/v1/sdk/flags')).toHaveLength(2);
  });

  describe('failure backoff', () => {
    it('after a cold 401, loads within 15s make no fetch and resolve at once; then it retries', async () => {
      let n = 0;
      const fetch = fakeFetch({
        flags: async () => (n++ === 0 ? new Response('no', { status: 401 }) : jsonResponse(flagsPayload(1))),
      });
      const client = createEdgeClient({ sdkKey: KEY, fetch });
      expect((await client.load(new FakeCtx())).ready).toBe(false);

      vi.setSystemTime(T0 + 14_999);
      let resolved: { ready: boolean } | undefined;
      const pending = client.load(new FakeCtx()).then((s) => (resolved = s));
      // Microtasks only: no timer is allowed to run before it resolves.
      for (let i = 0; i < 50; i++) await Promise.resolve();
      expect(resolved?.ready).toBe(false);
      await pending;
      expect(callsTo(fetch, '/v1/sdk/flags')).toHaveLength(1);

      vi.setSystemTime(T0 + 15_001);
      expect((await client.load(new FakeCtx())).ready).toBe(true);
      expect(callsTo(fetch, '/v1/sdk/flags')).toHaveLength(2);
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('SDK key rejected'))).toHaveLength(1);
    });

    it('a failing refresh backs off and the stale copy keeps serving', async () => {
      let n = 0;
      const fetch = fakeFetch({
        flags: async () => {
          if (n++ === 0) return jsonResponse(flagsPayload(1));
          throw new Error('network down');
        },
      });
      const client = createEdgeClient({ sdkKey: KEY, fetch });
      await client.load(new FakeCtx());

      vi.setSystemTime(T0 + 61_000);
      const ctx = new FakeCtx();
      await client.load(ctx);
      await settle(ctx);
      expect(callsTo(fetch, '/v1/sdk/flags')).toHaveLength(2);

      for (const t of [62_000, 70_000, 75_999]) {
        vi.setSystemTime(T0 + t);
        const c = new FakeCtx();
        expect((await client.load(c)).version).toBe(1);
        await settle(c);
      }
      expect(callsTo(fetch, '/v1/sdk/flags')).toHaveLength(2);
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('config refresh failed'))).toHaveLength(1);

      vi.setSystemTime(T0 + 76_001);
      await client.load(new FakeCtx());
      expect(callsTo(fetch, '/v1/sdk/flags')).toHaveLength(3);
    });

    it('a success clears the backoff', async () => {
      // A cold load that times out backs off; the fetch then lands at 1.5s.
      let n = 0;
      const fetch = fakeFetch({
        flags: () =>
          n++ === 0
            ? new Promise<Response>((r) => setTimeout(() => r(jsonResponse(flagsPayload(1))), 1500))
            : Promise.resolve(jsonResponse(flagsPayload(2))),
      });
      const client = createEdgeClient({ sdkKey: KEY, fetch, ttlSeconds: 1, store: timerFreeStore() });
      const ctx = new FakeCtx();
      const cold = client.load(ctx);
      await vi.advanceTimersByTimeAsync(1000);
      expect((await cold).ready).toBe(false);
      await settle(ctx);

      // Stale at 3s, inside the 15s the timeout started: refreshed all the same.
      vi.setSystemTime(T0 + 3_000);
      const ctx2 = new FakeCtx();
      expect((await client.load(ctx2)).version).toBe(1);
      await settle(ctx2);
      expect(callsTo(fetch, '/v1/sdk/flags')).toHaveLength(2);
      expect((await client.load(new FakeCtx())).version).toBe(2);
    });
  });

  it('the raw SDK key never appears in a URL, cache key or log line', async () => {
    let n = 0;
    const fetch = fakeFetch({
      flags: async () => (n++ === 0 ? jsonResponse(flagsPayload(1)) : new Response('', { status: 401 })),
    });
    const client = createEdgeClient({ sdkKey: KEY, fetch });
    const ctx = new FakeCtx();
    await client.load(ctx);
    vi.setSystemTime(T0 + 61_000);
    await client.load(ctx);
    await client.load();
    await settle(ctx);
    for (const [input] of fetch.mock.calls) expect(urlOf(input)).not.toContain(KEY);
    for (const k of cache.entries.keys()) expect(k).not.toContain(KEY);
    expect(warn).toHaveBeenCalled();
    expect(warnings()).not.toContain(KEY);
  });
});
