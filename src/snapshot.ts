import { resolveDetail } from '../../js-sdk/src/core/resolve-detail.js';
import { warnUnbucketable } from '../../js-sdk/src/core/unbucketable.js';
import type { ExpectedValueType, ResolveDeps } from '../../js-sdk/src/core/resolve-detail.js';
import { validateSnapshot } from '../../js-sdk/src/core/validate-snapshot.js';
import { dropUnevaluableEntities } from '../../js-sdk/src/core/unevaluable.js';
import { md5Bytes } from '../../js-sdk/src/platform/browser.js';
import type {
  EvaluationContext,
  EvaluationDetail,
  FlagDto,
  GetFlagsResponse,
  SegmentDto,
} from '../../js-sdk/src/core/types.js';

/**
 * Called once per variation call with the detail it resolved to. The edge client
 * uses it to queue evaluation events; `bootstrapValues` never calls it.
 */
export type EvaluationRecorder = (
  flagKey: string,
  context: EvaluationContext,
  detail: EvaluationDetail,
) => void;

/**
 * An immutable, evaluable view of one `GET /v1/sdk/flags` payload.
 *
 * Built once per fetched config and then read by every request the Worker
 * serves, so all the indexing happens at construction. Evaluation goes through
 * the same `resolveDetail` the JS core uses, so a flag resolves identically
 * here and in `@featureflip/js`, reasons included.
 */
export class EdgeSnapshot {
  /** False only for `empty()`: no config has been loaded. */
  readonly ready: boolean;
  /** The environment config version the snapshot was built from. */
  readonly version: number | undefined;

  private readonly flags: Record<string, FlagDto>;
  private readonly flagList: readonly FlagDto[];
  private readonly deps: ResolveDeps;
  private readonly record: EvaluationRecorder;

  private constructor(
    flags: FlagDto[],
    segments: SegmentDto[],
    version: number | undefined,
    ready: boolean,
    record: EvaluationRecorder,
  ) {
    // Null prototype: a flag key such as `constructor` or `__proto__` must miss
    // rather than resolve to an Object.prototype member, both here and in the
    // evaluator's prerequisite lookups, which index the same record.
    const byKey: Record<string, FlagDto> = Object.create(null);
    for (const flag of flags) byKey[flag.key] = flag;
    const segmentsByKey = new Map(segments.map((s) => [s.key, s]));

    this.flags = byKey;
    this.flagList = flags;
    this.version = version;
    this.ready = ready;
    this.record = record;
    this.deps = {
      md5: md5Bytes,
      getSegment: (key) => segmentsByKey.get(key),
      onUnbucketable: (i) => warnUnbucketable(i),
    };
  }

  /**
   * Build a snapshot from a fetched config.
   *
   * An unevaluable flag or segment (an enum value this SDK version does not know)
   * is dropped with a warning and the rest of the config still serves, as in the
   * JS core (#2402).
   *
   * @throws {MalformedPayloadError} when the payload violates the wire contract.
   *   The caller decides what to fall back to.
   */
  static fromResponse(data: GetFlagsResponse, record: EvaluationRecorder): EdgeSnapshot {
    validateSnapshot(data);
    const { flags, segments, dropped } = dropUnevaluableEntities(data);
    for (const entity of dropped) {
      console.warn(
        `[featureflip-edge] dropping ${entity.kind} "${entity.key}": ${entity.reason}. ` +
          'This SDK version may be older than the flag configuration; the rest of the ' +
          'configuration was applied.',
      );
    }
    return new EdgeSnapshot(flags, segments, data.version, true, record);
  }

  /** A snapshot with no flags: every read serves its default with `FlagNotFound`. */
  static empty(record: EvaluationRecorder): EdgeSnapshot {
    return new EdgeSnapshot([], [], undefined, false, record);
  }

  boolVariation(key: string, context: EvaluationContext, defaultValue: boolean): boolean {
    return this.evaluate(key, context, defaultValue, 'boolean').value;
  }

  stringVariation(key: string, context: EvaluationContext, defaultValue: string): string {
    return this.evaluate(key, context, defaultValue, 'string').value;
  }

  numberVariation(key: string, context: EvaluationContext, defaultValue: number): number {
    return this.evaluate(key, context, defaultValue, 'number').value;
  }

  /** Untyped: the served value is returned whatever its JSON type. */
  jsonVariation<T>(key: string, context: EvaluationContext, defaultValue: T): T {
    return this.evaluate(key, context, defaultValue).value;
  }

  /** Untyped, like `jsonVariation`, with the reason and variation attached. */
  variationDetail<T>(key: string, context: EvaluationContext, defaultValue: T): EvaluationDetail<T> {
    return this.evaluate(key, context, defaultValue);
  }

  /**
   * The served value of every flag marked `clientSideVisible: true`, for handing
   * to a browser SDK as bootstrap data. A flag without the field is treated as
   * not visible, because a server that predates it cannot vouch for it.
   *
   * Prerequisites still resolve against the whole config, server-only flags
   * included, through one memo shared across the sweep. Records nothing: these
   * values are not reads by the Worker's own code.
   *
   * A flag whose evaluation resolves to reason `Error` is omitted.
   */
  bootstrapValues(context: EvaluationContext): Record<string, unknown> {
    const memo = new Map<string, EvaluationDetail>();
    const out: Record<string, unknown> = {};
    for (const flag of this.flagList) {
      if (flag.clientSideVisible !== true) continue;
      const detail = resolveDetail<unknown>(
        flag, context, null, this.depsFor(flag.key), this.flags, undefined, memo,
      );
      // Omit rather than emit a placeholder: an absent key lets the browser SDK
      // fall back to its own default, where a `null` would be served as the
      // flag's value. A variation that genuinely serves null still appears.
      if (detail.reason === 'Error') continue;
      // Defined, not assigned: assigning to a flag keyed `__proto__` would set
      // the object's prototype and drop the flag. This keeps an own key on an
      // ordinary object, which JSON.stringify then emits like any other.
      Object.defineProperty(out, flag.key, {
        value: detail.value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }

  /** The shared deps plus an error hook that names the flag being read. */
  private depsFor(key: string): ResolveDeps {
    return {
      ...this.deps,
      onError: (err) => console.warn(`[featureflip-edge] evaluation threw for "${key}":`, err),
    };
  }

  private evaluate<T>(
    key: string,
    context: EvaluationContext,
    defaultValue: T,
    expected?: ExpectedValueType,
  ): EvaluationDetail<T> {
    const detail = resolveDetail(
      this.flags[key], context, defaultValue, this.depsFor(key), this.flags, expected,
    );
    try {
      this.record(key, context, detail);
    } catch (err) {
      console.warn(`[featureflip-edge] evaluation recorder threw for "${key}":`, err);
    }
    return detail;
  }
}
