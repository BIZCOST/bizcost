import type { ReactNode } from 'react'

/**
 * The mark of a field that must be filled, after its label (the field also says so to screen
 * readers, with aria-required).
 */
export function Required({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <span aria-hidden className="ms-0.5 text-destructive">
        *
      </span>
    </>
  )
}
