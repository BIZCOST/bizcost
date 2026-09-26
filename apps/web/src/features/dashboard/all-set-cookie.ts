// "You're all set" can be hidden (D-090), per user and business, in a cookie scoped to the business's
// pages (path /b/<id>): the server reads it too, so the Dashboard is rendered as it will stay, with no
// card that disappears once the page runs. A convenience: without it the card only shows again.

export const ALL_SET_HIDDEN_COOKIE = 'bz_all_set_hidden'
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365
/** Users of this browser who hid it here (a shared computer); the oldest go first. */
const MAX_USERS = 5

/** The users in the cookie's value (user ids joined by "."). */
function usersIn(value: string | undefined): string[] {
  return (value ?? '').split('.').filter((id) => /^[0-9a-f-]{36}$/i.test(id))
}

export function isAllSetHidden(value: string | undefined, userId: string): boolean {
  return userId !== '' && usersIn(value).includes(userId)
}

/** The `document.cookie` assignment that hides the card for `userId` in this business. */
export function hideAllSetCookie(
  value: string | undefined,
  userId: string,
  businessId: string,
  secure: boolean,
): string {
  const users = [...usersIn(value).filter((id) => id !== userId), userId].slice(-MAX_USERS)
  return `${ALL_SET_HIDDEN_COOKIE}=${users.join('.')}; path=/b/${businessId}; max-age=${MAX_AGE_SECONDS}; samesite=lax${secure ? '; secure' : ''}`
}
