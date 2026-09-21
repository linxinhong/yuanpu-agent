import { readFileSync } from 'node:fs';

import { defineConfig } from 'tsdown';

const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'cjs',
  minify: true,
  outDir: 'dist',
  outExtensions: () => ({ js: '.cjs' }),
  outputOptions: {
    codeSplitting: false,
  },
  platform: 'node',
  sourcemap: false,
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
    // The runtime is a single Node bundle (and later a SEA executable). Tell Pi
    // to use its embedded extension loader instead of resolving workspace files
    // relative to an import.meta URL that no longer exists after CJS bundling.
    PI_BUNDLED_NODE: 'true',
  },
  deps: {
    alwaysBundle: [
      '@yuanpu-agent/runtime-kit',
      '@yuanpu-agent/protocol',
    ],
    onlyBundle: false,
  },
});
