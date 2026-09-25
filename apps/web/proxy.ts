import { secureSessionCookies } from '@bizcost/contracts'
import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

// Next 16 proxy (docs/ARCHITECTURE.md §API & request flow): refreshes the Supabase session cookies
// before any page renders (server components cannot write cookies), then routes by sign-in state.
// It only decides where to go: every API call and layout still verifies the session itself.

/** Pages for signed-out visitors: a signed-in user goes home instead. */
const AUTH_PAGES = new Set(['/login', '/signup', '/verify', '/forgot'])

/**
 * Open either way: the reset code signs the user in before they choose a new password or go
 * straight in (D-071), so the reset page must stay reachable with a session.
 */
const OPEN_PAGES = new Set(['/reset'])

/** A redirect that keeps what a session refresh set: its cookies and its no-store cache headers. */
function redirectTo(
  request: NextRequest,
  pathname: string,
  from: NextResponse,
  refreshHeaders: Record<string, string>,
): NextResponse {
  const url = request.nextUrl.clone()
  url.pathname = pathname
  url.search = ''
  const response = NextResponse.redirect(url)
  for (const cookie of from.cookies.getAll()) response.cookies.set(cookie)
  for (const [name, value] of Object.entries(refreshHeaders)) response.headers.set(name, value)
  return response
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  if (!url || !key)
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be set')

  let response = NextResponse.next({ request })
  let refreshHeaders: Record<string, string> = {}
  const supabase = createServerClient(url, key, {
    cookieOptions: { secure: secureSessionCookies(request.nextUrl) },
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookies, headers) => {
        // The refreshed session goes to the page being rendered and back to the browser.
        for (const { name, value } of cookies) request.cookies.set(name, value)
        response = NextResponse.next({ request })
        for (const { name, value, options } of cookies) response.cookies.set(name, value, options)
        refreshHeaders = headers
        for (const [name, value] of Object.entries(headers)) response.headers.set(name, value)
      },
    },
  })

  // Verifies the access token (local JWKS check) and refreshes it when it is about to expire.
  const { data } = await supabase.auth.getClaims()
  const signedIn = Boolean(data?.claims?.sub)
  const { pathname } = request.nextUrl

  if (OPEN_PAGES.has(pathname)) return response
  if (AUTH_PAGES.has(pathname)) {
    return signedIn ? redirectTo(request, '/', response, refreshHeaders) : response
  }
  return signedIn ? response : redirectTo(request, '/login', response, refreshHeaders)
}

export const config = {
  // Not the API (it checks the session itself), Next assets or files with an extension.
  matcher: ['/((?!api/|_next/static|_next/image|.*\\.[a-zA-Z0-9]+$).*)'],
}
