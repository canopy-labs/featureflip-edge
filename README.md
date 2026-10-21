# @featureflip/edge

Featureflip SDK for Cloudflare Workers. It evaluates flags locally inside your Worker from a cached copy of your environment's flag config, so a request that finds a warm copy makes no network call to evaluate a flag.

Cloudflare Workers is the only supported runtime.

## Install

```bash
npm install @featureflip/edge
```

## Quickstart

```ts
import { createEdgeClient } from '@featureflip/edge';

type Env = { FEATUREFLIP_SERVER_KEY: string };

// Config only at module scope: Workers forbid I/O there, and the key lives in `env`.
let flags: ReturnType<typeof createEdgeClient> | undefined;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    flags ??= createEdgeClient({ sdkKey: env.FEATUREFLIP_SERVER_KEY });

    const snapshot = await flags.load(ctx);
    const context = { user_id: 'user-123' };

    const enabled = snapshot.boolVariation('new-checkout', context, false);
    const detail = snapshot.variationDetail('checkout-copy', context, 'control');
    const bootstrap = snapshot.bootstrapValues(context);

    return new Response(JSON.stringify({ enabled, detail, bootstrap }));
  },
};
```

Call `load(ctx)` once per request. After it resolves, every variation call is synchronous.

## Options

`sdkKey` is the only required option. Use a server SDK key, not a client key.

| Option | Default | Description |
| --- | --- | --- |
| `sdkKey` | none (required) | Server SDK key. Sent as `Authorization` and never logged. |
| `baseUrl` | `https://eval.featureflip.io` | Evaluation API origin. |
| `ttlSeconds` | `60` | Age after which a copy is refreshed in the background. |
| `maxStaleSeconds` | `86400` | Age after which a copy is no longer served at all. |
| `loadTimeoutMs` | `1000` | How long a load with no cached copy waits for the origin. |
| `store` | Workers Cache API | Where fetched config is shared between isolates. |
| `wrappers` | `[]` | `name/version` tokens for libraries that wrap this SDK. |
| `flushBatchSize` | `100` | Events sent per `POST /v1/sdk/events` request. |
| `fetch` | global `fetch` | `fetch` implementation, mainly for tests. |

## Freshness

Flag changes reach edge traffic within `ttlSeconds` (60 seconds by default). This is not the near-instant push that the server SDKs get over a streaming connection.

A copy older than `ttlSeconds` is still served while a background refresh runs. So after an idle spell, the first request in gets the older copy once, because the refresh it started hasn't finished. A copy older than `maxStaleSeconds` is not served. If a config fetch fails, the SDK backs off for 15 seconds before trying the origin again, and keeps serving any copy it has.

## Pass `ctx`

Pass the Workers `ExecutionContext` to `load(ctx)`. It registers the background refresh and the event flush with `waitUntil`, so both finish after the response is sent.

Without `ctx`, await `flush()` yourself before responding, and the background refresh may be cut off when the request ends. The SDK logs a one-time warning when it runs without `ctx`.

## Cold start

With no cached copy, `load` waits up to `loadTimeoutMs` for the origin. If the origin is slower, `load` resolves a snapshot with `ready === false` that serves your default values. The fetch keeps going in the background and fills the cache for the next request.

## Bootstrapping the browser SDK

`snapshot.bootstrapValues(context)` returns the values of client-visible flags only, for the `bootstrap` option of `@featureflip/browser`. If the server does not send the client-visibility field, it returns nothing, so no flag is exposed by mistake.

## Events

Evaluations are queued as events and sent with `waitUntil` when you pass `ctx`. A request's flush sends only if a batch is full or 10 seconds have passed since the last send, so a busy isolate stops posting once per request. After a `429`, a `5xx` or a network error nothing is sent for 30 seconds, and outside that window `flush()` sends straight away, capped at 5 requests a call.

Delivery is best effort. The queue lives in the isolate's memory, so events still queued when Cloudflare evicts the isolate are lost.

## Logging

Messages go to `console.warn`. The SDK's own start with `[featureflip-edge]`, and the few from the shared evaluation core (rejected or dropped events, an ignored `wrappers` token) start with `[featureflip]`.

## License

Apache-2.0
