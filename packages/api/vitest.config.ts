import { defineConfig } from 'vitest/config'

// Unit tests: no database, no Auth server. `server-only` throws outside a React Server build.
export default defineConfig({
  resolve: {
    alias: { 'server-only': '@bizcost/config/vitest/server-only-stub' },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
})
