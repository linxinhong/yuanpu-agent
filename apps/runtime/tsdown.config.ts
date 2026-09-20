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
  },
  deps: {
    alwaysBundle: [
      '@yuanpu-agent/core',
      '@yuanpu-agent/mcp',
      '@yuanpu-agent/mcp-contracts',
      '@yuanpu-agent/pi-runtime',
      '@yuanpu-agent/protocol',
    ],
    onlyBundle: false,
  },
});
