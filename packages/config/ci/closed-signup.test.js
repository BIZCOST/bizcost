import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Closed sign-up (D-355, D-361) is one setting in two places: off in config.toml, for the local stack and
// the tests, and on from db-migrate.yml for every hosted project unless its environment says otherwise.
// A workflow that forgot it, or pushed before it, would open sign-up with no error anywhere.

const read = (path) =>
  readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8')

/** The names of a workflow's steps, in order, with what each runs. */
function stepsOf(workflow) {
  return workflow
    .split(/\n\s+- /)
    .slice(1)
    .map((step) => step.trim())
}

const indexOf = (steps, text) => steps.findIndex((step) => step.includes(text))

describe('closed sign-up is wired', () => {
  it('config.toml has the hook, off by default, at the function the migration creates', () => {
    const config = read('supabase/config.toml').replaceAll('\r\n', '\n')
    const section = /^\[auth\.hook\.before_user_created\]\n((?:.+\n)+)/m.exec(config)?.[1] ?? ''
    expect(section).toMatch(/^enabled = false$/m)
    expect(section).toMatch(/^uri = "pg-functions:\/\/postgres\/auth_hooks\/before_user_created"$/m)
  })

  it('db-migrate writes the environment’s values before the diff and before the push', () => {
    const steps = stepsOf(read('.github/workflows/db-migrate.yml').replaceAll('\r\n', '\n'))
    const rendered = indexOf(steps, 'node packages/config/ci/hosted-config.mjs')
    expect(rendered).toBeGreaterThan(-1)
    expect(steps[rendered]).toContain('CLOSED_SIGNUP: ${{ vars.CLOSED_SIGNUP }}')
    expect(steps[rendered]).toContain('APP_URL: ${{ vars.APP_URL }}')
    expect(steps[rendered]).not.toMatch(/if:/)
    expect(rendered).toBeLessThan(indexOf(steps, 'supabase config diff'))
    expect(rendered).toBeLessThan(indexOf(steps, 'supabase config push'))
  })

  it('and reads the project back after the push, as its last step', () => {
    const steps = stepsOf(read('.github/workflows/db-migrate.yml').replaceAll('\r\n', '\n'))
    const check = indexOf(steps, 'check-hosted-auth.mjs')
    expect(check).toBe(steps.length - 1)
    expect(check).toBeGreaterThan(indexOf(steps, 'supabase config push'))
    expect(steps[check]).not.toMatch(/^if:/)
  })

  it('the settings the CLI ignores are not left in the workflow to look as if they worked', () => {
    const workflow = read('.github/workflows/db-migrate.yml')
    expect(workflow).not.toMatch(/SUPABASE_AUTH_[A-Z_]*ENABLED/)
    expect(workflow).not.toMatch(/SUPABASE_AUTH_SITE_URL/)
  })

  it('a project that the push would open says so in the run', () => {
    const workflow = read('.github/workflows/db-migrate.yml')
    expect(workflow).toContain('CLOSED_SIGNUP')
    expect(workflow).toMatch(/::warning::.*sign-up/i)
  })
})
