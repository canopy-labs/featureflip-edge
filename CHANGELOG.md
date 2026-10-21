# Changelog

## 2.14.1 — 2026-10-21

### Changed

- Republished in lockstep with `@featureflip/js` 2.14.1, and the first `@featureflip/edge` release published from CI through npm trusted publishing. 2.14.0 was published by hand, because a package's first publish cannot use trusted publishing. This package has no source changes of its own. Recorded here because the npm release tag publishes all five JavaScript packages at a single version. (#1372)

## 2.14.0 — 2026-10-21

### Added

- Initial release of `@featureflip/edge`, a Cloudflare Workers SDK that evaluates flags locally at the edge. `createEdgeClient` keeps a cached copy of the `GET /v1/sdk/flags` config, serves it while a background refresh runs, and exposes the same typed accessors as the JavaScript SDK (`boolVariation`, `stringVariation`, `numberVariation`, `jsonVariation`, `variationDetail`) plus `bootstrapValues` for seeding `@featureflip/browser`. Evaluation events are queued and sent with `waitUntil`. (#1372)
