import { defineConfig } from 'vite';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import dts from 'vite-plugin-dts';

// `npm version` (publish-npm.yml) bumps package.json only, so package.json is
// the single source of the SDK's version (#2141). This reads the edge SDK's own
// manifest, not js-sdk's: the edge SDK identifies as itself.
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, 'package.json'), 'utf-8')
) as { version: string };

export default defineConfig({
  define: {
    __SDK_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    dts({
      // `rollupTypes` is the sibling SDKs' setting, but vite-plugin-dts 5 renamed
      // it `bundleTypes` and ignores the old name, so nothing is rolled up. The
      // sources span packages/ (this package plus js-sdk's core), so the
      // per-file declarations land under dist/edge-sdk/src/ and dist/js-sdk/src/;
      // insertTypesEntry writes the dist/index.d.ts that package.json `types`
      // names, re-exporting from there.
      rollupTypes: true,
      insertTypesEntry: true,
      outDir: 'dist',
    }),
  ],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      // Workers load ES modules only, so there is no cjs build.
      formats: ['es'],
      fileName: () => 'index.mjs',
    },
  },
  test: {
    globals: true,
    environment: 'node',
  },
});
