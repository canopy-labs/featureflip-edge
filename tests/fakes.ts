import { vi } from 'vitest';
import type { FlagDto, GetFlagsResponse } from '../../js-sdk/src/core/types.js';

/**
 * In-memory stand-in for the Workers Cache API. Like the real one it clones on
 * put and on match, rejects a put of a 206 or a `Vary: *` response, and stops
 * matching an entry once its `max-age` has passed (read from `Date.now()`, so
 * fake timers drive it). An entry put without a `max-age` never expires here.
 */
export class FakeCache {
  readonly entries = new Map<string, Response>();
  /** Epoch ms after which each entry no longer matches. */
  private readonly expiresAt = new Map<string, number>();

  private keyOf(req: RequestInfo | URL): string {
    return typeof req === 'string' ? req : req instanceof URL ? req.href : (req as Request).url;
  }

  async match(req: RequestInfo | URL): Promise<Response | undefined> {
    const key = this.keyOf(req);
    const expiresAt = this.expiresAt.get(key);
    if (expiresAt !== undefined && Date.now() >= expiresAt) {
      this.entries.delete(key);
      this.expiresAt.delete(key);
      return undefined;
    }
    return this.entries.get(key)?.clone();
  }

  async put(req: RequestInfo | URL, res: Response): Promise<void> {
    if (res.status === 206) throw new TypeError('Cannot cache response to a range request (206 Partial Content).');
    if (res.headers.get('vary')?.split(',').some((v) => v.trim() === '*')) {
      throw new TypeError("Cannot cache response with 'Vary: *' header.");
    }
    const key = this.keyOf(req);
    this.entries.set(key, res.clone());
    const maxAge = /(?:^|,)\s*max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '');
    if (maxAge) this.expiresAt.set(key, Date.now() + Number(maxAge[1]) * 1000);
    else this.expiresAt.delete(key);
  }

  async delete(req: RequestInfo | URL): Promise<boolean> {
    this.expiresAt.delete(this.keyOf(req));
    return this.entries.delete(this.keyOf(req));
  }
}

export function asCache(fake: FakeCache): Cache {
  return fake as unknown as Cache;
}

/** A Workers `ExecutionContext` stand-in that just collects what it is handed. */
export class FakeCtx {
  readonly promises: Promise<unknown>[] = [];

  waitUntil(promise: Promise<unknown>): void {
    this.promises.push(promise);
  }
}

/**
 * Run every pending fake timer and wait for everything handed to `waitUntil`,
 * repeating while settling one promise hands over another.
 */
export async function settle(...ctxs: FakeCtx[]): Promise<void> {
  const count = () => ctxs.reduce((n, c) => n + c.promises.length, 0);
  for (let round = 0; round < 20; round++) {
    const before = count();
    await vi.runAllTimersAsync();
    await Promise.allSettled(ctxs.flatMap((c) => c.promises));
    if (count() === before) return;
  }
  throw new Error('waitUntil promises never settled');
}

export function boolFlag(key: string, extra: Partial<FlagDto> = {}): FlagDto {
  return {
    key,
    version: 1,
    type: 'Boolean',
    enabled: true,
    variations: [
      { key: 'on', value: true },
      { key: 'off', value: false },
    ],
    rules: [],
    fallthrough: { type: 'Fixed', variation: 'on' },
    offVariation: 'off',
    ...extra,
  };
}

/** A `GET /v1/sdk/flags` payload whose `on-flag` serves `on` (true) or `off` (false). */
export function flagsPayload(version: number, onFlagServes: 'on' | 'off' = 'on'): GetFlagsResponse {
  return {
    environment: 'production',
    version,
    flags: [
      boolFlag('on-flag', {
        clientSideVisible: true,
        fallthrough: { type: 'Fixed', variation: onFlagServes },
      }),
      boolFlag('server-only', { clientSideVisible: false }),
      // Fails its prerequisite: server-only serves `on`, this expects `off`.
      boolFlag('gated', {
        prerequisites: [{ prerequisiteFlagKey: 'server-only', expectedVariationKey: 'off' }],
      }),
    ],
    segments: [],
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * A fetch fake routed by path: `flags` answers `GET /v1/sdk/flags`, `events`
 * answers `POST /v1/sdk/events` (202 when not given).
 */
export function fakeFetch(handlers: { flags?: FetchFn; events?: FetchFn }) {
  return vi.fn<FetchFn>(async (input, init) => {
    const url = urlOf(input);
    if (url.endsWith('/v1/sdk/flags')) {
      if (!handlers.flags) throw new Error('unexpected flags fetch');
      return handlers.flags(input, init);
    }
    if (url.endsWith('/v1/sdk/events')) {
      return handlers.events ? handlers.events(input, init) : new Response(null, { status: 202 });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

export type FakeFetch = ReturnType<typeof fakeFetch>;

export function callsTo(fetch: FakeFetch, path: string) {
  return fetch.mock.calls.filter(([input]) => urlOf(input).endsWith(path));
}

export function headersOf(init: RequestInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(init?.headers).entries());
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
