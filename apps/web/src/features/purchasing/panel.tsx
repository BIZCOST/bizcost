import { useId, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** A part of a purchasing page: a card with its title, an optional line of help and an action. */
export function Panel({
  title,
  hint,
  action,
  children,
  className,
}: {
  title: string
  hint?: string
  /** At the title's end (e.g. a menu). */
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  const id = useId()
  return (
    <section
      aria-labelledby={id}
      className={cn(
        'rounded-2xl bg-card p-4 shadow-sm ring-1 ring-foreground/[0.06] sm:p-5',
        className,
      )}
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={id} className="font-semibold">
            {title}
          </h2>
          {hint ? (
            <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{hint}</p>
          ) : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}
