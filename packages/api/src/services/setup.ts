import { createHash } from 'node:crypto'
import type { CreateFromSetupDto, CreateFromSetupInput } from '@bizcost/contracts'
import {
  businessCapabilities,
  businesses,
  businessModules,
  locations,
  profiles,
  rolePermissions,
  roles,
  setupAnswers,
  type Tx,
} from '@bizcost/db'
import { newId, OWNER_TEMPLATE_KEY, type Locale } from '@bizcost/domain'
import { createI18n, type I18nKey } from '@bizcost/i18n'
import {
  applyAdjustments,
  CAPABILITY_KEYS,
  locationNameKey,
  MODULE_IDS,
  parseSetupAnswers,
  QUESTION_SET_VERSION,
  recommend,
  ROLE_TEMPLATES,
  setupModuleRows,
  STORED_CAPABILITY_KEYS,
  type Recommendation,
  type SetupAdjustments,
  type SetupAnswers,
  type SetupState,
} from '@bizcost/modules'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { AuthUser } from '../auth'
import type { Context } from '../context'
import { AppError, sqlStateOf } from '../errors'
import { defaultDisplayName, ensureProfile } from './profile'

// Smart Setup's confirm step (docs/PRODUCT.md §6, ROADMAP.md Step 5): creates a business from the
// answers. The server recomputes recommend() from the answers and applies the review adjustments
// itself; nothing the client computed is trusted.

interface Setup {
  readonly businessId: string
  readonly legalName: string
  readonly locale: Locale
  readonly answers: SetupAnswers
  readonly recommendation: Recommendation
  readonly state: SetupState
  readonly requestHash: string
}

function invalid(what: string, issue: string, item?: string): AppError {
  return new AppError('validation', { message: `${what}: ${issue}${item ? ` (${item})` : ''}` })
}

/** Adjustments in a fixed order, so the same review gives the same fingerprint. */
function canonicalAdjustments(adj: SetupAdjustments): SetupAdjustments {
  const rank = (list: readonly string[], id: string) => list.indexOf(id)
  return {
    modules: [...adj.modules]
      .sort((a, b) => rank(MODULE_IDS, a.id) - rank(MODULE_IDS, b.id))
      .map(({ id, enabled }) => ({ id, enabled })),
    capabilities: [...adj.capabilities]
      .sort((a, b) => rank(CAPABILITY_KEYS, a.key) - rank(CAPABILITY_KEYS, b.key))
      .map(({ key, enabled }) => ({ key, enabled })),
  }
}

/** Checks the input against the question set and the review rules (VALIDATION otherwise). */
function planSetup(input: CreateFromSetupInput): Setup {
  if (input.questionSetVersion !== QUESTION_SET_VERSION) {
    throw invalid('questionSetVersion', 'unsupported', String(input.questionSetVersion))
  }
  const parsed = parseSetupAnswers(input.answers)
  if (!parsed.ok) throw invalid('answers', parsed.issue, parsed.question)
  const recommendation = recommend(parsed.answers)
  const adjusted = applyAdjustments(recommendation, input.adjustments)
  if (!adjusted.ok) throw invalid('adjustments', adjusted.issue, adjusted.item)
  // The fingerprint of an idempotent retry: the canonical payload (multi answers in option order).
  const requestHash = createHash('sha256')
    .update(
      JSON.stringify({
        questionSetVersion: input.questionSetVersion,
        legalName: input.legalName,
        locale: input.locale,
        answers: parsed.answers,
        adjustments: canonicalAdjustments(input.adjustments),
      }),
    )
    .digest('hex')
  return {
    businessId: input.businessId,
    legalName: input.legalName,
    locale: input.locale,
    answers: parsed.answers,
    recommendation,
    state: adjusted.state,
    requestHash,
  }
}

/** request_hash of the setup already saved for this business, if the caller can see it. */
async function savedSetupHash(
  ctx: Context,
  businessId: string,
): Promise<string | null | undefined> {
  const [row] = await ctx.tenantTx(businessId, (tx) =>
    tx
      .select({ requestHash: setupAnswers.requestHash })
      .from(setupAnswers)
      .where(and(eq(setupAnswers.businessId, businessId), isNull(setupAnswers.deletedAt)))
      .limit(1),
  )
  return row?.requestHash
}

