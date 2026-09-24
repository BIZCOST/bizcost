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
    })
  })

  it('reads the production settings', () => {
    const env = parseServerEnv({
      ...base,
      NODE_ENV: 'production',
      APP_ORIGINS: 'https://app.example.com, https://www.example.com',
      MIN_SUPPORTED_APP_VERSION: '1.4.0',
      VERCEL_GIT_COMMIT_SHA: '0123456789abcdef0123',
    })
    expect(env.allowedOrigins).toEqual(['https://app.example.com', 'https://www.example.com'])
    expect(env.minSupportedAppVersion).toBe('1.4.0')
    expect(env.version).toBe('0123456789ab')
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
    expect(() => parseServerEnv({ ...base, NODE_ENV: 'production' })).toThrow(/APP_ORIGINS/)
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
