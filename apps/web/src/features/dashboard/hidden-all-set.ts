'use client'

import { useSyncExternalStore } from 'react'
import { ALL_SET_HIDDEN_COOKIE, hideAllSetCookie, isAllSetHidden } from './all-set-cookie'

const listeners = new Set<() => void>()
/** Hidden during this visit, also when the browser could not remember it. */
const hiddenNow = new Set<string>()

function cookieValue(): string | undefined {
  try {
    const prefix = `${ALL_SET_HIDDEN_COOKIE}=`
    return document.cookie
      .split('; ')
      .find((part) => part.startsWith(prefix))
      ?.slice(prefix.length)
  } catch {
    return undefined
  }
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

/**
 * Whether this user hid "You're all set" for this business, and a way to hide it. `serverHidden` is
 * what the server read from the cookie: the first render (and hydration) uses it.
 */
export function useAllSetHidden(
  userId: string,
  businessId: string,
  serverHidden: boolean,
): [boolean, () => void] {
  const key = `${userId}:${businessId}`
  const hidden = useSyncExternalStore(
    subscribe,
    () => hiddenNow.has(key) || isAllSetHidden(cookieValue(), userId),
    () => serverHidden,
  )
  const hide = () => {
    hiddenNow.add(key)
    try {
      document.cookie = hideAllSetCookie(
        cookieValue(),
        userId,
        businessId,
        window.location.protocol === 'https:',
      )
    } catch {
      // Not remembered by the browser: hidden until the page is loaded again.
    }
    for (const listener of listeners) listener()
  }
  return [hidden, hide]
}
