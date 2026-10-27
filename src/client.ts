import { EventProcessor, EventSendError } from '../../js-sdk/src/core/events.js';
import { buildIdentity } from '../../js-sdk/src/core/identity.js';
import { buildEvaluationEvent } from '../../js-sdk/src/core/shared-core.js';
import type { GetFlagsResponse, RecordEventsRequest } from '../../js-sdk/src/core/types.js';
import { resolveEdgeConfig } from './config.js';
import type { EdgeConfig, ResolvedEdgeConfig } from './config.js';
import { EdgeSnapshot } from './snapshot.js';
import type { EvaluationRecorder } from './snapshot.js';
import { configCacheKey, createCacheApiStore } from './store.js';
import type { ConfigStore } from './store.js';

/** The part of a Workers `ExecutionContext` the client uses. */
export interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface EdgeClient {
  /**
   * The snapshot to evaluate this request against. Never rejects: with no usable
   * config it resolves to a snapshot that serves defaults (`ready === false`).
   *
   * Pass the request's `ctx` so the background refresh and the event flush run
   * in `waitUntil`. As it resolves, `load(ctx)` hands `waitUntil` a flush that
   * runs once the handler's code following `await load(ctx)` yields. That flush
   * sends only when a batch is full or 10 s have passed since the last send, so
   * events from busy traffic go out together rather than one POST per request.
   * Events are best effort: anything still queued when the isolate is evicted
   * is lost.
   */
  load(ctx?: WaitUntilContext): Promise<EdgeSnapshot>;
  /**
   * Sends queued evaluation events now, up to 5 batches. Never rejects. Await it
   * when there is no `ctx`. Within 30 s of a failed send it resolves without
   * sending, and the events stay queued.
   */
  flush(): Promise<void>;
}

const PREFIX = '[featureflip-edge]';

/**
 * How long an in-flight config fetch is joined before it is presumed abandoned.
 * In Workers, a fetch begun by a request that has since ended can be cancelled
 * without ever settling; joining it forever would stop this isolate refreshing.
 * 30s is the most `waitUntil` extends a request past its response.
 */
const STALLED_FETCH_MS = 30_000;

/**
 * After a config fetch fails (any error or non-2xx, a malformed body, a stall,
 * or a cold load timing out on it), no new origin fetch starts for this long,
 * and a load with no copy resolves to defaults at once instead of waiting
 * `loadTimeoutMs`. Same value as the landing middleware's FAILURE_BACKOFF_MS
 * (#4067). A success clears it.
 */
const FAILURE_BACKOFF_MS = 15_000;

/**
 * A per-request flush sends only when a batch is full or this long has passed
 * since the last send attempt. The Evaluation API's `sdk-events` limit (about
 * 80/s per environment) is sized for SDKs that flush every 30 s, and a Worker
 * flushing on every request would exceed it from ~100 requests a second.
 */
const EVENT_FLUSH_INTERVAL_MS = 10_000;

/**
 * After a retryable send failure (429, 5xx, a network error), no flush sends
 * for this long, explicit ones included. Without it a 429 is retried on the
 * very next request, which keeps the endpoint saturated. Also passed to the
 * core EventProcessor as its flush interval, where it only feeds bookkeeping
 * for the full-batch trigger this client turns off.
 */
const EVENT_RETRY_BACKOFF_MS = 30_000;

/**
 * POSTs one flush may make. A Free-plan Worker gets 50 subrequests per
 * invocation, and draining a queue built up during an outage (up to 10,000
 * events) would take 100. What is left waits for a later flush.
 */
const MAX_BATCHES_PER_FLUSH = 5;

/**
 * How long an events POST is waited on before it is abandoned. Same reasoning as
 * STALLED_FETCH_MS: a POST begun by a request that has since ended can be
 * cancelled without settling, and the processor joins its flush forever.
 */
const STALLED_SEND_MS = 30_000;

interface MemoryCopy {
  data: GetFlagsResponse;
  /** Epoch ms at which `data` was fetched from the evaluation API. */
  fetchedAt: number;
  snapshot: EdgeSnapshot;
}

