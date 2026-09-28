import { ChevronDownIcon } from 'lucide-react'
import * as React from 'react'
import { cn } from '@/lib/utils'

// The browser's own select, styled like Input: phones open their native picker, keyboards and
// screen readers get the platform's behaviour, and <optgroup> groups long lists (units by kind).
// The arrow sits at the end side in both directions.

function NativeSelect({ className, children, ...props }: React.ComponentProps<'select'>) {
  return (
    <div data-slot="native-select-wrapper" className={cn('relative min-w-0', className)}>
      <select
        data-slot="native-select"
        className="h-11 w-full min-w-0 cursor-pointer appearance-none truncate rounded-lg border border-input bg-card ps-3 pe-9 text-base transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30"
        {...props}
      >
        {children}
      </select>
      <ChevronDownIcon
        aria-hidden
        className="pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  )
}

export { NativeSelect }
