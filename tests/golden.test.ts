import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { EdgeSnapshot } from '../src/snapshot.js';
import type { GetFlagsResponse } from '../../js-sdk/src/core/types.js';

// Read js-sdk's copy rather than adding a ninth: the edge SDK evaluates with the
// js core, so this runs the same vectors through the edge's public surface.
const vectors = JSON.parse(
  readFileSync(new URL('../../js-sdk/tests/golden/vectors.json', import.meta.url), 'utf8'),
) as {
  flagVectors: Array<{
    id: string;
    flagKey: string;
    flags: GetFlagsResponse['flags'];
    segments: GetFlagsResponse['segments'];
    context: { userId: string; attributes: Record<string, unknown> };
    expected: {
      variation: string;
      value: unknown;
      reason: { kind: string; ruleId?: string; prerequisiteKey?: string };
    };
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

describe('golden flagVectors through EdgeSnapshot', () => {
  for (const v of vectors.flagVectors) {
    it(v.id, () => {
      const snap = EdgeSnapshot.fromResponse(
        { environment: 'golden', version: 1, flags: v.flags, segments: v.segments },
        () => {},
      );

      // Merge userId + attributes into a flat EvaluationContext, as js-sdk's runner does.
      const ctx: Record<string, unknown> = {
        userId: v.context.userId,
        ...v.context.attributes,
      };

      const r = snap.variationDetail<unknown>(v.flagKey, ctx, null);

      expect(r.variationKey).toBe(v.expected.variation);
      expect(JSON.stringify(r.value, sortKeys)).toBe(JSON.stringify(v.expected.value, sortKeys));
      expect(normalizeReason(r)).toEqual(v.expected.reason);
    });
  }

  // A runner that silently iterated nothing would pass for the wrong reason.
  it('ran the whole class', () => {
    expect(vectors.flagVectors.length).toBeGreaterThan(0);
  });
});
