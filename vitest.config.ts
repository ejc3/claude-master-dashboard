import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      'server-only': fileURLToPath(
        new URL('./packages/dashboard/test/support/server-only.ts', import.meta.url),
      ),
    },
  },
  test: { include: ['packages/*/test/**/*.test.ts'] },
})
