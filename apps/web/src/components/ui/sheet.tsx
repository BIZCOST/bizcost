'use client'

import { XIcon } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import * as React from 'react'
import { cn } from '@/lib/utils'

// A longer form in a panel (add or edit a material, a product): a sheet that rises from the bottom
// on phones, and a panel on the end side of the screen from 768px. Underneath it is a modal dialog:
// the page behind is inert, Escape and the close button close it, and the focus stays inside. The
// header and the footer (the form's buttons) stay in place while the body scrolls. On a phone they stay
// small, so the form keeps room above the keyboard: the description is left to screen readers and the
// buttons sit side by side.

function Sheet(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="sheet" {...props} />
}

function SheetContent({
  className,
  children,
  closeLabel,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  /** Accessible name of the close button in the corner. */
  closeLabel: string
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        data-slot="sheet-overlay"
        className="fixed inset-0 z-50 bg-black/20 duration-150 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
      />
      <DialogPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          'fixed z-50 flex flex-col bg-popover text-popover-foreground shadow-xl ring-1 ring-foreground/10 duration-200 outline-none',
          // Phones: from the bottom, at most 92% of the screen, above the home indicator.
          'inset-x-0 bottom-0 max-h-[92dvh] rounded-t-2xl pb-[env(safe-area-inset-bottom)] data-open:animate-in data-open:slide-in-from-bottom data-closed:animate-out data-closed:slide-out-to-bottom',
          // From 768px: a panel on the end side, the full height of the screen.
          'md:inset-x-auto md:inset-y-0 md:end-0 md:max-h-none md:w-full md:max-w-xl md:rounded-none md:rounded-s-2xl md:pb-0 md:data-open:slide-in-from-bottom-0 md:data-open:slide-in-from-end md:data-closed:slide-out-to-bottom-0 md:data-closed:slide-out-to-end',
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          aria-label={closeLabel}
          className="absolute end-2 top-2 flex size-11 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring lg:pointer-fine:size-9"
        >
          <XIcon aria-hidden className="size-4" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

function SheetHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-header"
      // The end padding keeps the title clear of the close button at every width.
      className={cn('shrink-0 space-y-1.5 border-b ps-5 pe-14 pt-5 pb-4 sm:ps-6', className)}
      {...props}
    />
  )
}

/** The part that scrolls. */
function SheetBody({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-body"
      className={cn(
        'min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 sm:px-6',
        className,
      )}
      {...props}
    />
  )
}

function SheetFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn(
        'grid shrink-0 grid-cols-2 gap-2 border-t bg-popover px-5 py-3 sm:flex sm:justify-end sm:px-6 sm:py-4',
        className,
      )}
      {...props}
    />
  )
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="sheet-title"
      className={cn('text-lg leading-snug font-semibold [overflow-wrap:anywhere]', className)}
      {...props}
    />
  )
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="sheet-description"
      className={cn('text-sm leading-relaxed text-muted-foreground max-sm:sr-only', className)}
      {...props}
    />
  )
}

export { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle }
