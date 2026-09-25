import type { Tx } from '@bizcost/db'
import { can, isUuid, type SensitivityCategory } from '@bizcost/domain'
import { isModuleActive, moduleById, type ModuleId, type PermissionKey } from '@bizcost/modules'
import { initTRPC, type AnyRouter } from '@trpc/server'
import semver from 'semver'
import type { z } from 'zod'
import { loadBusinessAccess, type BusinessAccess } from './access'
import { memoized, type Context } from './context'
import { AppError, formatError, toAppError } from './errors'
import { redactionFailure, redactOutput } from './redact'
import { isDeletedAccount } from './services/profile'

// tRPC setup and the procedure bases (docs/ARCHITECTURE.md §API & request flow, §Permissions).
// Middleware order on every procedure:
//   mapErrors → appVersionGate → originCheck → [authed → openAccount | businessScoped] → redact
//   → [requireModule → requirePermission] → output validation → handler

const t = initTRPC.context<Context>().create({ errorFormatter: formatError })

export const router = t.router
export const createCallerFactory = t.createCallerFactory

/** Database failures become typed app errors (conflict, validation, forbidden). */
const mapErrors = t.middleware(async ({ next }) => {
  const result = await next()
  if (!result.ok) throw toAppError(result.error)
  return result
})

/** True when an app version (x-app-version) is still served. Malformed versions are not. */
export function isSupportedAppVersion(version: string, minimum: string): boolean {
  const parsed = semver.valid(version.trim())
  return parsed !== null && semver.gte(parsed, minimum)
}

/** Old mobile builds get a typed error and show the force-update screen. Web sends no header. */
const appVersionGate = t.middleware(({ ctx, next }) => {
  const version = ctx.req.headers.get('x-app-version')
  if (version !== null && !isSupportedAppVersion(version, ctx.config.minSupportedAppVersion)) {
    throw new AppError('app_version_unsupported')
  }
  return next()
})

/** True when the Origin header names one of the allowed origins exactly. */
export function isAllowedOrigin(origin: string | null, allowed: readonly string[]): boolean {
  if (origin === null || origin === 'null') return false
  let normalized: string
  try {
    normalized = new URL(origin).origin
  } catch {
    return false
  }
  return normalized === origin && allowed.includes(normalized)
}

/**
 * CSRF guard: a mutation authenticated by cookies (no Authorization header) must come from an allowed
 * origin. Bearer requests are exempt: a browser cannot add that header cross-site without CORS.
 */
const originCheck = t.middleware(({ ctx, type, next }) => {
  if (
    type === 'mutation' &&
    ctx.authMode === 'cookie' &&
    !isAllowedOrigin(ctx.req.headers.get('origin'), ctx.config.allowedOrigins)
  ) {
    throw new AppError('forbidden', { message: 'origin not allowed' })
  }
  return next()
})

/** Runs `fn` in withTenantTx as the caller, in the active business (ctx.tx). */
export type TenantTx = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>

/** Signed-in callers only. Adds ctx.auth (ctx.tenantTx is bound to the same verified caller). */
const authed = t.middleware(async ({ ctx, next }) => {
  const auth = await ctx.getAuth()
  if (!auth) throw new AppError('unauthorized')
  return next({ ctx: { auth } })
})

/**
 * Signed-in procedures outside a business also refuse a deleted account: its access token keeps a
 * valid signature until it expires, so the anonymized profile is checked (once per request).
 * Business procedures need no such check: deleting an account first removes every membership.
 */
const openAccount = authed.unstable_pipe(async ({ ctx, next }) => {
  const deleted = await memoized(ctx, 'deleted-account', () =>
    ctx.tenantTx(null, (tx) => isDeletedAccount(tx, ctx.auth.userId)),
  )
  if (deleted) throw new AppError('unauthorized')
  return next()
})

/**
 * Active members of the business named by x-business-id only. The membership is read from the DB on
 * every request, so a removed or suspended member is rejected on their next request. The same
 * FORBIDDEN answers "no such business" and "not a member". Adds ctx.businessId, ctx.access and
 * ctx.tx(fn); sends x-permissions-version so clients refetch `me`/context when it changes.
 */
const businessScoped = authed.unstable_pipe(async ({ ctx, next }) => {
  const header = ctx.req.headers.get('x-business-id')?.trim() ?? ''
  if (!isUuid(header)) {
    throw new AppError('validation', { message: 'x-business-id must be a UUID' })
  }
  const businessId = header.toLowerCase()
  const access = await memoized(ctx, `access:${businessId}`, () =>
    ctx.tenantTx(businessId, (tx) => loadBusinessAccess(tx, ctx.auth.userId, businessId)),
  )
  if (!access) throw new AppError('forbidden')
  ctx.resHeaders.set('x-permissions-version', String(access.permissionsVersion))
  const tx: TenantTx = (fn) => ctx.tenantTx(businessId, fn)
  return next({ ctx: { businessId, access, tx } })
})

