import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { createEdgeClient } from '../src/index.js';
import { FakeCtx, callsTo, fakeFetch, flagsPayload, headersOf, jsonResponse, settle } from './fakes.js';

const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8')) as {
  version: string;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function identityFor(wrappers?: string[]) {
  const fetch = fakeFetch({ flags: async () => jsonResponse(flagsPayload(1)) });
  const client = createEdgeClient({ sdkKey: 'sdk_server_k', fetch, wrappers });
  const ctx = new FakeCtx();
  const snap = await client.load(ctx);
  snap.boolVariation('on-flag', { userId: 'u' }, false);
  await settle(ctx);
  const flags = headersOf(callsTo(fetch, '/v1/sdk/flags')[0][1])['x-featureflip-sdk'];
  const events = headersOf(callsTo(fetch, '/v1/sdk/events')[0][1])['x-featureflip-sdk'];
  return { flags, events };
}

describe('identity header', () => {
  it('identity header carries edge and js tokens from package.json', async () => {
    const { flags, events } = await identityFor();
    // buildIdentity puts the core's own token first, then each wrapper in order;
    // the edge SDK is a wrapper of the js core.
    expect(flags).toBe(`featureflip-js/${pkg.version} featureflip-edge/${pkg.version}`);
    expect(events).toBe(flags);
  });

  it('wrappers are appended', async () => {
    const { flags } = await identityFor(['my-framework/3.1.0', 'other/1']);
    expect(flags).toBe(
      `featureflip-js/${pkg.version} featureflip-edge/${pkg.version} my-framework/3.1.0 other/1`,
    );
  });
});
