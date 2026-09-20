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
  platform: 'node',
  sourcemap: false,
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  deps: {
    alwaysBundle: (id) => !id.startsWith('node:'),
  },
});
