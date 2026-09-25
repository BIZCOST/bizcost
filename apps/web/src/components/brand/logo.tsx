import { cn } from '@/lib/utils'

// The BizCost logo: three ascending bars and the wordmark (docs/mockups). Always left-to-right, in
// Arabic too: a logo is never mirrored.

export function LogoMark({
  className,
  inverse = false,
}: {
  className?: string
  inverse?: boolean
}) {
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
      className={cn('size-8 shrink-0', className)}
    >
      <rect
        x="3"
        y="17"
        width="7"
        height="12"
        rx="1.75"
        className={inverse ? 'fill-white/70' : 'fill-primary/70'}
      />
      <rect
        x="12.5"
        y="10"
        width="7"
        height="19"
        rx="1.75"
        className={inverse ? 'fill-white/85' : 'fill-primary/85'}
      />
      <rect
        x="22"
        y="3"
        width="7"
        height="26"
        rx="1.75"
        className={inverse ? 'fill-white' : 'fill-primary'}
      />
    </svg>
  )
}

export function Logo({
  className,
  inverse = false,
  size = 'md',
}: {
  className?: string
  inverse?: boolean
  size?: 'md' | 'lg'
}) {
  return (
    <span
      dir="ltr"
      className={cn(
        'inline-flex items-center gap-2 font-bold tracking-tight',
        size === 'lg' ? 'text-3xl' : 'text-xl',
        inverse ? 'text-white' : 'text-brand',
        className,
      )}
    >
      <LogoMark inverse={inverse} className={size === 'lg' ? 'size-10' : 'size-7'} />
      <span lang="en" className="font-(family-name:--font-latin) leading-none">
        BizCost
      </span>
    </span>
  )
}
