import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ROLE_TEMPLATES } from '@bizcost/modules'
import { describe, expect, it } from 'vitest'

// Each release states the template defaults of the modules it releases once more for the roles
// businesses already have: Release A (M3 Step 6) the keys of Sales, Orders, Customers, Payments and
// Reports (migration sales_release), Release B (M3 Step 9) those of Quotations and Invoices and
// "Manage documents" (Settings → Documents, migration documents_release). Their pairs must be the
// templates' own (role-templates.ts in @bizcost/modules), or a business made before the release would
// hold other keys than one made after it.

const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations/', import.meta.url))

function migrationPairs(name: string): string[] {
  const [file] = readdirSync(MIGRATIONS).filter((file) => file.endsWith(`_${name}.sql`))
  if (!file) throw new Error(`no ${name} migration`)
  const sql = readFileSync(`${MIGRATIONS}${file}`, 'utf8')
  return [...sql.matchAll(/\('([a-z_]+)', '([a-z_.]+)'\)/g)].map(
    ([, role, key]) => `${role} ${key}`,
  )
}

/** The templates' (role, key) pairs of the keys `released` says. */
function templatePairs(released: (key: string) => boolean): string[] {
  return ROLE_TEMPLATES.filter((t) => !t.allPermissions).flatMap((template) =>
    template.permissionKeys.filter(released).map((key) => `${template.key} ${key}`),
  )
}

const moduleOf = (key: string) => key.split('.')[0]!

describe('the release migrations', () => {
  it('sales_release states exactly the templates’ defaults of Release A’s keys', () => {
    const RELEASE_A = ['sales', 'orders', 'customers', 'payments', 'reports']
    expect(migrationPairs('sales_release').sort()).toEqual(
      templatePairs((key) => RELEASE_A.includes(moduleOf(key))).sort(),
    )
  })

  it('documents_release states exactly the templates’ defaults of Release B’s keys', () => {
    const RELEASE_B = ['quotations', 'invoices']
    const pairs = templatePairs(
      (key) => RELEASE_B.includes(moduleOf(key)) || key === 'settings.documents.manage',
    )
    expect(migrationPairs('documents_release').sort()).toEqual(pairs.sort())
    // The Owner holds every key without rows; the Admin every key; Sales prepares but never issues.
    expect(pairs).toContain('admin settings.documents.manage')
    expect(pairs).toContain('sales invoices.documents.manage')
    expect(pairs).not.toContain('sales invoices.documents.issue')
  })
})
