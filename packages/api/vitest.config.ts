import base from '@bizcost/config/vitest/base'
import { defineConfig, mergeConfig } from 'vitest/config'

// Unit tests: no database, no Auth server (the demo data is checked here too). `server-only` throws outside a React Server build.
export default mergeConfig(
  base,
  defineConfig({
    resolve: {
      alias: { 'server-only': '@bizcost/config/vitest/server-only-stub' },
    },
    test: {
      include: ['src/**/*.test.ts', 'demo/**/*.test.ts'],
    },
  }),
)
