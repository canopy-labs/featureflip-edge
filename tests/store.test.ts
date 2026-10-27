import { describe, it, expect, vi, afterEach } from 'vitest';
import { configCacheKey, createCacheApiStore, FETCHED_AT_HEADER } from '../src/store.js';
import type { GetFlagsResponse } from '../../js-sdk/src/core/types.js';
import { FakeCache, asCache } from './fakes.js';

const data = { flags: [], segments: [] } as unknown as GetFlagsResponse;
const KEY = 'https://featureflip-edge.invalid/config/' + 'a'.repeat(64);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('configCacheKey', () => {
  it('hashes and never contains the key', async () => {
    const k = await configCacheKey('https://eval.featureflip.io', 'sdk_server_abc');
    expect(k).toMatch(/^https:\/\/featureflip-edge\.invalid\/config\/[0-9a-f]{64}$/);
    expect(k).not.toContain('sdk_server_abc');
    expect(await configCacheKey('https://eval.featureflip.io', 'sdk_server_abc')).toBe(k);
  });

  it('different keys or base URLs give different cache keys', async () => {
    const a = await configCacheKey('https://eval.featureflip.io', 'sdk_server_abc');
    expect(await configCacheKey('https://eval.featureflip.io', 'sdk_server_abd')).not.toBe(a);
    expect(await configCacheKey('https://other.example', 'sdk_server_abc')).not.toBe(a);
  });
});

describe('createCacheApiStore', () => {
  it('put then get round-trips data and fetchedAt', async () => {
    const fake = new FakeCache();
    const store = createCacheApiStore(KEY, asCache(fake));
    await store.put({ data, fetchedAt: 1234 }, 86400);
    expect(fake.entries.get(KEY)!.headers.get('cache-control')).toBe('max-age=86400');
    expect(await store.get()).toEqual({ data, fetchedAt: 1234 });
  });

  it('an entry stops matching once its max-age (maxStaleSeconds) has passed', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      const store = createCacheApiStore(KEY, asCache(new FakeCache()));
      await store.put({ data, fetchedAt: 1_000_000 }, 60);
      vi.setSystemTime(1_059_999);
      expect(await store.get()).toEqual({ data, fetchedAt: 1_000_000 });
      vi.setSystemTime(1_060_000);
      expect(await store.get()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('get on an empty cache is a miss', async () => {
    const store = createCacheApiStore(KEY, asCache(new FakeCache()));
    expect(await store.get()).toBeUndefined();
  });

  it.each([
    ['unparseable body', () => new Response('{not json', { headers: { [FETCHED_AT_HEADER]: '1' } })],
    ['missing header', () => new Response(JSON.stringify(data))],
    ['non-numeric header', () => new Response(JSON.stringify(data), { headers: { [FETCHED_AT_HEADER]: 'x' } })],
    ['empty header', () => new Response(JSON.stringify(data), { headers: { [FETCHED_AT_HEADER]: '' } })],
    ['zero header', () => new Response(JSON.stringify(data), { headers: { [FETCHED_AT_HEADER]: '0' } })],
    ['negative header', () => new Response(JSON.stringify(data), { headers: { [FETCHED_AT_HEADER]: '-5' } })],
    ['fractional header', () => new Response(JSON.stringify(data), { headers: { [FETCHED_AT_HEADER]: '1.5' } })],
    [
      'future header',
      () => new Response(JSON.stringify(data), { headers: { [FETCHED_AT_HEADER]: String(Date.now() + 60_000) } }),
    ],
    [
      'invalid snapshot',
      () => new Response(JSON.stringify({ flags: 'nope', segments: [] }), { headers: { [FETCHED_AT_HEADER]: '1' } }),
    ],
  ])('corrupt cache entry (%s) is a miss and warns', async (_n, make) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fake = new FakeCache();
    fake.entries.set(KEY, make());
    const store = createCacheApiStore(KEY, asCache(fake));
    expect(await store.get()).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('[featureflip-edge]');
  });

  it('a rejected entry has its unread body cancelled', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const entry = new Response(JSON.stringify(data), { headers: { [FETCHED_AT_HEADER]: 'x' } });
    const cache = { match: async () => entry } as unknown as Cache;
    expect(await createCacheApiStore(KEY, cache).get()).toBeUndefined();
    // Cancelling disturbs the body; left unread it would not be.
    expect(entry.bodyUsed).toBe(true);
  });

  it('defaults to caches.default', async () => {
    const fake = new FakeCache();
    vi.stubGlobal('caches', { default: fake });
    const store = createCacheApiStore(KEY);
    await store.put({ data, fetchedAt: 1234 }, 60);
    expect(fake.entries.has(KEY)).toBe(true);
    expect(await store.get()).toEqual({ data, fetchedAt: 1234 });
  });

  it('throwing cache is a miss, and a rejecting put resolves, both warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const boom = {
      match: () => Promise.reject(new Error('match boom')),
      put: () => Promise.reject(new Error('put boom')),
    } as unknown as Cache;
    const store = createCacheApiStore(KEY, boom);
    expect(await store.get()).toBeUndefined();
    await expect(store.put({ data, fetchedAt: 1 }, 60)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).toMatch(/match boom[\s\S]*put boom/);
  });

  // The fake must refuse what the Workers cache refuses, or a store change that
  // only works against the fake would pass here and fail in a Worker. (The
  // store's handling of a rejected put is the "throwing cache" test above.)
  it.each([
    ['a 206', () => new Response('x', { status: 206 })],
    ['a Vary: * response', () => new Response('x', { headers: { vary: 'accept, *' } })],
  ])('the fake cache rejects %s put', async (_n, make) => {
    const fake = new FakeCache();
    await expect(fake.put(KEY, make())).rejects.toThrow(TypeError);
    expect(fake.entries.size).toBe(0);
  });

  it('missing caches global falls back to a no-op store and warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('caches', undefined);
    vi.resetModules();
    const mod = await import('../src/store.js');
    const store = mod.createCacheApiStore(KEY);
    expect(await store.get()).toBeUndefined();
    await expect(store.put({ data, fetchedAt: 1 }, 60)).resolves.toBeUndefined();
    mod.createCacheApiStore(KEY);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/Cache API is unavailable.*memory-only/);
  });
});
