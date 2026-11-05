import { spawn } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authProblems } from './check-hosted-auth.mjs'
import { checkedOrigin, hostedConfig } from './hosted-config.mjs'

// What db-migrate really writes to a hosted project (D-361). The pinned CLI's `config push` is run for
// real, against a stand-in for Supabase's Management API on this machine, with a fake token and fake
// secrets. It is how the fault was found: SUPABASE_AUTH_* over config.toml do nothing on `config push`.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const CLI = join(ROOT, 'node_modules', 'supabase', 'dist', 'supabase.js')
const APP_URL = 'https://staging.example.test'
const REF = 'abcdefghijklmnopqrst'
const config = () =>
  readFileSync(join(ROOT, 'supabase/config.toml'), 'utf8').replaceAll('\r\n', '\n')

// The CLI sends only what differs, so each test starts from a project set the other way.
const CLOSED_PROJECT = {
  hook_before_user_created_enabled: true,
  security_captcha_enabled: true,
  smtp_host: 'smtp.resend.com',
  site_url: APP_URL,
}
const NEW_PROJECT = {
  hook_before_user_created_enabled: false,
  security_captcha_enabled: false,
  smtp_host: '',
  site_url: 'https://old.example.test',
}

const server = {
  url: '',
  auth: /** @type {Record<string, unknown> | null} */ (null),
  remote: NEW_PROJECT,
  http: createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      response.setHeader('content-type', 'application/json')
      if (request.method === 'PATCH' && request.url === `/v1/projects/${REF}/config/auth`) {
        server.auth = JSON.parse(body)
      }
      if (request.url === `/v2/projects/${REF}/config`) {
        response.end(JSON.stringify({ data: { attributes: { auth: server.remote } } }))
        return
      }
      response.end('{}')
    })
  }),
}

let workdir = ''

/** Runs `supabase config push` on this text as config.toml, and answers what it PATCHed to Auth. */
async function pushed(toml, remote, extraEnv = {}) {
  server.auth = null
  server.remote = remote
  writeFileSync(join(workdir, 'supabase', 'config.toml'), toml)
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [CLI, 'config', 'push', '--project-ref', REF, '--yes', '--workdir', workdir],
      {
        cwd: workdir,
        stdio: 'ignore',
        env: {
          ...process.env,
          DO_NOT_TRACK: '1',
          SUPABASE_PROFILE: join(workdir, 'profile.yaml'),
          SUPABASE_ACCESS_TOKEN: `sbp_${'0'.repeat(40)}`,
          SUPABASE_AUTH_EMAIL_SMTP_PASS: 'fake-mail-key',
          SUPABASE_AUTH_CAPTCHA_SECRET: 'fake-captcha-secret',
          ...extraEnv,
        },
      },
    )
    child.on('error', reject)
    // The stand-in answers too little after the PATCH for the CLI to exit 0: what it sent is the point.
    child.on('exit', resolve)
  })
  return server.auth
}

beforeAll(async () => {
  await new Promise((resolve) => server.http.listen(0, '127.0.0.1', () => resolve(undefined)))
  const address = /** @type {import('node:net').AddressInfo} */ (server.http.address())
  server.url = `http://127.0.0.1:${address.port}`
  workdir = mkdtempSync(join(tmpdir(), 'bizcost-hosted-config-'))
  mkdirSync(join(workdir, 'supabase'))
  cpSync(join(ROOT, 'supabase/templates'), join(workdir, 'supabase/templates'), { recursive: true })
  writeFileSync(join(workdir, 'supabase', 'signing_keys.json'), '[]')
  writeFileSync(
    join(workdir, 'profile.yaml'),
    [
      'name: stand-in',
      `api_url: ${server.url}`,
      `dashboard_url: ${server.url}`,
      `docs_url: ${server.url}`,
      'project_host: stand-in.test',
      'pooler_host: stand-in.test',
      '',
    ].join('\n'),
  )
})

afterAll(async () => {
  await new Promise((resolve) => server.http.close(() => resolve(undefined)))
  rmSync(workdir, { recursive: true, force: true })
})

