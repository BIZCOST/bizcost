import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/** A grey placeholder while data loads (hidden from screen readers; the page announces loading). */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      aria-hidden
      data-slot="skeleton"
      className={cn('animate-pulse rounded-lg bg-foreground/[0.06]', className)}
      {...props}
    />
  )
}
