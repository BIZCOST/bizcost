import { defineConfig } from 'vitest/config'
import { timeBudget } from './budget.js'

// Every package's Vitest starts from this (docs/ARCHITECTURE.md §Testing & CI, D-351). A fast-check
// property runs its function a hundred times or more: 2–5 s on a busy development machine and more on
// CI's runners, past Vitest's default of 5 s. A timeout only catches a test that hangs; how fast the
// code is, is what the time budgets check (budget.js), so one wide value serves every test.
export const TEST_TIMEOUT_MS = 30_000

export default defineConfig({
  test: { testTimeout: timeBudget(TEST_TIMEOUT_MS) },
})
