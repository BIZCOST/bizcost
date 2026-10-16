import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ROLE_TEMPLATES } from '@bizcost/modules'
import { describe, expect, it } from 'vitest'

// Release A (M3 Step 6): the keys of Sales, Orders, Customers, Payments and Reports are final, and the
// migration sales_release states their template defaults once more for the roles businesses already
// have. Its pairs must be the templates' own (role-templates.ts in @bizcost/modules), or a business
// made before the release would hold other keys than one made after it.

const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations/', import.meta.url))
const RELEASED = ['sales', 'orders', 'customers', 'payments', 'reports']

function migrationPairs(): string[] {
  const [file] = readdirSync(MIGRATIONS).filter((name) => name.endsWith('_sales_release.sql'))
  if (!file) throw new Error('no sales_release migration')
  const sql = readFileSync(`${MIGRATIONS}${file}`, 'utf8')
  return [...sql.matchAll(/\('([a-z_]+)', '([a-z_.]+)'\)/g)].map(
    ([, role, key]) => `${role} ${key}`,
  )
}

describe('the release migration (sales_release)', () => {
  it('states exactly the templates’ defaults of the released modules’ keys', () => {
    const fromTemplates = ROLE_TEMPLATES.filter((t) => !t.allPermissions).flatMap((template) =>
      template.permissionKeys
        .filter((key) => RELEASED.includes(key.split('.')[0]!))
        .map((key) => `${template.key} ${key}`),
    )
    expect(migrationPairs().sort()).toEqual(fromTemplates.sort())
  })
})
