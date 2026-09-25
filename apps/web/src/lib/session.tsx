'use client'

import { createContext, useContext, type ReactNode } from 'react'

// What the signed-in pages know about the session besides `me`: the verified email (from the
// server, so the first render has it).

const SessionContext = createContext<{ email: string | null }>({ email: null })

export function SessionProvider({
  email,
  children,
}: {
  email: string | null
  children: ReactNode
}) {
  return <SessionContext.Provider value={{ email }}>{children}</SessionContext.Provider>
}

export function useSessionEmail(): string | null {
  return useContext(SessionContext).email
}
