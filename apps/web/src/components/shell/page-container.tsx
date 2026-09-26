import type { ReactNode } from 'react'
import { PAGE_CONTAINER } from './sizes'

/** The page area of the business shell: one width and padding for every business page. */
export function PageContainer({ children }: { children: ReactNode }) {
  return <div className={PAGE_CONTAINER}>{children}</div>
}
