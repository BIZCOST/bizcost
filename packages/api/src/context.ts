import { withAnonymousTx, withTenantTx, type Tx } from '@bizcost/db'
import { newId } from '@bizcost/domain'
import { MODULES, withPreviewModules, type ModuleManifest } from '@bizcost/modules'
import type { AnyRouter } from '@trpc/server'
import { authModeOf, resolveAuth, type AuthMode, type AuthUser } from './auth'
import type { ApiConfig, ApiDeps } from './deps'
import { emailSenderFor, type EmailSender } from './email/sender'
import { AppError } from './errors'

/**
 * Runs `fn` in withTenantTx as the verified caller, in `businessId` (null: outside any business). The
 * user and request id are bound here, so a procedure cannot act as someone else, and the raw pool is
 * never on the context: this is the only way procedures reach the database.
 */
export type CallerTx = <T>(businessId: string | null, fn: (tx: Tx) => Promise<T>) => Promise<T>

/** Per-request context shared by every procedure of one HTTP request (a batch shares it too). */
export interface Context {
  readonly req: Request
  /** Headers added to the response (x-request-id, x-permissions-version, refreshed auth cookies). */
  readonly resHeaders: Headers
  /** UUIDv7 of this request; recorded on every audit_log row it causes and sent as x-request-id. */
  readonly requestId: string
  /** The router being served; the redact middleware reads each procedure's output schema from it. */
  readonly router: AnyRouter
  readonly config: ApiConfig
  /**
   * The module registry this server runs with: the manifests as released code has them, or, in
   * development and test only, with the preview modules counted as released (moduleRegistry, D-125).
   * The module gates and the nav read it; nothing else does.
   */
  readonly modules: readonly ModuleManifest[]
  readonly authMode: AuthMode
  /** Verifies the caller once per request, on first use (public procedures never call it). */
  readonly getAuth: () => Promise<AuthUser | null>
  /** withTenantTx as the verified caller (UNAUTHORIZED without a session). */
  readonly tenantTx: CallerTx
  /**
   * A transaction with no user and no business, for signed-out callers of public procedures: RLS
   * shows nothing; only definer functions made for anonymous callers work (app.preview_invitation).
   */
  readonly anonymousTx: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>
  /** Sends the API's own emails (invitations). */
  readonly email: EmailSender
  /** Per-request memo for work shared by the calls of a batch (e.g. loading business access). */
  readonly memo: Map<string, Promise<unknown>>
  /** Reports an unexpected failure the request goes on without (e.g. logos Storage did not sign). */
  readonly reportError: (error: unknown) => void
}

/** NODE_ENV values in which the preview switch is honoured (D-125): never production, never unset. */
const PREVIEW_ENVIRONMENTS: ReadonlySet<string> = new Set(['development', 'test'])

/**
 * The module registry for a server config: MODULES, unless the config names preview modules AND
 * NODE_ENV is development or test (`next dev`, Vitest). `next build`/`next start` and Vercel run with
 * NODE_ENV=production, so a production server never shows an unreleased module, whatever its
 * environment says (the web app also refuses to read BIZCOST_PREVIEW_MODULES there).
 */
export function moduleRegistry(
  config: Pick<ApiConfig, 'previewModules'>,
  nodeEnv: string | undefined,
): readonly ModuleManifest[] {
  const preview = config.previewModules ?? []
  if (preview.length === 0 || nodeEnv === undefined || !PREVIEW_ENVIRONMENTS.has(nodeEnv)) {
    return MODULES
  }
  return withPreviewModules(preview)
}

export interface CreateContextOptions {
  req: Request
  resHeaders: Headers
  deps: ApiDeps
  /** The router being served (appRouter, or a test router that extends it). */
  router: AnyRouter
}

/**
 * The context of one request. The fetch handler calls it for HTTP; a server-side caller (e.g. the
 * web app's RSC caller, Step 3) calls it with the incoming request, its own response headers, the same
 * deps and appRouter, then createCallerFactory(appRouter)(ctx).
 */
export function createContext({ req, resHeaders, deps, router }: CreateContextOptions): Context {
  const requestId = newId()
  resHeaders.set('x-request-id', requestId)
  let auth: Promise<AuthUser | null> | undefined
  const getAuth = () => (auth ??= resolveAuth(req, resHeaders, deps.config))
  const tenantTx: CallerTx = async (businessId, fn) => {
    const caller = await getAuth()
    if (!caller) throw new AppError('unauthorized')
    return withTenantTx(deps.db, { userId: caller.userId, businessId, requestId }, fn)
  }
  const anonymousTx = <T>(fn: (tx: Tx) => Promise<T>) => withAnonymousTx(deps.db, { requestId }, fn)
  return {
    req,
    resHeaders,
    requestId,
    router,
    config: deps.config,
    modules: moduleRegistry(deps.config, process.env.NODE_ENV),
    authMode: authModeOf(req),
    getAuth,
    tenantTx,
    anonymousTx,
    email: deps.emailSender ?? emailSenderFor(deps.config.email),
    memo: new Map(),
    reportError: (error) => deps.reportError?.(error, { requestId }),
  }
}

/** Runs `load` once per request for a key; the calls of a batch share the result. */
export function memoized<T>(ctx: Context, key: string, load: () => Promise<T>): Promise<T> {
  let entry = ctx.memo.get(key) as Promise<T> | undefined
  if (!entry) {
    entry = load()
    ctx.memo.set(key, entry)
  }
  return entry
}
