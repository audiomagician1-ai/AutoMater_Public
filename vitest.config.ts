import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['electron/**/*.test.ts', 'src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['node_modules', 'dist', 'dist-electron', 'release'],
    // Electron/Node modules mock
    alias: {
      electron: new URL('./__mocks__/electron.ts', import.meta.url).pathname,
    },
  },
});
