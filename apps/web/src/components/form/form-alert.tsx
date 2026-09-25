import { CircleAlertIcon, CircleCheckIcon, InfoIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

const TONES = {
  error: {
    icon: CircleAlertIcon,
    className: 'border-destructive/25 bg-destructive/5 text-destructive',
  },
  info: { icon: InfoIcon, className: 'border-info/25 bg-info/5 text-foreground [&>svg]:text-info' },
  success: {
    icon: CircleCheckIcon,
    className: 'border-success/25 bg-success/5 text-foreground [&>svg]:text-success',
  },
} as const

/**
 * A message for the whole form. Errors are announced at once (role="alert"); notices politely
 * (role="status").
 */
export function FormAlert({
  tone,
  children,
  className,
}: {
  tone: keyof typeof TONES
  children: ReactNode
  className?: string
}) {
  const { icon: Icon, className: toneClass } = TONES[tone]
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm leading-relaxed',
        toneClass,
        className,
      )}
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
