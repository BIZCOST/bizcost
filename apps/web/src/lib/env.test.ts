import { describe, expect, it } from 'vitest'
import { parseServerEnv } from './env'

const base = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x',
  DATABASE_URL: 'postgresql://bizcost_api:pw@127.0.0.1:54322/postgres',
}

describe('parseServerEnv', () => {
  it('fills development defaults', () => {
    expect(parseServerEnv(base)).toEqual({
      supabaseUrl: 'http://127.0.0.1:54321',
      supabasePublishableKey: 'sb_publishable_x',
      databaseUrl: base.DATABASE_URL,
      minSupportedAppVersion: '0.0.0',
      allowedOrigins: ['http://localhost:3000', 'http://127.0.0.1:3000'],
      version: 'dev',
      supabaseSecretKey: undefined,
      appUrl: 'http://localhost:3000',
      email: undefined,
    })
  })

  it('reads the production settings', () => {
    const env = parseServerEnv({
      ...base,
      NODE_ENV: 'production',
      SUPABASE_SECRET_KEY: 'sb_secret_x',
      APP_ORIGINS: 'https://app.example.com, https://www.example.com',
      APP_URL: 'https://app.example.com',
      RESEND_API_KEY: 're_x',
      EMAIL_FROM: 'BizCost <notify@example.com>',
      MIN_SUPPORTED_APP_VERSION: '1.4.0',
      VERCEL_GIT_COMMIT_SHA: '0123456789abcdef0123',
    })
    expect(env.allowedOrigins).toEqual(['https://app.example.com', 'https://www.example.com'])
    expect(env.minSupportedAppVersion).toBe('1.4.0')
    expect(env.version).toBe('0123456789ab')
    expect(env.supabaseSecretKey).toBe('sb_secret_x')
    expect(env.appUrl).toBe('https://app.example.com')
    expect(env.email).toEqual({
      transport: 'resend',
      apiKey: 're_x',
      from: 'BizCost <notify@example.com>',
    })
  })

  it('requires SUPABASE_SECRET_KEY in production only', () => {
    const production = {
      ...base,
      NODE_ENV: 'production',
      APP_ORIGINS: 'https://app.example.com',
      APP_URL: 'https://app.example.com',
      EMAIL_TRANSPORT: 'smtp',
    }
    expect(() => parseServerEnv(production)).toThrow(/SUPABASE_SECRET_KEY/)
    expect(() => parseServerEnv({ ...production, SUPABASE_SECRET_KEY: '' })).toThrow(
      /SUPABASE_SECRET_KEY/,
    )
    expect(parseServerEnv(base).supabaseSecretKey).toBeUndefined()
  })

  it('does not depend on SENTRY_DSN (telemetry is optional)', () => {
    expect(() => parseServerEnv({ ...base, SENTRY_DSN: ' "not a dsn" ' })).not.toThrow()
  })

  it('accepts SUPABASE_URL when the public name is not set', () => {
    const withoutPublic = { ...base, NEXT_PUBLIC_SUPABASE_URL: undefined }
    expect(
      parseServerEnv({ ...withoutPublic, SUPABASE_URL: 'http://127.0.0.1:54321' }).supabaseUrl,
    ).toBe('http://127.0.0.1:54321')
  })

  it('requires APP_ORIGINS in production', () => {
    expect(() =>
      parseServerEnv({ ...base, NODE_ENV: 'production', SUPABASE_SECRET_KEY: 'sb_secret_x' }),
    ).toThrow(/APP_ORIGINS/)
  })

  it('requires APP_URL and an email transport in production', () => {
    const production = {
      ...base,
      NODE_ENV: 'production',
      SUPABASE_SECRET_KEY: 'sb_secret_x',
      APP_ORIGINS: 'https://app.example.com',
    }
    expect(() => parseServerEnv({ ...production, EMAIL_TRANSPORT: 'smtp' })).toThrow(/APP_URL/)
    const withUrl = { ...production, APP_URL: 'https://app.example.com' }
    expect(() => parseServerEnv(withUrl)).toThrow(/email transport/)
    expect(() => parseServerEnv({ ...withUrl, RESEND_API_KEY: 're_x' })).toThrow(/EMAIL_FROM/)
    expect(() => parseServerEnv({ ...withUrl, APP_URL: 'https://app.example.com/x' })).toThrow(
      /APP_URL/,
    )
  })

  it('sends email to the local Mailpit over SMTP with EMAIL_TRANSPORT=smtp', () => {
    expect(parseServerEnv({ ...base, EMAIL_TRANSPORT: 'smtp' }).email).toEqual({
      transport: 'smtp',
      host: '127.0.0.1',
      port: 54325,
      from: 'BizCost <no-reply@bizcost.local>',
    })
    const custom = parseServerEnv({
      ...base,
      EMAIL_TRANSPORT: 'smtp',
      SMTP_HOST: 'mail.local',
      SMTP_PORT: '2525',
      APP_URL: 'http://localhost:3100',
    })
    expect(custom.email).toMatchObject({ host: 'mail.local', port: 2525 })
    expect(custom.appUrl).toBe('http://localhost:3100')
    expect(() => parseServerEnv({ ...base, EMAIL_TRANSPORT: 'sendmail' })).toThrow(
      /EMAIL_TRANSPORT/,
    )
  })

  it('rejects origins with a path or trailing slash', () => {
    expect(() => parseServerEnv({ ...base, APP_ORIGINS: 'https://app.example.com/' })).toThrow(
      /APP_ORIGINS/,
    )
  })

  it('names invalid variables without echoing their values', () => {
    const run = () =>
      parseServerEnv({
        ...base,
        DATABASE_URL: 'mysql://root:hunter2@db',
        MIN_SUPPORTED_APP_VERSION: 'x',
      })
    expect(run).toThrow(/DATABASE_URL/)
    expect(run).toThrow(/MIN_SUPPORTED_APP_VERSION/)
    expect(run).not.toThrow(/hunter2/)
  })
})