/** The events POST in flight, which a later flush may abandon (see STALLED_SEND_MS). */
interface PendingSend {
  startedAt: number;
  /** Rejects the processor's await so it requeues the batch and lets go. */
  abandon(): void;
}

interface InFlightFetch {
  startedAt: number;
  /** Settles once memory holds the result, or the fetch failed (never rejects). */
  loaded: Promise<void>;
  /** Settles once the result has also been written to the store (never rejects). */
  settled: Promise<void>;
  /** Whether a cold load has already warned that it timed out on this fetch. */
  timeoutWarned: boolean;
}

/**
 * A Featureflip client for Cloudflare Workers. Construct it at module scope: it
 * does no I/O until the first `load`.
 *
 * @throws {Error} only when `sdkKey` is missing.
 */
export function createEdgeClient(config: EdgeConfig): EdgeClient {
  return new Client(resolveEdgeConfig(config));
}

/** Thrown inside a fetch for a 401/403, so it is warned as a key problem, not an outage. */
class KeyRejectedError extends Error {
  constructor(readonly status: number) {
    super(`SDK key rejected (${status})`);
    this.name = 'KeyRejectedError';
  }
}

class Client implements EdgeClient {
  /** The per-client memory copy. Keyed implicitly by this client's own config. */
  private memory: MemoryCopy | undefined;
  private storePromise: Promise<ConfigStore | undefined> | undefined;
  private inflight: InFlightFetch | undefined;
  /** Epoch ms before which no new config fetch starts (see FAILURE_BACKOFF_MS). */
  private backoffUntil = 0;
  private warnedNoWaitUntil = false;
  /** Epoch ms of the last events POST started (see EVENT_FLUSH_INTERVAL_MS). */
  private lastSendAttemptAt = 0;
  /** Epoch ms before which no events POST starts (see EVENT_RETRY_BACKOFF_MS). */
  private eventBackoffUntil = 0;
  private pendingSend: PendingSend | undefined;
  /** The processor flush this client last started or joined. */
  private eventFlush: Promise<void> = Promise.resolve();

  private readonly identity: string;
  private readonly events: EventProcessor;
  private readonly record: EvaluationRecorder;
  private readonly emptySnapshot: EdgeSnapshot;

  constructor(private readonly config: ResolvedEdgeConfig) {
    this.identity = buildIdentity([`featureflip-edge/${__SDK_VERSION__}`, ...config.wrappers]);
    this.events = new EventProcessor(
      { sendEvents: (request) => this.sendEvents(request) },
      EVENT_RETRY_BACKOFF_MS,
      config.flushBatchSize,
      undefined,
      // A send the processor starts on its own belongs to no waitUntil, so it
      // can be cut off mid-flight with its batch already taken off the queue.
      { flushOnFullBatch: false, maxBatchesPerFlush: MAX_BATCHES_PER_FLUSH },
    );
    // Same event as SharedFeatureflipCore builds. A JS caller can pass a null
    // context; that is an anonymous read, not an error.
    this.record = (flagKey, context, detail) => {
      this.events.enqueue(buildEvaluationEvent(flagKey, context ?? {}, detail));
    };
    this.emptySnapshot = EdgeSnapshot.empty(this.record);
  }

  async load(ctx?: WaitUntilContext): Promise<EdgeSnapshot> {
    if (!ctx && !this.warnedNoWaitUntil) {
      this.warnedNoWaitUntil = true;
      console.warn(
        `${PREFIX} running without waitUntil; background refresh may be cut off. ` +
          'Pass the request ctx to load(), or await flush() before responding.',
      );
    }

    let snapshot: EdgeSnapshot;
    try {
      snapshot = await this.resolveSnapshot(ctx);
    } catch (err) {
      console.warn(`${PREFIX} load failed; serving the last good config or defaults:`, err);
      snapshot = this.usableCopy()?.snapshot ?? this.emptySnapshot;
    }
    // Scheduled only now, after every await above, so its timer is queued behind
    // the handler's continuation rather than firing during this load's own I/O.
    if (ctx) this.scheduleFlush(ctx);
    return snapshot;
  }