/** The business access of a business procedure's context (undefined elsewhere). */
function accessOf(ctx: object): BusinessAccess | undefined {
  return 'access' in ctx ? (ctx.access as BusinessAccess) : undefined
}

function outputSchemaOf(procedureRouter: AnyRouter, path: string): z.core.$ZodType | undefined {
  const procedures = procedureRouter._def.procedures as Record<string, unknown>
  const output = (procedures[path] as { _def?: { output?: unknown } } | undefined)?._def?.output
  return typeof output === 'object' && output !== null && '_zod' in output
    ? (output as z.core.$ZodType)
    : undefined
}

/**
 * Applied to every procedure (contract test). It fails closed, before the handler runs: a procedure
 * without a Zod output schema, with an output the redactor cannot check (untyped values, misplaced
 * tags), or with sensitive fields outside a business procedure or outside withMeta(), is refused.
 * After output validation it removes the sensitive fields the member may not see and fills
 * meta.redacted.
 */
const redact = t.middleware(async ({ ctx, path, next }) => {
  const schema = outputSchemaOf(ctx.router, path)
  if (!schema) throw new AppError('internal', { message: `${path} has no Zod output schema` })
  const visible: ReadonlySet<SensitivityCategory> | null = accessOf(ctx)?.visibleCategories ?? null
  const failure = redactionFailure(schema, visible)
  if (failure) throw new AppError('internal', { message: `${path}: ${failure}` })
  const result = await next()
  if (!result.ok) return result
  const redacted = redactOutput(schema, result.data, visible)
  if (!redacted.ok) throw new AppError('internal', { message: `${path}: ${redacted.reason}` })
  return { ...result, data: redacted.value }
})

const base = t.procedure.use(mapErrors).use(appVersionGate).use(originCheck)

/** No sign-in required (health). Outputs must not contain sensitive fields. */
export const publicProcedure = base.use(redact)

/** Signed in (not a deleted account), outside any business (me, account.*). No sensitive fields. */
export const authedProcedure = base.use(openAccount).use(redact)

/** Signed in and an active member of the business in x-business-id. */
export const businessProcedure = base.use(businessScoped).use(redact)

/**
 * The module must be released and enabled for the business (MODULE_DISABLED otherwise). Core modules
 * are on unless switched off, Dashboard and Settings always (D-059). Use after businessProcedure.
 */
export function requireModule(id: ModuleId) {
  return t.middleware(({ ctx, next }) => {
    const access = accessOf(ctx)
    if (!access) throw new AppError('internal', { message: 'requireModule outside a business' })
    const manifest = moduleById(id)
    if (!manifest || !isModuleActive(manifest, access.enabledModules)) {
      throw new AppError('module_disabled')
    }
    return next()
  })
}

/** The member must hold the permission (FORBIDDEN otherwise). Use after businessProcedure. */
export function requirePermission(key: PermissionKey) {
  return t.middleware(({ ctx, next }) => {
    const access = accessOf(ctx)
    if (!access) throw new AppError('internal', { message: 'requirePermission outside a business' })
    if (!can(access.effective, key)) throw new AppError('forbidden')
    return next()
  })
}

/** A field a list procedure filters, sorts, groups, searches or exports on. */
export interface QueryField {
  readonly name: string
  /** Sensitivity category of the field, when it has one. */
  readonly category?: SensitivityCategory
}

/**
 * Querying on a field the member cannot see is FORBIDDEN, never silently ignored: a filter or sort on a
 * hidden cost would reveal it (docs/ARCHITECTURE.md §Permissions, Redaction).
 */
export function assertQueryable(
  ctx: { readonly access: BusinessAccess },
  fields: readonly QueryField[],
): void {
  for (const field of fields) {
    if (field.category !== undefined && !ctx.access.visibleCategories.has(field.category)) {
      throw new AppError('forbidden', { message: `cannot query on ${field.name}` })
    }
  }
}

/** Middleware identities for the contract tests (every procedure is redacted, sensitive ones scoped). */
export const middlewareMarkers: {
  readonly redact: unknown
  readonly authed: unknown
  readonly businessScoped: unknown
} = {
  redact: redact._middlewares[0],
  authed: authed._middlewares[0],
  businessScoped: businessScoped._middlewares.at(-1),
}
