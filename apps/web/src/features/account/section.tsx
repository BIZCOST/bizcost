import { useId, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** One settings block: title and description beside the content on wide screens, above it on phones. */
export function Section({
  anchor,
  title,
  description,
  children,
  danger = false,
}: {
  /** In-page link target (the account page's section list). */
  anchor?: string
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  danger?: boolean
}) {
  const id = useId()
  return (
    <section
      id={anchor}
      aria-labelledby={id}
      className={cn(
        'scroll-mt-24 rounded-2xl bg-card p-5 shadow-sm ring-1 sm:p-6 md:grid md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] md:gap-8 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]',
        danger ? 'ring-destructive/25' : 'ring-foreground/[0.06]',
      )}
    >
      <div className="mb-5 md:mb-0">
        <h2 id={id} className={cn('text-base font-semibold', danger && 'text-destructive')}>
          {title}
        </h2>
        {description ? (
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  )
}
