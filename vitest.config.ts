import { defineConfig } from 'vitest/config'
// Share one React instance across DSH client packages and tests. tests/e2e needs a real DeepSeek Harness: `pnpm test:e2e`.
export default defineConfig({ resolve: { dedupe: ['react', 'react-dom'] },
  test: { include: ['tests/**/*.spec.{ts,tsx}'], exclude: ['tests/e2e/**', '**/node_modules/**'] } })
