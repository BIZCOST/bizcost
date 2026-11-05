import { describe, expect, it } from 'vitest'
import { parseServerEnv } from './env'

const base = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x',
  DATABASE_URL: 'postgresql://bizcost_api:pw@127.0.0.1:54322/postgres',
}

describe('parseServerEnv: the closed beta', () => {
  it('holds nothing, names no admin and emails nobody by default', () => {
    expect(parseServerEnv(base)).toMatchObject({
      heldModules: [],
      platformAdmins: [],
      feedbackEmail: undefined,
    })
  })

  it('reads the modules held back in production too (D-359), unlike the preview', () => {
    const production = {
      ...base,
      NODE_ENV: 'production',
      APP_ORIGINS: 'https://app.bizcost.ae',
      APP_URL: 'https://app.bizcost.ae',
      SUPABASE_SECRET_KEY: 'sb_secret_x',
      RESEND_API_KEY: 're_x',
      EMAIL_FROM: 'BizCost <a@b.test>',
    }
    expect(parseServerEnv({ ...production, BIZCOST_HELD_MODULES: 'invoices' }).heldModules).toEqual(
      ['invoices'],
    )
    expect(() => parseServerEnv({ ...production, BIZCOST_HELD_MODULES: 'invoice' })).toThrow(
      /BIZCOST_HELD_MODULES: invoice cannot be held/,
    )
    expect(() => parseServerEnv({ ...production, BIZCOST_HELD_MODULES: 'settings' })).toThrow(
      /BIZCOST_HELD_MODULES/,
    )
    expect(() => parseServerEnv({ ...production, BIZCOST_HELD_MODULES: 'sales' })).toThrow(
      /invoices needs sales/,
    )
  })

  it('reads the database CA (D-362): real line ends or written ones, and only a certificate', () => {
    const pem = ['-----BEGIN CERTIFICATE-----', 'not a real one', '-----END CERTIFICATE-----']
    const expected = pem.join('\n')
    expect(parseServerEnv({ ...base, DATABASE_CA_CERT: expected }).databaseCaCert).toBe(expected)
    expect(parseServerEnv({ ...base, DATABASE_CA_CERT: pem.join('\\n') }).databaseCaCert).toBe(
      expected,
    )
    expect(parseServerEnv({ ...base, DATABASE_CA_CERT: '' }).databaseCaCert).toBeUndefined()
    expect(() => parseServerEnv({ ...base, DATABASE_CA_CERT: 'nonsense' })).toThrow(
      /DATABASE_CA_CERT/,
    )
  })

  it('refuses a certificate that lost its line ends, by name, instead of every connection failing later', () => {
    const [begin, body, end] = [
      '-----BEGIN CERTIFICATE-----',
      'MIIDxTCCAq2gAwIBAgIQAqxcJmoLQJuPC3nyrkYldzANBgkqhkiG9w0BAQsFADBs',
      '-----END CERTIFICATE-----',
    ]
    for (const lost of [
      [begin, body, end].join(' '),
      [begin, body, end].join(''),
      begin,
      [begin, body].join('\n'),
    ]) {
      expect(() => parseServerEnv({ ...base, DATABASE_CA_CERT: lost })).toThrow(
        /DATABASE_CA_CERT: must be a PEM certificate that keeps its line ends/,
      )
    }
    // These all connect (checked by a real handshake, D-366), and stay accepted: Windows line ends,
    // a body on one line, line ends written \n.
    for (const fine of [
      [begin, body, end].join('\r\n'),
      `${begin}\n${body}${body}\n${end}\n`,
      [begin, body, end].join('\\n'),
    ]) {
      expect(parseServerEnv({ ...base, DATABASE_CA_CERT: fine }).databaseCaCert).toContain(body)
    }
  })

  it('reads the platform admins in lower case, and refuses what is not an address', () => {
    expect(
      parseServerEnv({
        ...base,
        BIZCOST_PLATFORM_ADMINS: ' Owner@BizCost.ae , second@bizcost.ae,',
      }).platformAdmins,
    ).toEqual(['owner@bizcost.ae', 'second@bizcost.ae'])
    expect(() => parseServerEnv({ ...base, BIZCOST_PLATFORM_ADMINS: 'not-an-email' })).toThrow(
      /BIZCOST_PLATFORM_ADMINS/,
    )
  })

  it('reads where feedback goes, and refuses what is not an address', () => {
    expect(
      parseServerEnv({ ...base, BIZCOST_FEEDBACK_EMAIL: 'owner@bizcost.ae' }).feedbackEmail,
    ).toBe('owner@bizcost.ae')
    expect(() => parseServerEnv({ ...base, BIZCOST_FEEDBACK_EMAIL: 'nope' })).toThrow(
      /BIZCOST_FEEDBACK_EMAIL/,
    )
  })
})

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
      previewModules: [],
      heldModules: [],
      platformAdmins: [],
      feedbackEmail: undefined,
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

  describe('BIZCOST_PREVIEW_MODULES (dev-only, D-125)', () => {
    const production = {
      ...base,
      NODE_ENV: 'production',
      SUPABASE_SECRET_KEY: 'sb_secret_x',
      APP_ORIGINS: 'https://app.example.com',
      APP_URL: 'https://app.example.com',
      EMAIL_TRANSPORT: 'smtp',
    }

    it('ignores modules released since the list was written (the Costing Core, M2 Step 7)', () => {
      // A local server started with the list of the M2 build keeps starting, and previews nothing:
      // nothing is being built between M2 Step 7 and Phase 3.
      for (const NODE_ENV of ['development', 'test']) {
        expect(
          parseServerEnv({
            ...base,
            NODE_ENV,
            BIZCOST_PREVIEW_MODULES:
              'materials,products,suppliers,purchases,expenses,running_costs,cost_engine',
          }).previewModules,
        ).toEqual([])
      }
    })

    it('is never read in production, nor without NODE_ENV', () => {
      expect(
        parseServerEnv({ ...production, BIZCOST_PREVIEW_MODULES: 'materials,products' })
          .previewModules,
      ).toEqual([])
      // Not even checked there: a bad value cannot take a production server down either.
      expect(
        parseServerEnv({ ...production, BIZCOST_PREVIEW_MODULES: 'nope' }).previewModules,
      ).toEqual([])
      expect(
        parseServerEnv({ ...base, BIZCOST_PREVIEW_MODULES: 'materials' }).previewModules,
      ).toEqual([])
    })

    it('refuses a module that cannot be previewed (unknown or not being built)', () => {
      const dev = { ...base, NODE_ENV: 'development' }
      expect(() =>
        parseServerEnv({ ...dev, BIZCOST_PREVIEW_MODULES: 'materials,usage_waste' }),
      ).toThrow(/BIZCOST_PREVIEW_MODULES: usage_waste/)
      // Stock is being built (M4 Step 2): it may be previewed.
      expect(
        parseServerEnv({ ...dev, BIZCOST_PREVIEW_MODULES: 'inventory' }).previewModules,
      ).toEqual(['inventory'])
      // Quotations and Invoices are released (Release B, M3 Step 9): a local server started with the
      // list of their build (M3 Steps 7 and 8) keeps starting, and previews nothing.
      expect(
        parseServerEnv({ ...dev, BIZCOST_PREVIEW_MODULES: 'quotations,invoices' }).previewModules,
      ).toEqual([])
      expect(() => parseServerEnv({ ...dev, BIZCOST_PREVIEW_MODULES: 'nope' })).toThrow(
        /BIZCOST_PREVIEW_MODULES/,
      )
      expect(
        parseServerEnv({ ...dev, BIZCOST_PREVIEW_MODULES: 'settings' }).previewModules,
      ).toEqual([])
      expect(parseServerEnv({ ...dev, BIZCOST_PREVIEW_MODULES: '' }).previewModules).toEqual([])
    })
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
