import type {
  BusinessProfileDto,
  InvitationDto,
  LocationDto,
  MeDto,
  MemberDto,
  RoleDto,
} from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { NO_ADJUSTMENTS, QUESTION_SET_VERSION } from '@bizcost/modules'
import { DemoApi } from './client'
import { seedCosting, type CostingResult, type CostingSummary } from './costing'
import {
  DEMO_PASSWORD,
  DEMO_PERSONAS,
  type DemoPerson,
  type DemoPersona,
  type DemoTeamMember,
} from './personas'

// `pnpm demo:seed`: the local demo businesses of demo/personas.ts, on the current local database
// (no reset). Idempotent: what exists is kept, what is missing is added, and every demo account's
// password is set back to the demo password. Each business is created by Smart Setup's real confirm
// step (business.createFromSetup), and members join through real invitations. Then each business gets
// its Costing Core data (demo/costing.ts): suppliers, materials, products, recipes, posted purchases,
// returns, payments, running costs and expenses, and (M3 Step 2, previewed) its sales channels and
// sales, through the same API.

interface Row {
  business: string
  email: string
  role: string
  state: string
}

/** The account, its token, and its profile name and language as the persona has them. */
async function signedIn(api: DemoApi, person: DemoPerson) {
  const user = await api.ensureUser(person)
  const token = await api.token(user, person.locale)
  const me = await api.query<MeDto>('me', token)
  if (me.profile.displayName !== person.name || me.profile.locale !== person.locale) {
    await api.mutate('account.updateProfile', token, undefined, {
      displayName: person.name,
      locale: person.locale,
    })
  }
  return { user, token, me }
}

async function ensureBusiness(api: DemoApi, persona: DemoPersona, token: string, me: MeDto) {
  const existing = me.memberships.find(
    (m) => m.legalName === persona.legalName && m.roleTemplateKey === 'owner',
  )
  if (existing) return { businessId: existing.businessId, created: false }
  const businessId = newId()
  await api.mutate('business.createFromSetup', token, undefined, {
    businessId,
    legalName: persona.legalName,
    locale: persona.owner.locale,
    questionSetVersion: QUESTION_SET_VERSION,
    answers: persona.answers,
    adjustments: persona.adjustments ?? NO_ADJUSTMENTS,
  })
  return { businessId, created: true }
}

/** The Arabic legal name and the TRN, in Settings → Business profile. */
async function ensureProfile(
  api: DemoApi,
  persona: DemoPersona,
  token: string,
  businessId: string,
) {
  const profile = await api.query<BusinessProfileDto>('business.profile', token, businessId)
  if (profile.legalNameAr === persona.legalNameAr && profile.trn === persona.trn) return
  await api.mutate('business.updateProfile', token, businessId, {
    version: profile.version,
    legalName: profile.legalName,
    legalNameAr: persona.legalNameAr,
    vatRegistered: profile.vatRegistered,
    trn: persona.trn,
  })
}

async function ensureBranches(
  api: DemoApi,
  persona: DemoPersona,
  token: string,
  businessId: string,
) {
  if (!persona.branches?.length) return
  const locations = await api.query<LocationDto[]>('location.list', token, businessId)
  for (const name of persona.branches) {
    if (locations.some((l) => l.name === name)) continue
    await api.mutate('location.create', token, businessId, { id: newId(), name })
  }
}

/** A team member: already a member, joins through an invitation, or keeps a pending invitation. */
async function ensureMember(
  api: DemoApi,
  context: { token: string; businessId: string; roles: RoleDto[] },
  state: { members: MemberDto[]; invitations: InvitationDto[] },
  member: DemoTeamMember,
): Promise<string> {
  const { token, businessId } = context
  const address = member.email.toLowerCase()
  if (state.members.some((m) => m.email?.toLowerCase() === address && m.status === 'active')) {
    return 'member'
  }
  const pending = state.invitations.find((i) => i.email.toLowerCase() === address)
  // Only a live invitation's link (in Mailpit) still works; an expired one is sent again below.
  if (!member.joined && pending?.status === 'pending') return 'invited'

  // The name co-members see is copied from the profile when the invitation is accepted.
  const memberToken = member.joined ? (await signedIn(api, member)).token : undefined
  const role = context.roles.find((r) => r.templateKey === member.role)
  if (!role) throw new Error(`no ${member.role} role`)
  if (pending && pending.resendsLeft > 0) {
    // A new link that works for 7 more days (also for an expired invitation).
    await api.mutate('invitation.resend', token, businessId, { id: pending.id })
  } else {
    // No resend left: cancel it and invite again (the per-address limit allows 4 emails a day).
    if (pending) await api.mutate('invitation.revoke', token, businessId, { id: pending.id })
    await api.mutate('invitation.create', token, businessId, {
      id: newId(),
      email: address,
      roleId: role.id,
      locale: member.locale,
    })
  }
  if (!memberToken) return pending ? 'renewed' : 'invited'
  await api.mutate('invitation.accept', memberToken, undefined, {
    token: api.mail.inviteToken(address),
  })
  return 'joined'
}

