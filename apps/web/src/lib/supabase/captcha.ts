import type { AuthClient } from '@bizcost/app-core'

// CAPTCHA on what Supabase Auth guards with it (D-062, D-352): sign-up, a code request, a resend, a
// password sign-in and a reset. Every one of those calls in the app, the "confirm it's you" code and the
// automatic resend included, goes through this one wrapper, so no screen handles a token. Refreshing
// and checking a session or a code needs none (Auth does not ask for one there).

/** A fresh, single-use token; undefined when CAPTCHA is off here or no token could be had. */
export type CaptchaTokens = () => Promise<string | undefined>

/**
 * `client` with a token on each guarded call. Without one the call still goes out: with CAPTCHA off
 * that is the normal case (the local stack), and with it on Auth answers `captcha_failed`, which the
 * flows show like any other refusal.
 */
export function withCaptcha(client: AuthClient, tokens: CaptchaTokens): AuthClient {
  const guarded = async <T extends { options?: object }>(credentials: T): Promise<T> => {
    const captchaToken = await tokens()
    return captchaToken === undefined
      ? credentials
      : { ...credentials, options: { ...credentials.options, captchaToken } }
  }
  return {
    ...client,
    signUp: async (credentials) => client.signUp(await guarded(credentials)),
    signInWithPassword: async (credentials) =>
      client.signInWithPassword(await guarded(credentials)),
    signInWithOtp: async (credentials) => client.signInWithOtp(await guarded(credentials)),
    resend: async (credentials) => client.resend(await guarded(credentials)),
    resetPasswordForEmail: async (email, options) => {
      const captchaToken = await tokens()
      return client.resetPasswordForEmail(
        email,
        captchaToken === undefined ? options : { ...options, captchaToken },
      )
    },
  }
}

// ---------------------------------------------------------------------------------------------------
// Cloudflare Turnstile, loaded only when a site key is set and a guarded call happens
// ---------------------------------------------------------------------------------------------------

interface TurnstileOptions {
  readonly sitekey: string
  readonly appearance: 'interaction-only'
  readonly language: string
  readonly callback: (token: string) => void
  readonly 'error-callback': () => boolean
  readonly 'timeout-callback': () => void
  readonly 'expired-callback': () => void
}

interface Turnstile {
  render(container: HTMLElement, options: TurnstileOptions): string | null | undefined
  remove(widgetId: string): void
}

declare global {
  interface Window {
    turnstile?: Turnstile
  }
}

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
/** How long a person may take over a challenge before the call goes on without a token. */
const TOKEN_TIMEOUT_MS = 120_000

let loading: Promise<Turnstile> | undefined

function loadTurnstile(): Promise<Turnstile> {
  loading ??= new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = SCRIPT_URL
    script.async = true
    script.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile did not load'))
    script.onerror = () => {
      loading = undefined
      reject(new Error('Turnstile did not load'))
    }
    document.head.append(script)
  })
  return loading
}

/**
 * One token from a new widget. It shows only when Cloudflare needs the person to do something: at the
 * bottom of the page, in the page's language, over everything else.
 */
async function turnstileToken(sitekey: string): Promise<string | undefined> {
  let turnstile: Turnstile
  try {
    turnstile = await loadTurnstile()
  } catch {
    return undefined
  }
  return new Promise<string | undefined>((resolve) => {
    const container = document.createElement('div')
    container.style.cssText =
      'position:fixed;inset-block-end:1rem;inset-inline:0;display:flex;justify-content:center;z-index:100'
    document.body.append(container)
    const widget: { id?: string | null } = {}
    let finished = false
    const finish = (token: string | undefined) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (widget.id) turnstile.remove(widget.id)
      container.remove()
      resolve(token)
    }
    const timer = setTimeout(() => finish(undefined), TOKEN_TIMEOUT_MS)
    widget.id = turnstile.render(container, {
      sitekey,
      appearance: 'interaction-only',
      language: document.documentElement.lang || 'auto',
      callback: (token) => finish(token),
      'error-callback': () => {
        finish(undefined)
        return true
      },
      'timeout-callback': () => finish(undefined),
      'expired-callback': () => finish(undefined),
    })
  })
}

/** The app's tokens: Turnstile when NEXT_PUBLIC_TURNSTILE_SITE_KEY is set, none otherwise (local). */
export const captchaTokens: CaptchaTokens = async () => {
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY
  return siteKey ? turnstileToken(siteKey) : undefined
}