describe('what `config push` writes to a hosted project (the pinned CLI)', () => {
  it('with this environment’s values: closed sign-up, CAPTCHA, SMTP and the app’s address', async () => {
    const sent = await pushed(
      hostedConfig(config(), { appUrl: APP_URL, closedSignup: undefined }),
      NEW_PROJECT,
    )
    expect(sent).toMatchObject({
      hook_before_user_created_enabled: true,
      hook_before_user_created_uri: 'pg-functions://postgres/auth_hooks/before_user_created',
      security_captcha_enabled: true,
      security_captcha_provider: 'turnstile',
      security_captcha_secret: 'fake-captcha-secret',
      site_url: APP_URL,
      uri_allow_list: APP_URL,
      smtp_host: 'smtp.resend.com',
      smtp_pass: 'fake-mail-key',
      smtp_user: 'resend',
    })
  })

  it('with CLOSED_SIGNUP false, only sign-up opens', async () => {
    const sent = await pushed(hostedConfig(config(), { appUrl: APP_URL, closedSignup: 'false' }), {
      ...NEW_PROJECT,
      hook_before_user_created_enabled: true,
    })
    expect(sent).toMatchObject({
      hook_before_user_created_enabled: false,
      security_captcha_enabled: true,
      smtp_host: 'smtp.resend.com',
    })
  })

  it('the file alone turns them all off, which is why nobody pushes it by hand', async () => {
    const sent = await pushed(config(), CLOSED_PROJECT)
    expect(sent).toMatchObject({
      hook_before_user_created_enabled: false,
      security_captcha_enabled: false,
      site_url: 'http://127.0.0.1:3000',
    })
  })

  // If a new CLI starts reading these, D-361 can go simpler; until then they must not be relied on.
  it('and SUPABASE_AUTH_* over the file change nothing', async () => {
    const sent = await pushed(config(), CLOSED_PROJECT, {
      SUPABASE_AUTH_HOOK_BEFORE_USER_CREATED_ENABLED: 'true',
      SUPABASE_AUTH_CAPTCHA_ENABLED: 'true',
      SUPABASE_AUTH_SITE_URL: APP_URL,
    })
    expect(sent).toMatchObject({
      hook_before_user_created_enabled: false,
      security_captcha_enabled: false,
      site_url: 'http://127.0.0.1:3000',
    })
  })
})

describe('hostedConfig', () => {
  it('changes exactly the five lines, and keeps every secret a reference', () => {
    const before = config().split('\n')
    const after = hostedConfig(config(), { appUrl: APP_URL, closedSignup: undefined }).split('\n')
    expect(after).toHaveLength(before.length)
    const changed = after.filter((line, index) => line !== before[index])
    expect(changed).toEqual([
      `site_url = "${APP_URL}"`,
      `additional_redirect_urls = ["${APP_URL}"]`,
      'enabled = true',
      'enabled = true',
      'enabled = true',
    ])
    expect(after.join('\n')).toContain('secret = "env(SUPABASE_AUTH_CAPTCHA_SECRET)"')
    expect(after.join('\n')).toContain('pass = "env(SUPABASE_AUTH_EMAIL_SMTP_PASS)"')
  })

  it('stays closed for anything but exactly false', () => {
    for (const closedSignup of [undefined, '', 'true', 'False', 'no']) {
      expect(hostedConfig(config(), { appUrl: APP_URL, closedSignup })).toMatch(
        /\[auth\.hook\.before_user_created\]\nenabled = true/,
      )
    }
  })

  it('fails rather than pushing a file it could not change', () => {
    expect(() =>
      hostedConfig(config().replace('[auth.captcha]', '[auth.renamed]'), { appUrl: APP_URL }),
    ).toThrow(/auth\.captcha/)
    expect(() =>
      hostedConfig(config().replace('site_url = ', '# site_url = '), { appUrl: APP_URL }),
    ).toThrow(/site_url/)
  })

  it('takes only an https origin', () => {
    expect(checkedOrigin(APP_URL)).toBe(APP_URL)
    for (const bad of [undefined, '', 'nope', 'http://a.test', `${APP_URL}/`, `${APP_URL}/x`]) {
      expect(() => checkedOrigin(bad)).toThrow(/APP_URL/)
    }
  })
})

describe('authProblems: reading a project back', () => {
  const closed = {
    hook_before_user_created_enabled: true,
    security_captcha_enabled: true,
    smtp_host: 'smtp.resend.com',
    site_url: APP_URL,
    smtp_pass: 'a-hash-that-is-never-printed',
  }
  const expected = { appUrl: APP_URL, closedSignup: undefined }

  it('passes a closed project', () => {
    expect(authProblems(closed, expected)).toEqual([])
  })

  it('names each thing that is off, with no value from the answer', () => {
    const problems = authProblems(
      {
        ...closed,
        hook_before_user_created_enabled: false,
        security_captcha_enabled: false,
        smtp_host: '',
        site_url: 'http://127.0.0.1:3000',
      },
      expected,
    )
    expect(problems).toHaveLength(4)
    expect(problems.join(' ')).not.toMatch(/127\.0\.0\.1|never-printed/)
  })

  it('takes the same site with a trailing slash', () => {
    expect(authProblems({ ...closed, site_url: `${APP_URL}/` }, expected)).toEqual([])
  })

  it('fails on an answer that does not say, never passes it', () => {
    expect(authProblems({}, expected)).toHaveLength(4)
  })

  it('accepts an open project only when the environment says false', () => {
    const open = { ...closed, hook_before_user_created_enabled: false }
    expect(authProblems(open, { appUrl: APP_URL, closedSignup: 'false' })).toEqual([])
    expect(authProblems(open, { appUrl: APP_URL, closedSignup: '' })).toHaveLength(1)
  })
})
