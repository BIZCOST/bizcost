import { sensitive, zDecimal } from '@bizcost/contracts'
import { SENSITIVITY_CATEGORIES, type SensitivityCategory } from '@bizcost/domain'
import type { RoleTemplateKey } from '@bizcost/modules'
import { z } from 'zod'

// The redaction oracle (docs/ARCHITECTURE.md §Permissions, Redaction; ROADMAP.md M1 definition of
// done): the sensitivity categories each starter role template may see, written out by hand from
// PRODUCT.md §8 (not computed by the permission engine it checks), and a test item with a value in
// every category. Used by business.api.test.ts and hardening/redaction-oracle.api.test.ts.

export const VISIBLE_TO: Record<RoleTemplateKey, SensitivityCategory[]> = {
  owner: [...SENSITIVITY_CATEGORIES],
  admin: [...SENSITIVITY_CATEGORIES],
  manager: ['cost', 'profit_margin', 'supplier_price'],
  accountant: ['cost', 'profit_margin', 'supplier_price', 'payroll'],
  sales: [],
  supervisor: [],
  employee: [],
}

const lineDto = z.object({
  qty: zDecimal,
  unitCost: sensitive(zDecimal, 'cost'),
  supplierPrice: sensitive(zDecimal, 'supplier_price'),
})

/** An output with a field in every sensitivity category, nested in an object and an array. */
export const itemDto = z.object({
  name: z.string(),
  price: zDecimal,
  cost: sensitive(zDecimal, 'cost'),
  margin: sensitive(zDecimal, 'profit_margin'),
  lines: z.array(lineDto),
  staff: z.object({
    name: z.string(),
    salary: sensitive(zDecimal, 'payroll'),
    phone: sensitive(z.string(), 'employee_pii'),
  }),
})

export const item = {
  name: 'Latte',
  price: '18',
  cost: '6.5',
  margin: '0.6389',
  lines: [{ qty: '0.02', unitCost: '120', supplierPrice: '110' }],
  staff: { name: 'Sara', salary: '4200', phone: '+971500000001' },
}

/** The schema paths of each category in `itemDto`. */
export const PATHS_OF: Record<SensitivityCategory, string[]> = {
  cost: ['cost', 'lines.*.unitCost'],
  profit_margin: ['margin'],
  supplier_price: ['lines.*.supplierPrice'],
  payroll: ['staff.salary'],
  employee_pii: ['staff.phone'],
}

/** The values of each category in `item`. */
export const VALUES_OF: Record<SensitivityCategory, string[]> = {
  cost: ['6.5', '120'],
  profit_margin: ['0.6389'],
  supplier_price: ['110'],
  payroll: ['4200'],
  employee_pii: ['+971500000001'],
}
