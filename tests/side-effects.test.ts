import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

// package.json declares `"sideEffects": false`, which tells bundlers they may
// drop this module when its exports go unused, and the flag-cleanup Action
// relies on the same promise to delete a stranded import of the SDK. The claim
// is only true while loading the module does nothing observable, so each
// shipped entry point is loaded in its own Node process and must leave exactly
// the trace an empty module leaves. Every other test imports TypeScript
// source, so this goes through the built dist/ file instead.

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(pkgDir, 'package.json'), 'utf8')) as {
  sideEffects?: unknown;
  exports: unknown;
};
const probeScript = resolve(pkgDir, 'tests/fixtures/import-probe.mjs');
const probe = (target: string): unknown =>
  JSON.parse(execFileSync(process.execPath, [probeScript, target], { encoding: 'utf8' }));

// Every file the exports map can hand a consumer, under any condition.
const exportedFiles = (node: unknown): string[] =>
  typeof node === 'string'
    ? node.endsWith('.d.ts') ? [] : [node]
    : Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
        key === 'types' ? [] : exportedFiles(value)
      );
const entryFiles = [...new Set(exportedFiles(pkg.exports))];

let baseline: unknown;
beforeAll(() => {
  // dist/ is absent when the tests run before a build.
  if (!existsSync(resolve(pkgDir, 'dist/index.mjs'))) {
    execFileSync('npm', ['run', 'build'], {
      cwd: pkgDir,
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'production' },
    });
  }
  baseline = probe('data:text/javascript,export {};');
}, 180_000);

describe('import-time side effects', () => {
  it('declares sideEffects: false', () => {
    expect(pkg.sideEffects).toBe(false);
  });

  it('covers the one module format Workers load', () => {
    expect(entryFiles).toEqual(['./dist/index.mjs']);
  });

  it('notices a module that does work at load time', () => {
    const leaky = probe(
      'data:text/javascript,globalThis.leak = 1; Array.prototype.leak = 1; ' +
        'setInterval(() => {}, 1000); globalThis.addEventListener?.("fetch", () => {});'
    );

    expect(leaky).toMatchObject({
      globals: expect.arrayContaining(['leak']),
      patched: ['Array.prototype.leak'],
      timers: ['setInterval'],
    });
  });

  it.each(entryFiles)('loading %s has no side effects', (file) => {
    expect(probe(resolve(pkgDir, file))).toEqual(baseline);
  });
});