async function ensureTeam(api: DemoApi, persona: DemoPersona, token: string, businessId: string) {
  const rows: Row[] = []
  if (!persona.team?.length) return rows
  const context = {
    token,
    businessId,
    roles: await api.query<RoleDto[]>('role.list', token, businessId),
  }
  const state = {
    members: await api.query<MemberDto[]>('member.list', token, businessId),
    invitations: await api.query<InvitationDto[]>('invitation.list', token, businessId),
  }
  for (const member of persona.team) {
    const result = await ensureMember(api, context, state, member)
    rows.push({
      business: persona.legalNameAr,
      email: member.email,
      role: member.role,
      state:
        result === 'invited'
          ? 'invitation pending (email in Mailpit)'
          : result === 'renewed'
            ? 'invitation had expired: sent again (new email in Mailpit)'
            : result,
    })
  }
  return rows
}

/** Its suppliers, materials, products, purchases, running costs, expenses… (M2). */
function ensureCosting(api: DemoApi, persona: DemoPersona, token: string, businessId: string) {
  if (!persona.costing) return undefined
  return seedCosting(
    {
      api,
      token,
      businessId,
      label: persona.legalNameAr,
      locale: persona.owner.locale,
      tokenOf: async (email) => {
        const member = persona.team?.find((m) => m.email === email && m.joined)
        if (!member) throw new Error(`${email} is not a member who joined`)
        return (await signedIn(api, member)).token
      },
    },
    persona.costing,
  )
}

async function seedPersona(
  api: DemoApi,
  persona: DemoPersona,
): Promise<{ rows: Row[]; costing?: CostingResult }> {
  const { user, token, me } = await signedIn(api, persona.owner)
  const { businessId, created } = await ensureBusiness(api, persona, token, me)
  await ensureProfile(api, persona, token, businessId)
  await ensureBranches(api, persona, token, businessId)
  const owner: Row = {
    business: persona.legalNameAr,
    email: user.email,
    role: `owner · ${persona.title}`,
    state: created ? 'created' : 'exists',
  }
  const rows = [owner, ...(await ensureTeam(api, persona, token, businessId))]
  return { rows, costing: await ensureCosting(api, persona, token, businessId) }
}

function printTable<K extends string>(columns: readonly [K, string][], rows: Record<K, string>[]) {
  const width = ([key, title]: [K, string]) =>
    Math.max(title.length, ...rows.map((r) => r[key].length))
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => cell.padEnd(width(columns[i]!)))
      .join('  ')
      .trimEnd()
  console.log(line(columns.map(([, title]) => title)))
  console.log(columns.map((column) => '-'.repeat(width(column))).join('  '))
  for (const row of rows) console.log(line(columns.map(([key]) => row[key])))
}

const ACCOUNT_COLUMNS: [keyof Row, string][] = [
  ['email', 'email'],
  ['role', 'role'],
  ['state', 'state'],
  ['business', 'business'],
]

const COSTING_COLUMNS: [keyof CostingSummary, string][] = [
  ['business', 'business'],
  ['materials', 'materials'],
  ['products', 'products'],
  ['purchases', 'posted purchases'],
  ['runningCosts', 'running costs'],
  ['expenses', 'final expenses'],
  ['sales', 'finalized sales'],
]

async function main() {
  const api = await DemoApi.open()
  try {
    const rows: Row[] = []
    const costing: CostingResult[] = []
    for (const persona of DEMO_PERSONAS) {
      process.stdout.write(`… ${persona.title}\n`)
      const seeded = await seedPersona(api, persona)
      rows.push(...seeded.rows)
      if (seeded.costing) costing.push(seeded.costing)
    }
    console.log('')
    printTable(ACCOUNT_COLUMNS, rows)
    console.log('')
    printTable(
      COSTING_COLUMNS,
      costing.map((c) => c.summary),
    )
    const notes = costing.flatMap((c) => c.notes)
    const warnings = costing.flatMap((c) => c.warnings)
    if (notes.length > 0) console.log(['', ...notes.map((n) => `· ${n}`)].join('\n'))
    if (warnings.length > 0) {
      console.log(['', 'Not written:', ...warnings.map((w) => `✗ ${w}`)].join('\n'))
      process.exitCode = 1
    }
    console.log('')
    console.log(`Password of every demo account: ${DEMO_PASSWORD}`)
    console.log('Sign in at http://localhost:3000/login (your dev server).')
    console.log(`Invitation emails: ${api.stack.mailpitUrl}`)
    console.log('Remove the demo accounts and their businesses: pnpm demo:reset')
  } finally {
    await api.close()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
