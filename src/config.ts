import type { ConfigStore } from './store.js';

export interface EdgeConfig {
  /** A server-side SDK key. It is sent as `Authorization` and never logged. */
  sdkKey: string;
  /** Evaluation API origin. Default `https://eval.featureflip.io`. */
  baseUrl?: string;
  /** Age after which a served copy is refreshed in the background. Default 60. */
  ttlSeconds?: number;
  /** Age after which a copy is no longer served at all. Default 86400 (one day). */
  maxStaleSeconds?: number;
  /** How long a load with no usable copy waits for the origin before serving defaults. Default 1000. */
  loadTimeoutMs?: number;
  /** Where fetched config is shared between isolates. Default: the Workers Cache API. */
  store?: ConfigStore;
  /** `name/version` tokens for libraries wrapping this SDK, sent after the SDK's own. */
  wrappers?: string[];
  /** Events per `POST /v1/sdk/events` request. Default 100. */
  flushBatchSize?: number;
  /** `fetch` implementation. Default: the global `fetch`. */
  fetch?: typeof fetch;
}

export interface ResolvedEdgeConfig {
  sdkKey: string;
  baseUrl: string;
  ttlSeconds: number;
  maxStaleSeconds: number;
  loadTimeoutMs: number;
  store: ConfigStore | undefined;
  wrappers: string[];
  flushBatchSize: number;
  fetch: typeof fetch;
}

export const DEFAULTS = {
  baseUrl: 'https://eval.featureflip.io',
  ttlSeconds: 60,
  maxStaleSeconds: 86_400,
  loadTimeoutMs: 1000,
  flushBatchSize: 100,
} as const;

/** Throws only on a missing `sdkKey`; does no I/O. */
export function resolveEdgeConfig(config: EdgeConfig): ResolvedEdgeConfig {
  if (!config || typeof config.sdkKey !== 'string' || config.sdkKey === '') {
    throw new Error('[featureflip-edge] sdkKey is required');
  }
  return {
    sdkKey: config.sdkKey,
    baseUrl: (config.baseUrl ?? DEFAULTS.baseUrl).replace(/\/+$/, ''),
    ttlSeconds: config.ttlSeconds ?? DEFAULTS.ttlSeconds,
    maxStaleSeconds: config.maxStaleSeconds ?? DEFAULTS.maxStaleSeconds,
    loadTimeoutMs: config.loadTimeoutMs ?? DEFAULTS.loadTimeoutMs,
    store: config.store,
    wrappers: config.wrappers ?? [],
    flushBatchSize: config.flushBatchSize ?? DEFAULTS.flushBatchSize,
    // Looked up per call rather than captured: a bare reference to the Workers
    // global `fetch` invoked as a method of another object throws "Illegal invocation".
    fetch: config.fetch ?? ((input, init) => fetch(input, init)),
  };
}
