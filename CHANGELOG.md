# Changelog

## 2.16.0 — 2026-10-26

### Added

- Evaluation events now carry the reason for the read (`rule-match`, `fallthrough`, `flag-disabled`, `prerequisite-failed`, `error` or `flag-not-found`) and, on a rule match, the matched rule's id as `ruleId`. The flag Analytics tab uses them to show which part of the targeting served the traffic; events from older SDK versions count as an unknown source. `EvaluationDetail` is unchanged. (#4268)

## 2.15.0 — 2026-10-22

### Changed

- A percentage rollout that can't bucket the context (no `user_id`, or no value for its bucket-by attribute) now skips the rule and evaluation continues with the next rule or the fallthrough. Previously the SDK served the rollout's first variation, which is the variation being rolled out. A warning is logged once per flag and rule. (#4236)
- Malformed variation references now evaluate to reason `Error` the way the Evaluation API does. A rule or fallthrough that serves a key the flag doesn't define (the detail already reported `Error` and the default) no longer reports the rule id, and a served empty-string key with no empty-string variation is now an `Error` too. A flag whose prerequisite serves an undefined variation, or whose own off variation is undefined, now reports `Error` (still serving its off variation) instead of `PrerequisiteFailed` or `FlagDisabled`. (#4236)
- Decimal numbers used as a rollout bucket value now hash in one canonical spelling shared with the Evaluation API (for example `1.0` hashes as `1`), so the same context gets the same variant in every SDK. Integer values are unchanged. A context whose user id is a non-integer number may get a different variant. (#4236)

## 2.14.1 — 2026-10-21

### Changed

- Republished in lockstep with `@featureflip/js` 2.14.1, and the first `@featureflip/edge` release published from CI through npm trusted publishing. 2.14.0 was published by hand, because a package's first publish cannot use trusted publishing. This package has no source changes of its own. Recorded here because the npm release tag publishes all five JavaScript packages at a single version. (#1372)

## 2.14.0 — 2026-10-21

### Added

- Initial release of `@featureflip/edge`, a Cloudflare Workers SDK that evaluates flags locally at the edge. `createEdgeClient` keeps a cached copy of the `GET /v1/sdk/flags` config, serves it while a background refresh runs, and exposes the same typed accessors as the JavaScript SDK (`boolVariation`, `stringVariation`, `numberVariation`, `jsonVariation`, `variationDetail`) plus `bootstrapValues` for seeding `@featureflip/browser`. Evaluation events are queued and sent with `waitUntil`. (#1372)
