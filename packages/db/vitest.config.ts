import base from '@bizcost/config/vitest/base'
import { defineConfig, mergeConfig } from 'vitest/config'

// Unit tests: no database. `server-only` throws outside a React Server build, so it is stubbed.
export default mergeConfig(
  base,
  defineConfig({
    resolve: {
      alias: { 'server-only': '@bizcost/config/vitest/server-only-stub' },
    },
    test: {
      include: ['src/**/*.test.ts'],
    },
  }),
)
