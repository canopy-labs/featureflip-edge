import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createEdgeClient } from '../src/index.js';
import type { RecordEventsRequest } from '../../js-sdk/src/core/types.js';
import {
  FakeCtx,
  callsTo,
  fakeFetch,
  flagsPayload,
  headersOf,
  jsonResponse,
  settle,
  urlOf,
  deferred,
} from './fakes.js';

const T0 = new Date('2026-10-20T12:00:00.000Z').getTime();
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function bodies(fetch: ReturnType<typeof fakeFetch>): RecordEventsRequest[] {
  return callsTo(fetch, '/v1/sdk/events').map(([, init]) => JSON.parse(String(init?.body)));
}

describe('evaluation events', () => {
  it('variation calls flush as Evaluation events via waitUntil', async () => {
    const fetch = fakeFetch({ flags: async () => jsonResponse(flagsPayload(1)) });
    const client = createEdgeClient({ sdkKey: 'sdk_server_k', fetch });
    const ctx = new FakeCtx();
    const snap = await client.load(ctx);
    expect(snap.boolVariation('on-flag', { userId: 'u' }, false)).toBe(true);
    await settle(ctx);

    const posts = callsTo(fetch, '/v1/sdk/events');
    expect(posts).toHaveLength(1);
    const [input, init] = posts[0];
    expect(urlOf(input)).toBe('https://eval.featureflip.io/v1/sdk/events');
    expect(init?.method).toBe('POST');
    const headers = headersOf(init);
    expect(headers.authorization).toBe('sdk_server_k');
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-featureflip-sdk']).toBe(headersOf(callsTo(fetch, '/v1/sdk/flags')[0][1])['x-featureflip-sdk']);

    const [body] = bodies(fetch);
    expect(body).toEqual({
      events: [
        {
          type: 'Evaluation',
          flagKey: 'on-flag',
          userId: 'u',
          variation: 'on',
          timestamp: new Date(T0).toISOString(),
        },
      ],
    });
    expect(body.events[0]).not.toHaveProperty('prerequisiteKey');
  });

  it('resolves user_id as well as userId, and omits userId for an anonymous context', async () => {
    const fetch = fakeFetch({ flags: async () => jsonResponse(flagsPayload(1)) });
    const client = createEdgeClient({ sdkKey: 'sdk_server_k', fetch });
    const ctx = new FakeCtx();
    const snap = await client.load(ctx);
    snap.boolVariation('on-flag', { user_id: 'snake' }, false);
    snap.boolVariation('on-flag', {}, false);
    await settle(ctx);
    const [{ events }] = bodies(fetch);
    expect(events[0].userId).toBe('snake');
    expect(events[1]).not.toHaveProperty('userId');
  });

  it('prerequisite failure carries prerequisiteKey', async () => {
    const fetch = fakeFetch({ flags: async () => jsonResponse(flagsPayload(1)) });
    const client = createEdgeClient({ sdkKey: 'sdk_server_k', fetch });
    const ctx = new FakeCtx();
    const snap = await client.load(ctx);
    expect(snap.variationDetail('gated', { userId: 'u' }, true).reason).toBe('PrerequisiteFailed');
    await settle(ctx);
    const [{ events }] = bodies(fetch);
    expect(events).toEqual([
      {
        type: 'Evaluation',
        flagKey: 'gated',
        userId: 'u',
        variation: 'off',
        timestamp: new Date(T0).toISOString(),
        prerequisiteKey: 'server-only',
      },
    ]);
  });

  it('bootstrapValues records nothing', async () => {
    const fetch = fakeFetch({ flags: async () => jsonResponse(flagsPayload(1)) });
    const client = createEdgeClient({ sdkKey: 'sdk_server_k', fetch });
    const ctx = new FakeCtx();
    (await client.load(ctx)).bootstrapValues({ userId: 'u' });
    await settle(ctx);
    expect(callsTo(fetch, '/v1/sdk/events')).toHaveLength(0);
  });

  it('retryable failure requeues for the first flush after the backoff', async () => {
    let posts = 0;
    const fetch = fakeFetch({
      flags: async () => jsonResponse(flagsPayload(1)),
      events: async () => new Response(null, { status: posts++ === 0 ? 503 : 202 }),
    });
    const client = createEdgeClient({ sdkKey: 'sdk_server_k', fetch });
    const ctx = new FakeCtx();
    (await client.load(ctx)).boolVariation('on-flag', { userId: 'u' }, false);
    await settle(ctx);
    expect(callsTo(fetch, '/v1/sdk/events')).toHaveLength(1);
    expect(warn.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).toMatch(
      /\[featureflip-edge\].*event.*503/,
    );

    vi.setSystemTime(T0 + 30_000);
    await client.flush();
    const all = bodies(fetch);
    expect(all).toHaveLength(2);
    expect(all[1]).toEqual(all[0]);
    expect(all[1].events).toHaveLength(1);

    await client.flush();
    expect(callsTo(fetch, '/v1/sdk/events')).toHaveLength(2);
  });

  it('events recorded on a later request go out with that request, once the interval has passed', async () => {
    const fetch = fakeFetch({ flags: async () => jsonResponse(flagsPayload(1)) });
    const client = createEdgeClient({ sdkKey: 'sdk_server_k', fetch });
    for (const [i, user] of ['a', 'b'].entries()) {
      vi.setSystemTime(T0 + i * 10_000);
      const ctx = new FakeCtx();
      (await client.load(ctx)).boolVariation('on-flag', { userId: user }, false);
      await settle(ctx);
    }
    expect(bodies(fetch).map((b) => b.events.map((e) => e.userId))).toEqual([['a'], ['b']]);
  });

  it.each([
    ['cold fetch', 'fetch'],
    ['store read', 'store'],
  ] as const)(
    'a %s that settles on a timer still flushes the events of its own request',
    async (_name, slow) => {
      const later = <T>(value: T) => new Promise<T>((r) => setTimeout(() => r(value), 5));
      const stored = { data: flagsPayload(1), fetchedAt: T0 };
      const fetch = fakeFetch({ flags: () => later(jsonResponse(flagsPayload(1))) });
      const client = createEdgeClient({
        sdkKey: 'sdk_server_k',
        fetch,
        store: {
          get: () => (slow === 'store' ? later(stored) : Promise.resolve(undefined)),
          put: async () => {},
        },
      });
      const ctx = new FakeCtx();
      const pending = client.load(ctx);
      await vi.advanceTimersByTimeAsync(5);
      const snap = await pending;
      expect(snap.ready).toBe(true);
      snap.boolVariation('on-flag', { userId: 'u' }, false);
      await settle(ctx);
      expect(bodies(fetch).flatMap((b) => b.events.map((e) => e.flagKey))).toEqual(['on-flag']);
    },
  );

  it('a full batch is never sent outside a flush the caller can wait on', async () => {
    const fetch = fakeFetch({ flags: async () => jsonResponse(flagsPayload(1)) });
    const client = createEdgeClient({ sdkKey: 'sdk_server_k', fetch, flushBatchSize: 2 });
    const snap = await client.load();
    for (const user of ['a', 'b', 'c']) snap.boolVariation('on-flag', { userId: user }, false);
    await vi.runAllTimersAsync();
    expect(callsTo(fetch, '/v1/sdk/events')).toHaveLength(0);

    await client.flush();
    expect(bodies(fetch).map((b) => b.events.map((e) => e.userId))).toEqual([['a', 'b'], ['c']]);
  });

  it.each([202, 429, 400])('the events response body is cancelled on a %i', async (status) => {
    const response = new Response('{"accepted":1}', { status });
    const cancel = vi.spyOn(response.body!, 'cancel');
    const fetch = fakeFetch({
      flags: async () => jsonResponse(flagsPayload(1)),
      events: async () => response,
    });
    const client = createEdgeClient({ sdkKey: 'sdk_server_k', fetch });
    (await client.load()).boolVariation('on-flag', { userId: 'u' }, false);
    await client.flush();
    expect(callsTo(fetch, '/v1/sdk/events')).toHaveLength(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('flush never rejects, even when fetch throws', async () => {
    const fetch = fakeFetch({
      flags: async () => jsonResponse(flagsPayload(1)),
      events: async () => {
        throw new Error('events down');
      },
    });
    const client = createEdgeClient({ sdkKey: 'sdk_server_k', fetch });
    (await client.load()).boolVariation('on-flag', { userId: 'u' }, false);
    await expect(client.flush()).resolves.toBeUndefined();
    expect(warn.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).toContain('events down');
  });
});

describe('event delivery throttling', () => {
  const FLUSH_INTERVAL_MS = 10_000;
  const RETRY_BACKOFF_MS = 30_000;

  /** One request: load with its own ctx, record one evaluation, let its waitUntil work run. */
  async function request(client: ReturnType<typeof createEdgeClient>, user: string): Promise<void> {
    const ctx = new FakeCtx();
    (await client.load(ctx)).boolVariation('on-flag', { userId: user }, false);
    await settle(ctx);
  }

  const users = (fetch: ReturnType<typeof fakeFetch>) =>
    bodies(fetch).map((b) => b.events.map((e) => e.userId));

  it('coalesces per-request flushes: loads within 10 s send once', async () => {
    const fetch = fakeFetch({ flags: async () => jsonResponse(flagsPayload(1)) });
    const client = createEdgeClient({ sdkKey: 'sdk_server_k', fetch });
    for (const [i, user] of ['a', 'b', 'c', 'd', 'e'].entries()) {
      vi.setSystemTime(T0 + i * 2_000);
      await request(client, user);
    }
    // Five requests across 8 s: only the first one's flush sent.
    expect(users(fetch)).toEqual([['a']]);

    // The first request past the interval sends everything held since.
    vi.setSystemTime(T0 + FLUSH_INTERVAL_MS);
    await request(client, 'f');
    expect(users(fetch)).toEqual([['a'], ['b', 'c', 'd', 'e', 'f']]);
  });

  it('a per-request flush sends early once a batch is full', async () => {
    const fetch = fakeFetch({ flags: async () => jsonResponse(flagsPayload(1)) });
    const client = createEdgeClient({ sdkKey: 'sdk_server_k', fetch, flushBatchSize: 3 });
    await request(client, 'a');
    vi.setSystemTime(T0 + 1_000);
    await request(client, 'b');
    vi.setSystemTime(T0 + 2_000);
    await request(client, 'c');
    expect(callsTo(fetch, '/v1/sdk/events')).toHaveLength(1);
    vi.setSystemTime(T0 + 3_000);
    await request(client, 'd');
    expect(users(fetch)).toEqual([['a'], ['b', 'c', 'd']]);
  });

  it('after a 429, flushes inside the backoff window make no POST', async () => {
    const fetch = fakeFetch({
      flags: async () => jsonResponse(flagsPayload(1)),
      events: async () => new Response(null, { status: 429 }),
    });
    const client = createEdgeClient({ sdkKey: 'sdk_server_k', fetch });
    await request(client, 'a');
    expect(callsTo(fetch, '/v1/sdk/events')).toHaveLength(1);
    const warnsAfterFirst = warn.mock.calls.length;

    for (const offset of [1, 10_000, 20_000, RETRY_BACKOFF_MS - 1]) {
      vi.setSystemTime(T0 + offset);
      await request(client, `u${offset}`);
      await client.flush();
    }
    expect(callsTo(fetch, '/v1/sdk/events')).toHaveLength(1);
    // Nothing sent, so nothing new to warn about either.
    expect(warn.mock.calls.length).toBe(warnsAfterFirst);

    vi.setSystemTime(T0 + RETRY_BACKOFF_MS);
    await client.flush();
    expect(callsTo(fetch, '/v1/sdk/events')).toHaveLength(2);
    // The requeued batch goes first, ahead of the events recorded meanwhile.
    expect(users(fetch)[1]).toEqual(['a', 'u1', 'u10000', 'u20000', 'u29999']);
  });

  it('a network error backs off explicit and per-request flushes alike', async () => {
    const fetch = fakeFetch({
      flags: async () => jsonResponse(flagsPayload(1)),
      events: async () => {
        throw new TypeError('network down');
      },
    });
    const client = createEdgeClient({ sdkKey: 'sdk_server_k', fetch });
    await request(client, 'a');
    vi.setSystemTime(T0 + 15_000);
    await request(client, 'b');
    await client.flush();
    expect(callsTo(fetch, '/v1/sdk/events')).toHaveLength(1);
  });

  it('a flush sends at most 5 batches; the rest wait for later flushes', async () => {
    const fetch = fakeFetch({ flags: async () => jsonResponse(flagsPayload(1)) });
    const client = createEdgeClient({ sdkKey: 'sdk_server_k', fetch, flushBatchSize: 2 });
    const snap = await client.load();
    for (let i = 0; i < 13; i++) snap.boolVariation('on-flag', { userId: `u${i}` }, false);

    await client.flush();
    expect(callsTo(fetch, '/v1/sdk/events')).toHaveLength(5);
    expect(users(fetch).flat()).toEqual(Array.from({ length: 10 }, (_, i) => `u${i}`));

    await client.flush();
    expect(callsTo(fetch, '/v1/sdk/events')).toHaveLength(7);
    expect(users(fetch).slice(5).flat()).toEqual(['u10', 'u11', 'u12']);
  });

  it('a stalled POST is abandoned after 30 s and a later flush still sends, exactly once', async () => {
    const hung = deferred<Response>();
    let posts = 0;
    const fetch = fakeFetch({
      flags: async () => jsonResponse(flagsPayload(1)),
      events: () =>
        posts++ === 0 ? hung.promise : Promise.resolve(new Response(null, { status: 202 })),
    });
    const client = createEdgeClient({ sdkKey: 'sdk_server_k', fetch });
    const ctx = new FakeCtx();
    const snap = await client.load(ctx);
    snap.boolVariation('on-flag', { userId: 'a' }, false);
    // Runs the per-request flush; its POST never settles.
    await vi.advanceTimersByTimeAsync(0);
    expect(callsTo(fetch, '/v1/sdk/events')).toHaveLength(1);
    // A flush with nothing queued while the POST hangs changes nothing.
    vi.setSystemTime(T0 + 5_000);
    await client.flush();

    vi.setSystemTime(T0 + 30_001);
    snap.boolVariation('on-flag', { userId: 'b' }, false);
    let flushed = false;
    void client.flush().then(() => {
      flushed = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(flushed).toBe(true);
    // The abandoned batch was requeued once, ahead of the new event.
    expect(users(fetch)).toEqual([['a'], ['a', 'b']]);
    // The request that started the hung flush is released too.
    await Promise.all(ctx.promises);
    expect(warn.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).toMatch(
      /\[featureflip-edge\].*events.*30000ms/,
    );

    // The hung POST settling late neither re-sends nor re-queues its batch.
    hung.resolve(new Response(null, { status: 503 }));
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(T0 + 45_000);
    snap.boolVariation('on-flag', { userId: 'c' }, false);
    await client.flush();
    expect(users(fetch)).toEqual([['a'], ['a', 'b'], ['c']]);
  });

  it('an explicit flush sends below the batch size, outside backoff', async () => {
    const fetch = fakeFetch({ flags: async () => jsonResponse(flagsPayload(1)) });
    const client = createEdgeClient({ sdkKey: 'sdk_server_k', fetch });
    await request(client, 'a');
    vi.setSystemTime(T0 + 1_000);
    const snap = await client.load();
    snap.boolVariation('on-flag', { userId: 'b' }, false);
    await client.flush();
    expect(users(fetch)).toEqual([['a'], ['b']]);
  });
});
