import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/main.ts',
    'src/preload.ts',
    'src/renderer-security.ts',
    'src/runtime-manager.ts',
    'src/runtime-updater.ts',
  ],
  format: 'cjs',
  outDir: 'dist',
  outExtensions: () => ({ js: '.cjs' }),
  platform: 'node',
  sourcemap: true,
  deps: {
    alwaysBundle: ['@yuanpu-agent/protocol'],
    neverBundle: ['electron', 'electron-updater'],
  },
});
