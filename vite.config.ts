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
      // The sources span packages/ (this package plus js-sdk's core), so the
      // per-file declarations land under dist/edge-sdk/src/ and dist/js-sdk/src/
      // first, then get rolled up into the dist/index.d.ts that package.json
      // `types` names. Only what the entry reaches survives the rollup.
      //
      // bundleTypes rolls the declarations up with api-extractor. unplugin-dts
      // hands it the workspace's `typescript` as its compiler, but that is TS7,
      // which ships no lib .d.ts files, so no global resolves ("Unable to follow
      // symbol for Promise"). Unsetting the folder makes api-extractor fall back
      // to the TypeScript it bundles.
      bundleTypes: { invokeOptions: { typescriptCompilerFolder: undefined } },
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
