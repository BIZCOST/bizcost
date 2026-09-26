import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * A page-level state instead of the page's content: a page not open to the member (403), a section
 * turned off, a business the member left. An icon, a title (the page's h1), a line of help and a way
 * on. `tone` muted for access, destructive for errors. `documentTitle` replaces the page's title
 * (read by screen readers after a navigation), so it names the state rather than the page.
 */
export function StatePanel({
  icon: Icon,
  title,
  body,
  children,
  tone = 'muted',
  card = true,
  documentTitle,
  className,
}: {
  icon: LucideIcon
  title: string
  body: ReactNode
  /** The way on: one or two buttons. */
  children?: ReactNode
  tone?: 'muted' | 'accent' | 'destructive'
  /** Inside a card (in a page) or bare (a whole screen). */
  card?: boolean
  /** The document's title while the state shows, e.g. "This page isn't open to you · BizCost". */
  documentTitle?: string
  className?: string
}) {
  return (
    <>
      {documentTitle ? <title>{documentTitle}</title> : null}
      <div
        className={cn(
          'mx-auto flex max-w-xl flex-col items-center px-6 py-12 text-center sm:py-14',
          card && 'rounded-2xl bg-card shadow-sm ring-1 ring-foreground/[0.06]',
          className,
        )}
      >
        <span
          className={cn(
            'flex size-14 items-center justify-center rounded-2xl',
            tone === 'muted' && 'bg-muted text-muted-foreground',
            tone === 'accent' && 'bg-accent text-primary',
            tone === 'destructive' && 'bg-destructive/10 text-destructive',
          )}
        >
          <Icon aria-hidden className="size-6" />
        </span>
        <h1 className="mt-5 text-xl font-semibold tracking-tight text-balance">{title}</h1>
        <div className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground sm:text-base">
          {body}
        </div>
        {children ? (
          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-center">
            {children}
          </div>
        ) : null}
      </div>
    </>
  )
}
