import type { Db } from '@bizcost/db'
import type { Locale } from '@bizcost/domain'
import { PREVIEWABLE_MODULE_IDS } from '@bizcost/modules'
import type { Transporter } from 'nodemailer'
import type { EmailMessage, EmailSender } from '../src'
import type * as TestHelpers from '../test/helpers'
import { DEMO_EMAIL_DOMAIN, DEMO_PASSWORD, type DemoPerson } from './personas'
import { LOCAL_SMTP_PORT, useLocalStack, type LocalStack } from './local-stack'

// The demo talks to the API exactly like the apps do: through the real fetch handler (every
// middleware, permission, gate and audit row), as each demo account with an access token signed by the
// local stack's key (like the API integration tests, so no sign-in counts against the local Auth rate
// limit). Accounts are created and removed with the local Auth admin API only. The modules being built
// (planned until M2 Step 7) are previewed as on `next dev` (D-125), so the demo fills them too.

type Helpers = typeof TestHelpers
type Handler = (req: Request) => Promise<Response>
type Admin = ReturnType<Helpers['connectAdmin']>

export interface DemoUser {
  id: string
  email: string
}

/** Keeps each email (to read the invitation link) and also delivers it to the local Mailpit. */
class DemoMail implements EmailSender {
  private last = new Map<string, EmailMessage>()
  private transporter: Promise<Transporter> | undefined

  constructor(private readonly smtpHost: string) {}

  async send(message: EmailMessage): Promise<void> {
    this.last.set(message.to.toLowerCase(), message)
    this.transporter ??= import('nodemailer').then((nodemailer) =>
      nodemailer.createTransport({ host: this.smtpHost, port: LOCAL_SMTP_PORT, secure: false }),
    )
    await (
      await this.transporter
    ).sendMail({ from: 'BizCost <no-reply@bizcost.local>', ...message })
  }

  /** The token of the last invitation link sent to `address`. */
  inviteToken(address: string): string {
    const text = this.last.get(address.toLowerCase())?.text ?? ''
    const token = /\/invite\/([A-Za-z0-9_-]{43})/.exec(text)?.[1]
    if (!token) throw new Error(`no invitation link was sent to ${address}`)
    return token
  }

  close(): void {
    void this.transporter?.then((t) => t.close())
  }
}

export class DemoApi {
  private constructor(
    readonly stack: LocalStack,
    private readonly helpers: Helpers,
    private readonly handler: Handler,
    private readonly db: Db,
    private readonly sql: Admin,
    readonly mail: DemoMail,
    private readonly procedures: ReadonlySet<string>,
  ) {}

  /** Checks the local stack, then builds the API handler on it. */
  static async open(): Promise<DemoApi> {
    const stack = await useLocalStack()
    // The helpers read the variables useLocalStack() has just set, so they load only now.
    const helpers = await import('../test/helpers')
    const { appRouter } = await import('../src')
    // The preview of the modules being built is honoured only in development and test (D-125); none
    // is being built since the Costing Core's release (M2 Step 7), so this previews nothing today.
    process.env.NODE_ENV ??= 'development'
    const db = helpers.connectApi()
    const mail = new DemoMail(stack.smtpHost)
    const handler = helpers.handlerFor(
      db,
      undefined,
      {
        supabaseSecretKey: helpers.SECRET_KEY,
        appUrl: 'http://localhost:3000',
        previewModules: PREVIEWABLE_MODULE_IDS,
      },
      { emailSender: mail },
    )
    const procedures = new Set(Object.keys(appRouter._def.procedures))
    return new DemoApi(stack, helpers, handler, db, helpers.connectAdmin(), mail, procedures)
  }

  async close(): Promise<void> {
    this.mail.close()
    await Promise.all([this.db.$client.end(), this.sql.end()])
  }

  // -------------------------------------------------------------------------------------------------
  // Accounts: looked up in auth.users (the local Auth server's user list fails on rows that tests
  // inserted by SQL), created and updated with the Auth admin API (local secret key)
  // -------------------------------------------------------------------------------------------------

  private async admin(path: string, init: RequestInit): Promise<Response> {
    const response = await fetch(`${this.helpers.SUPABASE_URL}/auth/v1/admin/${path}`, {
      ...init,
      headers: {
        apikey: this.helpers.SECRET_KEY,
        authorization: `Bearer ${this.helpers.SECRET_KEY}`,
        'content-type': 'application/json',
      },
    })
    if (!response.ok) throw new Error(`Auth admin ${path}: ${response.status}`)
    return response
  }

  /** The demo accounts that exist now. */
  async demoUsers(): Promise<DemoUser[]> {
    return this.sql<DemoUser[]>`
      select id, lower(email) as email from auth.users
      where lower(email) like ${`%@${DEMO_EMAIL_DOMAIN}`}
      order by created_at`
  }

  /**
   * A confirmed account with the demo password: created when missing, else its password is set back
   * to the demo password. `created` tells which.
   */
  async ensureUser(person: DemoPerson): Promise<DemoUser & { created: boolean }> {
    const email = person.email.toLowerCase()
    const [existing] = await this.sql<{ id: string }[]>`
      select id from auth.users where lower(email) = ${email}`
    if (existing) {
      await this.admin(`users/${existing.id}`, {
        method: 'PUT',
        body: JSON.stringify({ password: DEMO_PASSWORD, email_confirm: true }),
      })
      return { id: existing.id, email, created: false }
    }
    const response = await this.admin('users', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password: DEMO_PASSWORD,
        email_confirm: true,
        user_metadata: { locale: person.locale },
      }),
    })
    const row = (await response.json()) as { id: string }
    return { id: row.id, email, created: true }
  }

  // -------------------------------------------------------------------------------------------------
  // tRPC calls as a user
  // -------------------------------------------------------------------------------------------------

  /** An access token for `user`, signed now (so it also counts as a recent sign-in). */
  token(user: DemoUser, locale: Locale = 'ar'): Promise<string> {
    return this.helpers.mintToken({
      id: user.id,
      email: user.email,
      password: '',
      metadata: { locale },
    })
  }

  /** Whether this build of the API has the procedure (e.g. one of a step being built). */
  hasProcedure(path: string): boolean {
    return this.procedures.has(path)
  }

  private unwrap<T>(path: string, result: Awaited<ReturnType<Helpers['query']>>): T {
    if (result.error) {
      const { appCode } = result.error.data
      const { message } = result.error
      const detail = message && message !== appCode ? ` (${message})` : ''
      const error = new Error(`${path}: ${appCode}${detail}`) as Error & { appCode: string }
      error.appCode = appCode
      throw error
    }
    return result.data as T
  }

  async query<T>(path: string, token: string, businessId?: string, input?: unknown): Promise<T> {
    const result = await this.helpers.query(this.handler, path, { token, businessId, input })
    return this.unwrap<T>(path, result)
  }

  async mutate<T>(path: string, token: string, businessId?: string, input?: unknown): Promise<T> {
    const result = await this.helpers.mutate(this.handler, path, { token, businessId, input })
    return this.unwrap<T>(path, result)
  }
}

/** The app code of an API error thrown by DemoApi (undefined for other errors). */
export function appCodeOf(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'appCode' in error
    ? String(error.appCode)
    : undefined
}
