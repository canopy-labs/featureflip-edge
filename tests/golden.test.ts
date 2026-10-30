import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EdgeSnapshot } from '../src/snapshot.js';
import type { EvaluationDetail, FlagDto, GetFlagsResponse } from '../../js-sdk/src/core/types.js';

// Read js-sdk's copy rather than adding a ninth: the edge SDK evaluates with the
// js core, so this runs the same vectors through the edge's public surface.
const vectors = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../js-sdk/tests/golden/vectors.json'),
    'utf8',
  ),
) as {
  flagVectors: Array<{
    id: string;
    flagKey: string;
    flags: GetFlagsResponse['flags'];
    segments: GetFlagsResponse['segments'];
    context?: { userId: string; attributes: Record<string, unknown> };
    wireContext?: Record<string, unknown>;
    requires?: string[];
    expected: {
      variation: string;
      value: unknown;
      reason: { kind: string; ruleId?: string; prerequisiteKey?: string };
    };
  }>;
  coreContractVectors: Array<{
    id: string;
    description: string;
    flags: FlagDto[];
    flagKey: string;
    context: { userId: string; attributes: Record<string, unknown> };
    read: { as: 'bool' | 'string' | 'number' | 'int' | 'double'; default: unknown };
    expect: { value: unknown; reason: string };
  }>;
};

// Same normalisation as packages/js-sdk/tests/golden.test.ts.
function normalizeReason(d: { reason: string; ruleId?: string; prerequisiteKey?: string }) {
  const out: { kind: string; ruleId?: string; prerequisiteKey?: string } = { kind: d.reason };
  if (d.ruleId != null) out.ruleId = d.ruleId;
  if (d.prerequisiteKey != null) out.prerequisiteKey = d.prerequisiteKey;
  return out;
}

// Sort object keys so the comparison is independent of property order.
const sortKeys = (_k: string, val: unknown): unknown =>
  val && typeof val === 'object' && !Array.isArray(val)
    ? Object.fromEntries(
        Object.entries(val as Record<string, unknown>).sort((a, b) =>
          a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
        ),
      )
    : val;

// The edge takes an untyped map context and matches identity case-sensitively.
const SUPPORTED_CAPABILITIES = new Set(['mapContext', 'exactCaseIdentity']);

describe('golden flagVectors through EdgeSnapshot', () => {
  let executedFlagVectors = 0;
  for (const v of vectors.flagVectors) {
    if ((v.requires ?? []).some((t) => !SUPPORTED_CAPABILITIES.has(t))) continue;
    executedFlagVectors++;
    it(v.id, () => {
      const snap = EdgeSnapshot.fromResponse(
        { environment: 'golden', version: 1, flags: v.flags, segments: v.segments },
        () => {},
      );

      // Merge userId + attributes into a flat EvaluationContext, as js-sdk's runner does.
      const ctx: Record<string, unknown> = v.wireContext
        ? { ...v.wireContext }
        : { userId: v.context!.userId, ...v.context!.attributes };

      const r = snap.variationDetail<unknown>(v.flagKey, ctx, null);

      expect(r.variationKey).toBe(v.expected.variation);
      expect(JSON.stringify(r.value, sortKeys)).toBe(JSON.stringify(v.expected.value, sortKeys));
      expect(normalizeReason(r)).toEqual(v.expected.reason);
    });
  }

  // A runner that silently iterated nothing would pass for the wrong reason.
  it('ran the whole class', () => {
    expect(executedFlagVectors).toBe(vectors.flagVectors.length);
    expect(executedFlagVectors).toBeGreaterThanOrEqual(71);
  });
});

// The shared core's contract (typed-accessor strictness, malformed variations),
// run through the edge's own typed accessors rather than variationDetail, which
// is untyped and so cannot see a type mismatch. Same runner shape as
// packages/js-sdk/tests/golden-contract.test.ts; canonical reason tokens are
// already this SDK's spelling.
describe('golden coreContractVectors through EdgeSnapshot typed accessors', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  let executed = 0;

  for (const v of vectors.coreContractVectors) {
    // No separate int accessor: numberVariation covers every JSON number. The
    // skip is explicit so a capability gap can't look like a pass.
    if (v.read.as === 'int') continue;
    executed++;

    it(`${v.id}: ${v.description}`, () => {
      // A not-found vector on a ready snapshot logs the missing-key warning.
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const recorded: EvaluationDetail[] = [];
      const snap = EdgeSnapshot.fromResponse(
        { environment: 'golden', version: 1, flags: v.flags, segments: [] },
        (_key, _ctx, detail) => recorded.push(detail),
      );
      const ctx = { user_id: v.context.userId, ...v.context.attributes };

      let got: unknown;
      switch (v.read.as) {
        case 'bool':
          got = snap.boolVariation(v.flagKey, ctx, v.read.default as boolean);
          break;
        case 'string':
          got = snap.stringVariation(v.flagKey, ctx, v.read.default as string);
          break;
        case 'number':
        case 'double':
          got = snap.numberVariation(v.flagKey, ctx, v.read.default as number);
          break;
        default:
          throw new Error(`unmapped read.as ${v.read.as} — add it to the switch`);
      }

      expect(got).toStrictEqual(v.expect.value);
      // Typed accessors return only a value; the reason is what they recorded.
      expect(recorded).toHaveLength(1);
      expect(recorded[0].reason).toBe(v.expect.reason);
    });
  }

  it('executed the expected number of vectors', () => {
    expect(executed).toBeGreaterThanOrEqual(12);
  });
});
