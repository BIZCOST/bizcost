import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODULES, ROLE_TEMPLATES } from '@bizcost/modules'
import { describe, expect, it } from 'vitest'

// The Reports keys of M3 Step 3 (the plan's Q10 table): new businesses get them from the role
// templates (role-templates.ts), the roles that existed got them from the reports_access migration
// (D-124's way). Both must give each template the same keys.

const migrations = fileURLToPath(new URL('../../../../supabase/migrations/', import.meta.url))

function migration(): string {
  const file = readdirSync(migrations).find((name) => name.endsWith('_reports_access.sql'))
  if (!file) throw new Error('migration reports_access not found')
  return readFileSync(join(migrations, file), 'utf8')
}

describe('the Reports keys of the role templates', () => {
  it('the migration gave the roles made before the same Reports keys as the templates', () => {
    const sql = migration()
    const pairs = [...sql.matchAll(/\('(\w+)', '(reports\.[\w.]+)'\)/g)].map(
      ([, template, key]) => `${template} ${key}`,
    )
    const reportsKeys = MODULES.find((m) => m.id === 'reports')!.permissionKeys as readonly string[]
    const expected = ROLE_TEMPLATES.filter((t) => !t.allPermissions).flatMap((t) =>
      t.permissionKeys.filter((key) => reportsKeys.includes(key)).map((key) => `${t.key} ${key}`),
    )
    expect(pairs.sort()).toEqual(expected.sort())
  })
})
