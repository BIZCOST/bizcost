import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Unit tests: no database. `server-only` throws outside a React Server build, so it is stubbed.
export default defineConfig({
  resolve: {
    alias: { 'server-only': fileURLToPath(new URL('./test/empty-module.ts', import.meta.url)) },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
})
