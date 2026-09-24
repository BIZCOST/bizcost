import { defineConfig } from 'vitest/config'

// Unit tests: no database. `server-only` throws outside a React Server build, so it is stubbed.
export default defineConfig({
  resolve: {
    alias: { 'server-only': '@bizcost/config/vitest/server-only-stub' },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
})
