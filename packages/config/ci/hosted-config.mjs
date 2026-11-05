#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// What a hosted project gets from supabase/config.toml (D-361). The file holds the local stack's truth:
// hook, CAPTCHA and SMTP off, the site on 127.0.0.1. `supabase config push` writes what the file says, and
// the pinned CLI (2.117.0) does not read SUPABASE_AUTH_* over it on `config diff` or `config push` (it does
// on `supabase start`), so with no rewrite a run would turn closed sign-up, CAPTCHA and SMTP off with no
// error. db-migrate.yml runs this on its own checkout before the diff and the push, and never commits it.
//
// Plain Node with no dependency: that job installs no package. No secret passes through here: the file
// keeps its `env(...)` references, which the CLI fills in.
//
//   APP_URL=https://app.example.com [CLOSED_SIGNUP=false] node packages/config/ci/hosted-config.mjs [path]

/** Replaces one `key = value` line of one section, and fails unless it is exactly there. */
function setValue(toml, section, key, value) {
  const lines = toml.split('\n')
  const header = `[${section}]`
  const start = lines.findIndex((line) => line.trim() === header)
  if (start < 0) throw new Error(`config.toml has no section ${header}`)
  let found = 0
  for (let i = start + 1; i < lines.length && !lines[i].startsWith('['); i += 1) {
    if (lines[i].startsWith(`${key} = `)) {
      lines[i] = `${key} = ${value}`
      found += 1
    }
  }
  if (found !== 1) throw new Error(`config.toml: [${section}] ${key} found ${found} times`)
  return lines.join('\n')
}

/** An `https://` origin with nothing after it: Auth's site URL and its only redirect. */
export function checkedOrigin(appUrl) {
  let url
  try {
    url = new URL(appUrl ?? '')
  } catch {
    throw new Error('APP_URL is not a URL')
  }
  if (url.protocol !== 'https:' || url.origin !== appUrl) {
    throw new Error('APP_URL must be an https:// origin, with no path and no trailing slash')
  }
  return appUrl
}

/**
 * The file a hosted project's settings come from. Sign-up closes unless the environment's variable says
 * exactly `false`: a forgotten variable never opens it (D-355).
 */
export function hostedConfig(toml, { appUrl, closedSignup }) {
  const origin = checkedOrigin(appUrl)
  const open = closedSignup === 'false'
  return [
    ['auth', 'site_url', JSON.stringify(origin)],
    ['auth', 'additional_redirect_urls', `[${JSON.stringify(origin)}]`],
    ['auth.captcha', 'enabled', 'true'],
    ['auth.email.smtp', 'enabled', 'true'],
    ['auth.hook.before_user_created', 'enabled', open ? 'false' : 'true'],
  ].reduce((text, [section, key, value]) => setValue(text, section, key, value), toml)
}

function main() {
  const path = process.argv[2] ?? 'supabase/config.toml'
  const toml = readFileSync(path, 'utf8').replaceAll('\r\n', '\n')
  writeFileSync(
    path,
    hostedConfig(toml, { appUrl: process.env.APP_URL, closedSignup: process.env.CLOSED_SIGNUP }),
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : error}`)
    process.exitCode = 1
  }
}
