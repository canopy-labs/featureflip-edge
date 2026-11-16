import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createEdgeClient } from '../src/index.js';
import { createCacheApiStore } from '../src/store.js';
import { createLogger, redactError } from '../src/log.js';
import { FakeCache, FakeCtx, asCache, fakeFetch, flagsPayload, jsonResponse, settle } from './fakes.js';

// 54 chars, base64url-shaped, like a real key.
const SENTINEL = 'sdk_server_SentinelKeyMustNeverAppearInLogs-0123456789';

/** What a fetch whose error quotes the request headers would throw. */
function leakyTransportError(): Error {
  return new Error(`request failed: GET /v1/sdk headers {"Authorization":"${SENTINEL}"}`);
}

let captured: string[];
const channels = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;

function render(arg: unknown): string {
  if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack ?? ''}`;
  if (typeof arg === 'object' && arg !== null) {
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }
  return String(arg);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));
  vi.stubGlobal('caches', { default: asCache(new FakeCache()) });
  captured = [];
  for (const ch of channels) {
    vi.spyOn(console, ch).mockImplementation((...args: unknown[]) => {
      captured.push(args.map(render).join(' '));
    });
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function expectClean(thrown: string[] = []) {
  expect(captured.join('\n')).not.toContain(SENTINEL);
  expect(thrown.join('\n')).not.toContain(SENTINEL);
}

/** Drives every evaluation path, collecting the message of anything thrown. */
function drive(snap: Awaited<ReturnType<ReturnType<typeof createEdgeClient>['load']>>): string[] {
  const thrown: string[] = [];
  const attempt = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      thrown.push(e instanceof Error ? `${e.message}\n${e.stack}` : String(e));
    }
  };
  const ctx = { userId: 'u' };
  attempt(() => snap.boolVariation('on-flag', ctx, false));
  attempt(() => snap.stringVariation('on-flag', ctx, 'd')); // type mismatch
  attempt(() => snap.boolVariation('no-such-flag', ctx, false)); // unknown flag
  return thrown;
}

describe('SDK key never reaches the log or an exception (#5166)', () => {
  it('200 then a leaky events transport error', async () => {
    const fetch = fakeFetch({
      flags: async () => jsonResponse(flagsPayload(1)),
      events: async () => {
        throw leakyTransportError();
      },
    });
    const client = createEdgeClient({ sdkKey: SENTINEL, fetch });
    const ctx = new FakeCtx();
    const snap = await client.load(ctx);
    const thrown = drive(snap);
    thrown.push(...(await rejections(() => client.flush())));
    await settle(ctx);
    expect(captured.some((l) => l.includes('failed to send'))).toBe(true);
    expectClean(thrown);
  });

  it('events endpoint answering 500', async () => {
    const fetch = fakeFetch({
      flags: async () => jsonResponse(flagsPayload(1)),
      events: async () => new Response(null, { status: 500 }),
    });
    const client = createEdgeClient({ sdkKey: SENTINEL, fetch });
    const ctx = new FakeCtx();
    const snap = await client.load(ctx);
    drive(snap);
    await client.flush();
    await settle(ctx);
    expect(captured.length).toBeGreaterThan(0);
    expectClean();
  });

  it.each([401, 500])('config endpoint answering %i', async (status) => {
    const fetch = fakeFetch({ flags: async () => new Response(null, { status }) });
    const client = createEdgeClient({ sdkKey: SENTINEL, fetch });
    const ctx = new FakeCtx();
    const snap = await client.load(ctx);
    const thrown = drive(snap);
    await settle(ctx);
    expect(captured.length).toBeGreaterThan(0);
    expectClean(thrown);
  });

  it('config transport error that quotes the Authorization header', async () => {
    const fetch = fakeFetch({
      flags: async () => {
        throw leakyTransportError();
      },
    });
    const client = createEdgeClient({ sdkKey: SENTINEL, fetch });
    const ctx = new FakeCtx();
    const snap = await client.load(ctx);
    const thrown = drive(snap);
    await settle(ctx);
    expect(captured.join('\n')).toContain('[redacted]');
    expectClean(thrown);
  });

  it('load without a ctx', async () => {
    const fetch = fakeFetch({ flags: async () => jsonResponse(flagsPayload(1)) });
    const client = createEdgeClient({ sdkKey: SENTINEL, fetch });
    drive(await client.load());
    await client.flush();
    expectClean();
  });

  it('a throwing store', async () => {
    const store = {
      get: async () => {
        throw leakyTransportError();
      },
      put: async () => {
        throw leakyTransportError();
      },
    };
    const fetch = fakeFetch({ flags: async () => jsonResponse(flagsPayload(1)) });
    const client = createEdgeClient({ sdkKey: SENTINEL, fetch, store });
    const ctx = new FakeCtx();
    drive(await client.load(ctx));
    await settle(ctx);
    expect(captured.join('\n')).toContain('[redacted]');
    expectClean();
  });
});

async function rejections(fn: () => Promise<unknown>): Promise<string[]> {
  try {
    await fn();
    return [];
  } catch (e) {
    return [e instanceof Error ? `${e.message}\n${e.stack}` : String(e)];
  }
}

describe('logger redaction (#5167)', () => {
  it('redacts a key inside an error message, stack and cause', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = new Error(`boom ${SENTINEL}`, { cause: new Error(`inner ${SENTINEL}`) });
    createLogger(SENTINEL).warn('prefix', err);
    const [, out] = spy.mock.calls[0] as [string, Error];
    expect(out.message).toBe('boom [redacted]');
    expect(out.stack).not.toContain(SENTINEL);
    expect((out.cause as Error).message).toBe('inner [redacted]');
  });

  it('redacts strings and structured fields', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createLogger(SENTINEL).warn(`key ${SENTINEL}`, { headers: { Authorization: SENTINEL }, n: 1 });
    const [msg, fields] = spy.mock.calls[0];
    expect(msg).toBe('key [redacted]');
    expect(fields).toEqual({ headers: { Authorization: '[redacted]' }, n: 1 });
  });

  it('leaves a short key alone', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = new Error('skipped a malformed flag');
    createLogger('k').warn('skipped a malformed flag', err);
    expect(spy.mock.calls[0]).toEqual(['skipped a malformed flag', err]);
    expect(spy.mock.calls[0][1]).toBe(err);
  });

  it('passes object args through by reference with a short key', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    class Thing { when = new Date(0); m = new Map([[1, 2]]); u = undefined; }
    const thing = new Thing();
    const plain = { thing, u: undefined };
    createLogger('k').warn(thing, plain);
    createLogger('').warn(plain);
    expect(spy.mock.calls[0][0]).toBe(thing);
    expect(spy.mock.calls[0][1]).toBe(plain);
    expect(spy.mock.calls[1][0]).toBe(plain);
  });

  it('keeps clean objects by reference with a real key', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const plain = { a: 1, d: new Date(0) };
    createLogger(SENTINEL).warn(plain);
    expect(spy.mock.calls[0][0]).toBe(plain);
  });

  it('redacts a key held in an own property of a clean-message error', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = Object.assign(new TypeError('request failed'), {
      config: { headers: { Authorization: SENTINEL } },
    });
    createLogger(SENTINEL).warn('x', err);
    const out = spy.mock.calls[0][1] as { message: string; config: { headers: { Authorization: string } } };
    expect(out.message).toBe('request failed');
    expect(out.config.headers.Authorization).toBe('[redacted]');
    expect(err.config.headers.Authorization).toBe(SENTINEL);
  });

  it('walks AggregateError.errors', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = new AggregateError([new Error(`a ${SENTINEL}`), new Error('b')], 'many');
    createLogger(SENTINEL).warn(err);
    const out = spy.mock.calls[0][0] as AggregateError;
    expect(out).toBeInstanceOf(AggregateError);
    expect(out.errors.map((e: Error) => e.message)).toEqual(['a [redacted]', 'b']);
  });

  it('redacts an Error nested in an object', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createLogger(SENTINEL).warn({ err: new Error(`x ${SENTINEL}`) });
    const out = spy.mock.calls[0][0] as { err: Error };
    expect(out.err.message).toBe('x [redacted]');
  });

  it('redacts non-plain objects that hold the key', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    class Holder { constructor(public apiKey: string) {} }
    const log = createLogger(SENTINEL);
    const resp = Object.assign(new Error('bad gateway'), {
      response: { headers: new Headers({ Authorization: SENTINEL }) },
    });
    log.warn(
      new Headers({ Authorization: SENTINEL }),
      new Map([['auth', SENTINEL]]),
      new URL(`https://x.test/a?key=${SENTINEL}`),
      new Holder(SENTINEL),
      resp,
      new Request('https://x.test/', { headers: { Authorization: SENTINEL } }),
    );
    const out = JSON.stringify(spy.mock.calls[0].map(render));
    expect(out).not.toContain(SENTINEL);
    expect(out).toContain('[redacted]');
    const copied = spy.mock.calls[0][4] as { response: { headers: unknown } };
    expect(JSON.stringify(copied.response)).not.toContain(SENTINEL);
    expect(spy.mock.calls[0].map(render).join('')).not.toContain(SENTINEL);
  });

  it('keeps clean non-plain objects by reference', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = new Headers({ a: 'b' });
    const m = new Map([[1, 2]]);
    const u = new URL('https://x.test/');
    createLogger(SENTINEL).warn(h, m, u);
    expect(spy.mock.calls[0]).toEqual([h, m, u]);
    expect(spy.mock.calls[0][0]).toBe(h);
    expect(spy.mock.calls[0][1]).toBe(m);
  });

  it('handles a cause cycle', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = new Error(`loop ${SENTINEL}`);
    (err as { cause?: unknown }).cause = err;
    createLogger(SENTINEL).warn(err);
    const out = spy.mock.calls[0][0] as Error;
    expect(out.message).toBe('loop [redacted]');
    expect(out.cause).toBe(out);
  });

  it('keeps the original error when it is clean', () => {
    const err = new Error('nothing here');
    expect(redactError(err, SENTINEL)).toBe(err);
  });

  it('covers the Cache API store too', async () => {
    const cache = new FakeCache();
    cache.put = async () => {
      throw leakyTransportError();
    };
    const store = createCacheApiStore('k', asCache(cache), createLogger(SENTINEL));
    await store.put({ data: flagsPayload(1), fetchedAt: Date.now() }, 60);
    expect(captured.join('\n')).toContain('[redacted]');
    expectClean();
  });
});
