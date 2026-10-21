/**
 * Replaced at build time by vite's `define` with the version from package.json.
 *
 * `publish-npm.yml` sets the release version by running `npm version`, which
 * touches package.json and nothing else — so the version has to be read from
 * there rather than duplicated in source, where it would drift at the next
 * release (#2141).
 */
declare const __SDK_VERSION__: string;
