// An invitation opened while signed out (ROADMAP.md Step 6): the visitor signs in or creates an
// account first, then comes back to the invitation to accept it. The way back is kept in this tab's
// sessionStorage, never in a URL, and only an invitation path is ever followed. Beside it, what the sign
// in and sign up pages show about the invitation: the business name and the invited email, masked as
// the invitation page shows it (r•••@example.com).

const KEY = 'bz_after_sign_in'
const HINT_KEY = 'bz_invitation_hint'

/** `/invite/<token>`: a token is 32 random bytes in base64url (43 characters). */
const INVITE_PATH = /^\/invite\/[A-Za-z0-9_-]{43}$/

export function isInvitePath(value: unknown): value is string {
  return typeof value === 'string' && INVITE_PATH.test(value)
}

/** What the sign in and sign up pages say about a remembered invitation. */
export interface InvitationHint {
  readonly businessName: string
  readonly maskedEmail: string
}

function isHint(value: unknown): value is InvitationHint {
  return (
    typeof value === 'object' &&
    value !== null &&
    'businessName' in value &&
    typeof value.businessName === 'string' &&
    'maskedEmail' in value &&
    typeof value.maskedEmail === 'string'
  )
}

/** Come back to this invitation after signing in (or creating an account) in this tab. */
export function rememberInvitation(token: string, hint?: InvitationHint): void {
  const path = `/invite/${token}`
  if (!isInvitePath(path)) return
  try {
    sessionStorage.setItem(KEY, path)
    if (hint) sessionStorage.setItem(HINT_KEY, JSON.stringify(hint))
    else sessionStorage.removeItem(HINT_KEY)
  } catch {
    // Storage blocked: the user opens the invitation link again after signing in.
  }
}

/** The remembered invitation's business and masked email (not consumed), else null. */
export function invitationHint(): InvitationHint | null {
  try {
    if (!isInvitePath(sessionStorage.getItem(KEY))) return null
    const hint: unknown = JSON.parse(sessionStorage.getItem(HINT_KEY) ?? 'null')
    return isHint(hint) ? hint : null
  } catch {
    return null
  }
}

/** Where to go once signed in: the invitation remembered in this tab (read once), else home. */
export function takeReturnPath(): string {
  try {
    const path = sessionStorage.getItem(KEY)
    sessionStorage.removeItem(KEY)
    sessionStorage.removeItem(HINT_KEY)
    return isInvitePath(path) ? path : '/'
  } catch {
    return '/'
  }
}