/** Writes everything in the business's tenant context (one transaction). */
async function writeSetup(tx: Tx, auth: AuthUser, setup: Setup): Promise<void> {
  const { businessId: id, recommendation: rec, state, locale } = setup
  const i18n = createI18n({ locale, namespaces: ['setup'] })
  const text = (key: I18nKey) => i18n.t(key)

  await ensureProfile(tx, auth)
  const [profile] = await tx
    .select({ displayName: profiles.displayName })
    .from(profiles)
    .where(eq(profiles.id, auth.userId))
  const ownerName = profile?.displayName?.trim() || defaultDisplayName(auth.email)

  // The business, its Owner role and the caller's Owner membership; at most 10 per user a day
  // (SQLSTATE BZ429 → rate_limited). An id taken by another business is 23505 → conflict.
  const ownerRoleId = newId()
  await tx.execute(
    sql`select app.create_business(${id}, ${setup.legalName}, ${locale}, ${ownerName}, ${ownerRoleId}, ${newId()})`,
  )
  await tx
    .update(businesses)
    .set({
      businessType: rec.businessType,
      terminologyProfile: rec.terminologyProfile,
      vatRegistered: state.vatRegistered,
      setupCompletedAt: sql`now()`,
    })
    .where(eq(businesses.id, id))

  await tx.insert(setupAnswers).values({
    id: newId(),
    businessId: id,
    questionSetVersion: QUESTION_SET_VERSION,
    answers: setup.answers as Record<string, unknown>,
    requestHash: setup.requestHash,
  })

  // Every stored capability gets a row; one the review changed is marked as the user's choice.
  await tx.insert(businessCapabilities).values(
    STORED_CAPABILITY_KEYS.map((key) => ({
      id: newId(),
      businessId: id,
      key,
      enabled: state.capabilities[key],
      source:
        state.capabilities[key] === rec.capabilities[key] ? ('setup' as const) : ('user' as const),
    })),
  )

  // D-059: optional modules on and core modules off; no other rows.
  const moduleRows = setupModuleRows(state)
  if (moduleRows.length > 0) {
    await tx.insert(businessModules).values(
      moduleRows.map((row) => ({
        id: newId(),
        businessId: id,
        moduleKey: row.moduleKey,
        enabled: row.enabled,
        enabledAt: sql`now()`,
        enabledBy: auth.userId,
      })),
    )
  }

  // The default location, named in the user's language (then it is plain data).
  const workplace = setup.answers.workplace ?? 'home'
  await tx.insert(locations).values({
    id: newId(),
    businessId: id,
    name: text(locationNameKey(workplace, state.capabilities.multi_location)),
    isDefault: true,
  })

  // Editable copies of the role templates, named in the user's language. The Owner role exists
  // already (create_business); its permissions are implicit.
  await tx
    .update(roles)
    .set({ name: text('common.roles.owner') })
    .where(and(eq(roles.businessId, id), eq(roles.id, ownerRoleId)))
  for (const template of ROLE_TEMPLATES) {
    if (template.key === OWNER_TEMPLATE_KEY) continue
    const roleId = newId()
    await tx.insert(roles).values({
      id: roleId,
      businessId: id,
      name: text(`common.roles.${template.key}` as I18nKey),
      templateKey: template.key,
    })
    if (template.permissionKeys.length > 0) {
      await tx.insert(rolePermissions).values(
        template.permissionKeys.map((permissionKey) => ({
          id: newId(),
          businessId: id,
          roleId,
          permissionKey,
        })),
      )
    }
  }

  // Where to go after the next sign-in.
  await tx
    .update(profiles)
    .set({ lastBusinessId: id })
    .where(and(eq(profiles.id, auth.userId), isNull(profiles.anonymizedAt)))
}

/**
 * `business.createFromSetup`: validates the answers strictly (parseSetupAnswers), recomputes
 * recommend(), applies the review adjustments within their rules (applyAdjustments), then in ONE
 * transaction creates the business with its Owner membership and writes the business type, wording,
 * VAT status, setup answers, capabilities, module rows, default location and roles, and makes it the
 * caller's last business.
 *
 * Idempotent on businessId: the same payload again returns the same business (also when two
 * identical requests race); another payload, or an id of a business the caller cannot see, is
 * CONFLICT.
 */
export async function createFromSetup(
  ctx: Context,
  auth: AuthUser,
  input: CreateFromSetupInput,
): Promise<CreateFromSetupDto> {
  const setup = planSetup(input)
  const same = async () => {
    const saved = await savedSetupHash(ctx, setup.businessId)
    if (saved === undefined) return false
    if (saved === setup.requestHash) return true
    throw new AppError('conflict', { message: 'this business was set up with other answers' })
  }
  if (await same()) return { businessId: setup.businessId }
  try {
    await ctx.tenantTx(setup.businessId, (tx) => writeSetup(tx, auth, setup))
  } catch (error) {
    // A concurrent identical request may have created it first: the id is then taken (23505), or,
    // for the last business the daily limit allows, that business already counts (BZ429).
    const state = sqlStateOf(error)
    if ((state === '23505' || state === 'BZ429') && (await same())) {
      return { businessId: setup.businessId }
    }
    throw error
  }
  return { businessId: setup.businessId }
}