  flush(): Promise<void> {
    return this.flushEvents(false);
  }

  /**
   * Every send goes through here. `scheduled` is the per-request flush from
   * `load`, which also waits for a full batch or EVENT_FLUSH_INTERVAL_MS. Both
   * kinds respect the retry backoff and the stall guard.
   */
  private async flushEvents(scheduled: boolean): Promise<void> {
    try {
      await this.abandonStalledSend();
      // Returning here, not in the processor, keeps `eventFlush` on the flush
      // that owns any POST in flight: the processor would hand back an
      // already-settled promise for an empty queue.
      if (this.events.size === 0) return;
      const now = Date.now();
      if (now < this.eventBackoffUntil) return;
      if (
        scheduled &&
        this.events.size < this.config.flushBatchSize &&
        now - this.lastSendAttemptAt < EVENT_FLUSH_INTERVAL_MS
      ) {
        return;
      }
      this.eventFlush = this.events.flush();
      await this.eventFlush;
    } catch (err) {
      console.warn(`${PREFIX} event flush failed:`, err);
    }
  }

  /**
   * Abandon an events POST that has run past STALLED_SEND_MS, then wait for the
   * processor to put its batch back and release the flush. Checked when a flush
   * starts rather than on a timer, because a timer set by a request that has
   * ended is no more certain to fire than the POST is to settle.
   */
  private async abandonStalledSend(): Promise<void> {
    const send = this.pendingSend;
    if (!send || Date.now() - send.startedAt <= STALLED_SEND_MS) return;
    send.abandon();
    await this.eventFlush.catch(() => {});
  }

  private async resolveSnapshot(ctx: WaitUntilContext | undefined): Promise<EdgeSnapshot> {
    let copy = this.usableCopy();
    if (!copy) {
      await this.promoteStoredCopy();
      copy = this.usableCopy();
    }
    if (copy) {
      if (Date.now() - copy.fetchedAt > this.config.ttlSeconds * 1000) this.refresh(ctx);
      return copy.snapshot;
    }
    return this.coldLoad(ctx);
  }

  /** The memory copy, if it is within `maxStaleSeconds`. */
  private usableCopy(): MemoryCopy | undefined {
    const copy = this.memory;
    if (!copy) return undefined;
    return Date.now() - copy.fetchedAt <= this.config.maxStaleSeconds * 1000 ? copy : undefined;
  }

  /** Read the store and, when it holds a servable copy newer than memory, adopt it. */
  private async promoteStoredCopy(): Promise<void> {
    const store = await this.store();
    if (!store) return;
    let stored;
    try {
      stored = await store.get();
    } catch (err) {
      console.warn(`${PREFIX} config store read failed:`, err);
      return;
    }
    if (!stored) return;
    if (Date.now() - stored.fetchedAt > this.config.maxStaleSeconds * 1000) return;
    // A concurrent fetch may have filled memory while the store was being read.
    if (this.memory && this.memory.fetchedAt >= stored.fetchedAt) return;
    try {
      const snapshot = EdgeSnapshot.fromResponse(stored.data, this.record);
      this.memory = { data: stored.data, fetchedAt: stored.fetchedAt, snapshot };
    } catch (err) {
      console.warn(`${PREFIX} ignoring unusable stored config:`, err);
    }
  }

  private async coldLoad(ctx: WaitUntilContext | undefined): Promise<EdgeSnapshot> {
    const fetching = this.refresh(ctx);
    // Backing off: whether or not a fetch is still in flight, don't make the
    // request wait on an origin that just failed.
    if (!fetching || this.inBackoff()) return this.usableCopy()?.snapshot ?? this.emptySnapshot;

    let expire!: (value: true) => void;
    const timedOut = new Promise<true>((resolve) => {
      expire = resolve;
    });
    // The one timer this client starts; cleared as soon as the fetch wins.
    const timer = setTimeout(() => expire(true), this.config.loadTimeoutMs);
    const outcome = await Promise.race([fetching.loaded.then(() => false as const), timedOut]);
    clearTimeout(timer);
    if (outcome === true) {
      this.backOff();
      if (!fetching.timeoutWarned) {
        fetching.timeoutWarned = true;
        console.warn(
          `${PREFIX} no config within ${this.config.loadTimeoutMs}ms; serving defaults while the fetch completes in the background.`,
        );
      }
    }
    return this.usableCopy()?.snapshot ?? this.emptySnapshot;
  }

