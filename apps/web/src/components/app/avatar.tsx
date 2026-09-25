import { UserRoundIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { initials } from '@/lib/initials'
import { cn } from '@/lib/utils'

/** The user's initials in a circle (a person icon when the name has none). */
export function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground',
        className,
      )}
    >
      {initials(name) || <UserRoundIcon className="size-4" />}
    </span>
  )
}

/**
 * A name in either script next to an avatar or icon: the block follows the page direction (so it
 * sits beside the avatar), while the name itself keeps its own direction and is truncated in it.
 */
export function PersonName({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('block text-start', className)}>
      <span dir="auto" className="inline-block max-w-full truncate align-top">
        {children}
      </span>
    </span>
  )
}
