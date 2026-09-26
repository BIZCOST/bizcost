import type { ReactNode } from 'react'
import { PlainTopbar } from './topbar'

/** Signed-in pages outside a business (home, account, Smart Setup): the plain top bar and the page. */
export function PlainShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <PlainTopbar />
      <main id="main" tabIndex={-1} className="flex-1 outline-none">
        {children}
      </main>
    </div>
  )
}