  private inBackoff(): boolean {
    return Date.now() < this.backoffUntil;
  }

  private backOff(): void {
    this.backoffUntil = Date.now() + FAILURE_BACKOFF_MS;
  }

  /**
   * Join the config fetch in flight, or start one unless backing off, and hand
   * it to `ctx`. Undefined when there is no fetch to wait on.
   */
  private refresh(ctx: WaitUntilContext | undefined): InFlightFetch | undefined {
    const now = Date.now();
    let fetching = this.inflight;
    if (fetching && now - fetching.startedAt > STALLED_FETCH_MS) {
      // Abandoned, and counted as a failed fetch: warned once, here, and backed off.
      this.inflight = fetching = undefined;
      console.warn(
        `${PREFIX} config refresh failed:`,
        new Error(`GET /v1/sdk/flags did not settle within ${STALLED_FETCH_MS}ms; abandoned`),
      );
      this.backOff();
    }
    if (!fetching) {
      if (this.inBackoff()) return undefined;
      fetching = this.startFetch(now);
      this.inflight = fetching;
    }
    if (ctx) this.handOff(ctx, fetching.settled);
    return fetching;
  }

  private startFetch(startedAt: number): InFlightFetch {
    let persisted: Promise<void> = Promise.resolve();
    const entry: InFlightFetch = {
      startedAt,
      loaded: Promise.resolve(),
      settled: Promise.resolve(),
      timeoutWarned: false,
    };
    entry.loaded = (async () => {
      try {
        const data = await this.fetchConfig();
        const snapshot = EdgeSnapshot.fromResponse(data, this.record);
        const copy: MemoryCopy = { data, fetchedAt: Date.now(), snapshot };
        this.backoffUntil = 0;
        // A fetch abandoned as stalled can still finish late; never let it
        // overwrite a copy obtained after it started.
        if (this.memory && this.memory.fetchedAt > startedAt) return;
        this.memory = copy;
        persisted = this.persist(copy);
      } catch (err) {
        // An abandoned fetch was already warned about and backed off for.
        if (this.inflight !== entry) return;
        this.backOff();
        if (err instanceof KeyRejectedError) {
          // Distinct from an outage: a revoked or wrong key will not fix itself.
          console.warn(`${PREFIX} SDK key rejected (${err.status})`);
        } else {
          console.warn(`${PREFIX} config refresh failed:`, err);
        }
      }
    })();
    entry.settled = entry.loaded.then(() => persisted);
    const clear = () => {
      if (this.inflight === entry) this.inflight = undefined;
    };
    entry.settled.then(clear, clear);
    return entry;
  }

  /** `GET /v1/sdk/flags`. Throws for any failure, `KeyRejectedError` for 401/403. */
  private async fetchConfig(): Promise<GetFlagsResponse> {
    const doFetch = this.config.fetch;
    const response = await doFetch(`${this.config.baseUrl}/v1/sdk/flags`, {
      method: 'GET',
      headers: this.headers(),
    });
    if (response.status === 401 || response.status === 403) {
      discardBody(response);
      throw new KeyRejectedError(response.status);
    }
    if (!response.ok) {
      discardBody(response);
      throw new Error(`GET /v1/sdk/flags responded ${response.status}`);
    }
    return (await response.json()) as GetFlagsResponse;
  }

  private async persist(copy: MemoryCopy): Promise<void> {
    const store = await this.store();
    if (!store) return;
    try {
      await store.put({ data: copy.data, fetchedAt: copy.fetchedAt }, this.config.maxStaleSeconds);
    } catch (err) {
      console.warn(`${PREFIX} config store write failed:`, err);
    }
  }

