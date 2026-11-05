#!/usr/bin/env node
import { pathToFileURL } from 'node:url'

// Reads a hosted project's Auth settings back from Supabase and says whether closed sign-up, CAPTCHA and
// SMTP are really on and the site URL is the app's (D-361). db-migrate.yml's last step: nothing else would
// notice a push, by hand or by a new CLI, that turned them off. A real run fails on any problem; a dry
// run (`--report`) only says so, since a project's first dry run is before anything was pushed.
//
// It prints field names and yes or no, never a value of what Supabase answers: that answer holds hashes
// of the secrets. Plain Node with no dependency: the job installs no package.
//
//   SUPABASE_ACCESS_TOKEN=… PROJECT_REF=… APP_URL=… [CLOSED_SIGNUP=false] node check-hosted-auth.mjs [--report]

/** What is wrong with these settings, as sentences with no value from the answer in them. */
export function authProblems(settings, { appUrl, closedSignup }) {
  const problems = []
  if (closedSignup !== 'false' && settings.hook_before_user_created_enabled !== true) {
    problems.push('The before-user-created hook is off: anyone can sign up.')
  }
  if (settings.security_captcha_enabled !== true) problems.push('CAPTCHA is off.')
  if (!settings.smtp_host) problems.push('The SMTP of Auth is off: at most 2 emails an hour.')
  // A trailing slash is the same site, and not worth failing a run that has already pushed.
  if (String(settings.site_url ?? '').replace(/\/$/, '') !== appUrl) {
    problems.push('The site URL of Auth is not APP_URL.')
  }
  return problems
}

async function main() {
  const { SUPABASE_ACCESS_TOKEN: token, PROJECT_REF: ref, APP_URL: appUrl } = process.env
  const closedSignup = process.env.CLOSED_SIGNUP
  const base = process.env.SUPABASE_MANAGEMENT_API ?? 'https://api.supabase.com'
  const response = await fetch(`${base}/v1/projects/${encodeURIComponent(ref ?? '')}/config/auth`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`Supabase answered ${response.status} for the Auth settings`)
  const problems = authProblems(await response.json(), { appUrl, closedSignup })
  const report = process.argv.includes('--report')
  for (const problem of problems) console.log(`::${report ? 'warning' : 'error'}::${problem}`)
  if (problems.length === 0) {
    console.log(
      closedSignup === 'false'
        ? 'Auth on this project: CAPTCHA on, SMTP on, site URL right. Sign-up is OPEN (CLOSED_SIGNUP is false).'
        : 'Auth on this project: closed sign-up on, CAPTCHA on, SMTP on, site URL right.',
    )
  } else if (!report) {
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`::error::${error instanceof Error ? error.message : error}`)
    process.exitCode = 1
  })
}
