import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/** The e2e suite against a real DeepSeek Harness installation (tests/e2e/README.md); `pnpm test:e2e` runs it. */
export default defineConfig({
  test: {
    root: fileURLToPath(new URL('../..', import.meta.url)),
    include: ['tests/e2e/**/*.e2e.ts'],
    testTimeout: 600_000,
    hookTimeout: 900_000,
    fileParallelism: false,
  },
})