  /**
   * The config store, resolved once. The Cache API key is a hash of this
   * client's base URL and SDK key, which is the only tenant isolation in a cache
   * namespace shared across hostnames. When it cannot be derived (no
   * `crypto.subtle`), the client runs memory-only rather than fall back to any
   * other key.
   */
  private store(): Promise<ConfigStore | undefined> {
    this.storePromise ??= (async () => {
      if (this.config.store) return this.config.store;
      try {
        return createCacheApiStore(await configCacheKey(this.config.baseUrl, this.config.sdkKey));
      } catch (err) {
        console.warn(`${PREFIX} cannot derive the config cache key; running memory-only:`, err);
        return undefined;
      }
    })();
    return this.storePromise;
  }

  /**
   * Hand the request's event flush to `waitUntil`. Called by `load` as it
   * returns, and deferred by one macrotask: the handler's continuation after
   * `await load(ctx)` runs as microtasks first, so the variation calls it makes
   * before its next `await` are in the batch.
   */
  private scheduleFlush(ctx: WaitUntilContext): void {
    const flushed = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() =>
      this.flushEvents(true),
    );
    this.handOff(ctx, flushed);
  }

  private handOff(ctx: WaitUntilContext, promise: Promise<unknown>): void {
    try {
      ctx.waitUntil(promise);
    } catch (err) {
      console.warn(`${PREFIX} ctx.waitUntil threw; background work may be cut off:`, err);
    }
  }

  /**
   * The processor's sender. Settles with the POST, or with an abandonment error
   * once a later flush finds it stalled. The processor requeues the batch on
   * either failure. A POST that settles after being abandoned is ignored: its
   * batch is already back in the queue, so acting on it would requeue it twice.
   */
  private sendEvents(request: RecordEventsRequest): Promise<void> {
    const startedAt = Date.now();
    this.lastSendAttemptAt = startedAt;
    return new Promise<void>((resolve, reject) => {
      const send: PendingSend = {
        startedAt,
        abandon: () => {
          if (this.pendingSend === send) this.pendingSend = undefined;
          // Not backed off: the stall already kept this client from sending for
          // longer than EVENT_RETRY_BACKOFF_MS.
          const err = new Error(
            `POST /v1/sdk/events did not settle within ${STALLED_SEND_MS}ms; abandoned`,
          );
          console.warn(
            `${PREFIX} failed to send ${request.events.length} analytics event(s); they stay queued for the next flush:`,
            err,
          );
          reject(err);
        },
      };
      this.pendingSend = send;
      this.postEvents(request).then(
        () => {
          if (this.pendingSend !== send) return;
          this.pendingSend = undefined;
          resolve();
        },
        (err: unknown) => {
          if (this.pendingSend !== send) return;
          this.pendingSend = undefined;
          // The processor re-queues a retryable failure silently and warns itself
          // on a permanent one, so only the retryable case needs saying here.
          if (!(err instanceof EventSendError) || err.retryable) {
            this.eventBackoffUntil = Date.now() + EVENT_RETRY_BACKOFF_MS;
            console.warn(
              `${PREFIX} failed to send ${request.events.length} analytics event(s); they stay queued and are retried in ${EVENT_RETRY_BACKOFF_MS / 1000}s:`,
              err,
            );
          }
          reject(err);
        },
      );
    });
  }

  /** `POST /v1/sdk/events`. Throws `EventSendError` for a non-2xx. */
  private async postEvents(request: RecordEventsRequest): Promise<void> {
    const doFetch = this.config.fetch;
    const response = await doFetch(`${this.config.baseUrl}/v1/sdk/events`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    // The body is never read. Cancelling it releases the connection now rather
    // than whenever the runtime collects it.
    discardBody(response);
    if (!response.ok) throw new EventSendError(response.status);
  }

  private headers(): Record<string, string> {
    return {
      Authorization: this.config.sdkKey,
      'X-Featureflip-SDK': this.identity,
    };
  }
}

/** Cancel a response body that will not be read. Never throws. */
function discardBody(response: Response): void {
  try {
    response.body?.cancel().catch(() => {});
  } catch {
    // A body already used or locked has nothing left to release.
  }
}
