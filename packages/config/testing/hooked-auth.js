import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promisify } from 'node:util'

// A second, real Auth server for the tests of closed sign-up (D-355): the same image, settings and
// database as the local stack's Auth container, with the before-user-created hook turned on, as
// db-migrate.yml turns it on for a hosted project. It answers on a port of its own, so turning the hook
// on disturbs nothing else that uses the stack (the other suites, the owner's dev server), and it needs
// no restart of the stack. The settings reach `docker run` through its environment (`-e NAME`), never on
// a command line, and are never printed: they are local-only values anyway.

const AUTH_CONTAINER = 'supabase_auth_bizcost'
const HOOK_URI = 'pg-functions://postgres/auth_hooks/before_user_created'
const run = promisify(execFile)

async function docker(args, env) {
  const { stdout } = await run('docker', args, { env: env ?? process.env, windowsHide: true })
  return stdout.trim()
}

/** The published port of a container, once Docker has one. */
async function publishedPort(name) {
  const mapping = await docker(['port', name, '9999/tcp'])
  const port = Number(/:(\d+)\s*$/m.exec(mapping)?.[1])
  if (!Number.isInteger(port)) throw new Error('hooked auth: no published port')
  return port
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error('hooked auth: no answer from /health')
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

/**
 * Starts the server and returns its URL and how to stop it. `overrides` are more GOTRUE_ settings.
 * Direct to the Auth server: paths have no /auth/v1 prefix, and no key is asked for.
 */
export async function startHookedAuth(overrides = {}) {
  const inspected = JSON.parse(await docker(['inspect', AUTH_CONTAINER]))[0]
  if (!inspected) throw new Error(`hooked auth: no container ${AUTH_CONTAINER}`)
  const settings = Object.fromEntries(
    inspected.Config.Env.map((line) => {
      const at = line.indexOf('=')
      return [line.slice(0, at), line.slice(at + 1)]
    }).filter(([key]) => key.startsWith('GOTRUE_') || key === 'API_EXTERNAL_URL'),
  )
  Object.assign(settings, {
    GOTRUE_HOOK_BEFORE_USER_CREATED_ENABLED: 'true',
    GOTRUE_HOOK_BEFORE_USER_CREATED_URI: HOOK_URI,
    // A test asks often from one address, more than a person would.
    GOTRUE_RATE_LIMIT_OTP: '100000',
    GOTRUE_SMTP_MAX_FREQUENCY: '1s',
    ...overrides,
  })
  const name = `bizcost_auth_hooked_${randomBytes(4).toString('hex')}`
  const network = Object.keys(inspected.NetworkSettings.Networks)[0]
  const args = ['run', '--detach', '--rm', '--name', name, '--network', network]
  args.push('--publish', '127.0.0.1:0:9999')
  for (const key of Object.keys(settings)) args.push('--env', key)
  args.push(inspected.Config.Image, ...(inspected.Config.Cmd ?? []))
  await docker(args, { ...process.env, ...settings })
  const stop = async () => {
    await docker(['stop', '--time', '1', name]).catch(() => undefined)
  }
  try {
    const url = `http://127.0.0.1:${await publishedPort(name)}`
    await waitForHealth(url, 30_000)
    return { url, stop }
  } catch (error) {
    await stop()
    throw error
  }
}
