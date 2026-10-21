import { describe, it, expect, vi } from 'vitest';
import { EdgeSnapshot } from '../src/snapshot.js';
import { MalformedPayloadError } from '../../js-sdk/src/core/validate-snapshot.js';
import { resolveDetail } from '../../js-sdk/src/core/resolve-detail.js';
import type { FlagDto, GetFlagsResponse } from '../../js-sdk/src/core/types.js';

function boolFlag(key: string, extra: Partial<FlagDto> = {}): FlagDto {
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

function fixture(): GetFlagsResponse {
  return {
    environment: 'production',
    version: 7,
    flags: [
      boolFlag('on-flag', { clientSideVisible: true }),
      boolFlag('server-only', { clientSideVisible: false }),
      boolFlag('legacy'),
      boolFlag('gated', {
        clientSideVisible: true,
        prerequisites: [{ prerequisiteFlagKey: 'server-only', expectedVariationKey: 'on' }],
      }),
      {
        key: 'str',
        version: 1,
        type: 'String',
        enabled: true,
        variations: [{ key: 'v', value: '42' }],
        rules: [],
        fallthrough: { type: 'Fixed', variation: 'v' },
        offVariation: 'v',
      },
    ],
    segments: [],
  };
}

const ctx = { userId: 'u' };

describe('EdgeSnapshot', () => {
  it('boolVariation returns the served value', () => {
    const snap = EdgeSnapshot.fromResponse(fixture(), () => {});
    expect(snap.boolVariation('on-flag', { userId: 'u' }, false)).toBe(true);
    expect(snap.ready).toBe(true);
    expect(snap.version).toBe(7);
  });

  it('unknown flag returns default with FlagNotFound', () => {
    const snap = EdgeSnapshot.fromResponse(fixture(), () => {});
    expect(snap.variationDetail('nope', ctx, 'd')).toEqual({ value: 'd', reason: 'FlagNotFound' });
  });

  it('typed mismatch returns default with Error', () => {
    const snap = EdgeSnapshot.fromResponse(fixture(), () => {});
    expect(snap.numberVariation('str', ctx, 7)).toBe(7);
    // variationDetail is untyped: it hands back the served value as-is.
    expect(snap.variationDetail('str', ctx, 7).value).toBe('42');
  });

  it('typed accessors report Error on a mismatch', () => {
    const rec = vi.fn();
    const snap = EdgeSnapshot.fromResponse(fixture(), rec);
    expect(snap.boolVariation('str', ctx, false)).toBe(false);
    expect(rec.mock.calls[0]![2]).toMatchObject({ value: false, reason: 'Error' });
    expect(snap.stringVariation('str', ctx, 'x')).toBe('42');
    expect(snap.jsonVariation('str', ctx, { a: 1 })).toBe('42');
  });

  it('bootstrapValues includes only clientSideVisible === true', () => {
    const snap = EdgeSnapshot.fromResponse(fixture(), () => {});
    expect(Object.keys(snap.bootstrapValues(ctx)).sort()).toEqual(['gated', 'on-flag']);
  });

  it('bootstrap resolves a server-only prerequisite', () => {
    const snap = EdgeSnapshot.fromResponse(fixture(), () => {});
    expect(snap.bootstrapValues(ctx).gated).toBe(true);
  });

  it('bootstrapValues records nothing', () => {
    const rec = vi.fn();
    const snap = EdgeSnapshot.fromResponse(fixture(), rec);
    snap.bootstrapValues(ctx);
    expect(rec).toHaveBeenCalledTimes(0);

    snap.boolVariation('on-flag', ctx, false);
    expect(rec).toHaveBeenCalledTimes(1);
    expect(rec).toHaveBeenCalledWith(
      'on-flag',
      ctx,
      expect.objectContaining({ value: true, variationKey: 'on', reason: 'Fallthrough' }),
    );
  });

  it('empty snapshot serves defaults', () => {
    const rec = vi.fn();
    const snap = EdgeSnapshot.empty(rec);
    expect(snap.ready).toBe(false);
    expect(snap.version).toBeUndefined();
    expect(snap.boolVariation('on-flag', ctx, false)).toBe(false);
    expect(snap.variationDetail('on-flag', ctx, false).reason).toBe('FlagNotFound');
    expect(snap.bootstrapValues(ctx)).toEqual({});
  });

  it('malformed response is rejected', () => {
    expect(() => EdgeSnapshot.fromResponse({ flags: 'x' } as any, () => {})).toThrow(
      MalformedPayloadError,
    );
  });

  it('drops an unevaluable flag with a warning and keeps the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const data = fixture();
      data.flags.push(
        boolFlag('future', { fallthrough: { type: 'Experiment' as never, variation: 'on' } }),
      );
      const snap = EdgeSnapshot.fromResponse(data, () => {});
      expect(snap.variationDetail('future', ctx, false).reason).toBe('FlagNotFound');
      expect(snap.boolVariation('on-flag', ctx, false)).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toMatch(/^\[featureflip-edge\] .*"future"/);
    } finally {
      warn.mockRestore();
    }
  });

  it('an evaluation that throws serves the default with Error and warns with the error', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const data = fixture();
      // A non-array `variations` passes validateSnapshot (which checks enum
      // types only) and makes the evaluator throw a TypeError.
      data.flags.push(boolFlag('broken', { variations: null as never }));
      const snap = EdgeSnapshot.fromResponse(data, () => {});

      expect(snap.variationDetail('broken', ctx, 'd')).toEqual({ value: 'd', reason: 'Error' });
      expect(warn).toHaveBeenCalledTimes(1);
      const [message, err] = warn.mock.calls[0]!;
      expect(String(message)).toBe('[featureflip-edge] evaluation threw for "broken":');
      expect(err).toBeInstanceOf(TypeError);
    } finally {
      warn.mockRestore();
    }
  });

  it('bootstrapValues omits a visible flag that resolves to Error', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const data = fixture();
      data.flags.push(
        boolFlag('broken', { clientSideVisible: true, variations: null as never }),
      );
      const values = EdgeSnapshot.fromResponse(data, () => {}).bootstrapValues(ctx);
      expect('broken' in values).toBe(false);
      expect(Object.keys(values).sort()).toEqual(['gated', 'on-flag']);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('bootstrapValues keeps a visible flag that genuinely serves null', () => {
    const data = fixture();
    data.flags.push({
      key: 'nullable',
      version: 1,
      type: 'Json',
      enabled: true,
      variations: [{ key: 'nothing', value: null }],
      rules: [],
      fallthrough: { type: 'Fixed', variation: 'nothing' },
      offVariation: 'nothing',
      clientSideVisible: true,
    });
    const values = EdgeSnapshot.fromResponse(data, () => {}).bootstrapValues(ctx);
    expect('nullable' in values).toBe(true);
    expect(values.nullable).toBeNull();
  });

  it('bootstrapValues keeps a visible flag keyed __proto__ as an own key', () => {
    const data = fixture();
    data.flags.push(boolFlag('__proto__', { clientSideVisible: true }));
    const values = EdgeSnapshot.fromResponse(data, () => {}).bootstrapValues(ctx);
    expect(Object.prototype.hasOwnProperty.call(values, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(values)).toBe(Object.prototype);
    expect(Object.keys(values)).toContain('__proto__');
    expect(JSON.stringify(values)).toContain('"__proto__":true');
  });

  it('a throwing recorder never breaks evaluation', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const snap = EdgeSnapshot.fromResponse(fixture(), () => {
        throw new Error('boom');
      });
      expect(snap.boolVariation('on-flag', ctx, false)).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toMatch(/^\[featureflip-edge\] /);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('resolveDetail allFlags thunk', () => {
  const deps = { md5: () => new Uint8Array(16), getSegment: () => undefined };

  it('builds allFlags inside its guard: a throwing thunk degrades to Error', () => {
    const detail = resolveDetail(boolFlag('f'), { userId: 'u' }, false, deps, () => {
      throw new Error('store broke');
    });
    expect(detail).toEqual({ value: false, reason: 'Error' });
  });

  it('a thunk resolves like the record it returns', () => {
    const flag = boolFlag('f');
    expect(resolveDetail(flag, { userId: 'u' }, false, deps, () => ({ f: flag }))).toEqual(
      resolveDetail(flag, { userId: 'u' }, false, deps, { f: flag }),
    );
  });
});
