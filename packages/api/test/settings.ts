import { businessMembers, roles, withTenantTx, type Db } from '@bizcost/db'
import { newId } from '@bizcost/domain'
import { QUESTION_SET_VERSION, type RoleTemplateKey, type SetupAnswers } from '@bizcost/modules'
import { and, eq, isNull } from 'drizzle-orm'
import { expect } from 'vitest'
import type { EmailMessage, EmailSender } from '../src'
import { mutate, tenant, type CallResult, type TestUser } from './helpers'

// Helpers of the settings tests (ROADMAP.md Step 6): businesses made by Smart Setup through the API,
// members that hold the business's own template roles, and a sender that keeps the emails.

type Handler = (req: Request) => Promise<Response>

/** Workshop with a team, branches, stock, machines and VAT (every capability on). */
export const WORKSHOP: SetupAnswers = {
  what_you_do: ['make_products'],
  how_you_make: ['custom_jobs'],
  workplace: 'workshop',
  branches: true,
  team: 'team',
  team_tracking: ['hours', 'salaries', 'staff_cash'],
  work_setup: ['stock', 'machines', 'vehicles'],
  sales_channels: ['messages', 'quotes'],
  vat: 'yes',
}

/** Solo home baker: no team, one location, no VAT. */
export const BAKER: SetupAnswers = {
  what_you_do: ['food_drinks'],
  workplace: 'home',
  team: 'alone',
  work_setup: ['none'],
  sales_channels: ['messages'],
  vat: 'no',
}

export function appCode(result: CallResult): string | undefined {
  return result.error?.data.appCode
}

/** Creates a business through Smart Setup's confirm step, as `token`'s user. */
export async function setupBusiness(
  handler: Handler,
  token: string,
  answers: SetupAnswers,
  options: { name?: string; locale?: 'en' | 'ar' } = {},
): Promise<string> {
  const businessId = newId()
  const result = await mutate(handler, 'business.createFromSetup', {
    token,
    input: {
      businessId,
      legalName: options.name ?? 'Test Workshop',
      locale: options.locale ?? 'en',
      questionSetVersion: QUESTION_SET_VERSION,
      answers,
      adjustments: { modules: [], capabilities: [] },
    },
  })
  expect(result.error).toBeUndefined()
  return businessId
}

/** The id of the business's role copied from a template (Smart Setup made one of each). */
export async function templateRoleId(
  db: Db,
  owner: TestUser,
  businessId: string,
  template: RoleTemplateKey,
): Promise<string> {
  const [role] = await withTenantTx(db, tenant(owner.id, businessId), (tx) =>
    tx
      .select({ id: roles.id })
      .from(roles)
      .where(
        and(
          eq(roles.businessId, businessId),
          eq(roles.templateKey, template),
          isNull(roles.deletedAt),
        ),
      ),
  )
  if (!role) throw new Error(`no ${template} role`)
  return role.id
}

/** Adds `user` as an active member with the business's `template` role (as the owner, like an accepted invitation). */
export async function join(
  db: Db,
  owner: TestUser,
  businessId: string,
  user: TestUser,
  template: RoleTemplateKey,
): Promise<string> {
  const roleId = await templateRoleId(db, owner, businessId, template)
  const memberId = newId()
  await withTenantTx(db, tenant(owner.id, businessId), (tx) =>
    tx.insert(businessMembers).values({
      id: memberId,
      businessId,
      userId: user.id,
      kind: 'account',
      displayName: user.email.split('@')[0] ?? 'member',
      email: user.email,
      status: 'active',
      roleId,
    }),
  )
  return memberId
}

/** Keeps every email instead of sending it; `failNext` makes the next send fail. */
export class CapturedEmails implements EmailSender {
  readonly sent: EmailMessage[] = []
  failNext = false

  send(message: EmailMessage): Promise<void> {
    if (this.failNext) {
      this.failNext = false
      return Promise.reject(new Error('smtp down'))
    }
    this.sent.push(message)
    return Promise.resolve()
  }

  to(address: string): EmailMessage[] {
    return this.sent.filter((m) => m.to === address.toLowerCase())
  }

  /** The token of the newest invitation link sent to `address`. */
  tokenFor(address: string): string {
    const message = this.to(address).at(-1)
    const token = message && /\/invite\/([A-Za-z0-9_-]{43})/.exec(message.text)?.[1]
    if (!token) throw new Error(`no invitation link sent to ${address}`)
    return token
  }
}

/** A token of the right shape that was never issued. */
export function randomToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
}
