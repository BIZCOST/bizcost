// The time budgets of the tests ("this takes under N ms") are measured against a development machine.
// CI's runners do the same work about 2.3 times slower (replayWac, a busy development machine against
// CI: 1.5 s and 3.5 s), so a budget there is `CI_BUDGET_FACTOR` times as long: wide enough that a runner
// never fails it by itself, and still short enough to catch what the budget is for (the replay before
// D-208 took 4.4 s and 12 s here, 10 s and 28 s there, against budgets of 4.5 s and 9 s). D-351.
export const CI_BUDGET_FACTOR = 3

/** `ms` as a budget here: as it is on a development machine, `CI_BUDGET_FACTOR` times that on CI. */
export function timeBudget(ms) {
  return process.env.CI ? ms * CI_BUDGET_FACTOR : ms
}
