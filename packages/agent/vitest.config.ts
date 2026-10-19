import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Resolve the workspace package to its SOURCE, not its built dist/. Without this, agent tests
  // keep passing against symbols that were deleted from src but still exist in a stale dist.
  resolve: {
    alias: { '@at-agent/accessibility': resolve(__dirname, '../accessibility/src/index.ts') },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 60000,
  },
})
