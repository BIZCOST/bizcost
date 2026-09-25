import 'server-only'
import { z } from 'zod'

// Server environment of the API, validated on first use (not at import, so `next build` needs no
// secrets). Variable names are listed in the root .env.example. SENTRY_DSN is not part of it: telemetry
// is optional and read by instrumentation.ts, so a bad DSN can never take the API down.

const DEV_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000']

// Unset and empty (`NAME=` in an .env file) both mean "not set".
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional())

const origin = z.string().refine((value) => {
  try {
    return new URL(value).origin === value
  } catch {
    return false
  }
}, 'must be an origin such as https://app.example.com (no path or trailing slash)')

const schema = z
  .object({
    NODE_ENV: optional(z.enum(['development', 'production', 'test'])),
    NEXT_PUBLIC_SUPABASE_URL: optional(z.url()),
    /** Same URL for server-only contexts (CI, scripts) where the public name is not set. */
    SUPABASE_URL: optional(z.url()),
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
    /** Server only: the Auth admin API (account deletion). Required in production. */
    SUPABASE_SECRET_KEY: optional(z.string().min(1)),
    /** postgres URL of the API role bizcost_api (never postgres/service_role). */
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL'),
    MIN_SUPPORTED_APP_VERSION: optional(
      z.string().regex(/^\d+\.\d+\.\d+$/, 'must be a version such as 1.4.0'),
    ),
    /** Comma-separated origins allowed to send cookie-authenticated mutations. */
    APP_ORIGINS: optional(z.string()),
    VERCEL_GIT_COMMIT_SHA: optional(z.string()),
  })
  .transform((env, ctx) => {
    const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL ?? env.SUPABASE_URL
    if (!supabaseUrl) {
      ctx.addIssue({ code: 'custom', message: 'NEXT_PUBLIC_SUPABASE_URL is required' })
      return z.NEVER
    }
    const production = env.NODE_ENV === 'production'
    const origins = env.APP_ORIGINS?.split(',')
      .map((o) => o.trim())
      .filter(Boolean)
    if (production && !origins?.length) {
      ctx.addIssue({ code: 'custom', message: 'APP_ORIGINS is required in production' })
      return z.NEVER
    }
    if (production && !env.SUPABASE_SECRET_KEY) {
      ctx.addIssue({ code: 'custom', message: 'SUPABASE_SECRET_KEY is required in production' })
      return z.NEVER
    }
    const allowedOrigins = origins ?? DEV_ORIGINS
    for (const value of allowedOrigins) {
      const checked = origin.safeParse(value)
      if (!checked.success) {
        ctx.addIssue({ code: 'custom', message: `APP_ORIGINS: ${value} is not an origin` })
        return z.NEVER
      }
    }
    return {
      supabaseUrl,
      supabasePublishableKey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      databaseUrl: env.DATABASE_URL,
      minSupportedAppVersion: env.MIN_SUPPORTED_APP_VERSION ?? '0.0.0',
      allowedOrigins,
      version: env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? 'dev',
      // In development account deletion reports a clear error when the key is missing.
      supabaseSecretKey: env.SUPABASE_SECRET_KEY,
    }
  })

export type ServerEnv = z.output<typeof schema>

/** Parses the environment once. Throws with the names of the invalid variables (never their values). */
export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const result = schema.safeParse(source)
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`)
    throw new Error(`Invalid server environment:\n${problems.join('\n')}`)
  }
  return result.data
}

let cached: ServerEnv | undefined

export function serverEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env)
  return cached
}
