'use client'

import { EyeIcon, EyeOffIcon } from 'lucide-react'
import { useState, type ComponentProps } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/**
 * A password input with a show/hide button. Passwords are typed left to right in Arabic too, so the
 * whole field is LTR: the text's end padding and the button are both on the right.
 */
export function PasswordInput({ className, ...props }: Omit<ComponentProps<typeof Input>, 'type'>) {
  const { t } = useTranslation()
  const [visible, setVisible] = useState(false)
  return (
    <div dir="ltr" className="relative">
      <Input
        {...props}
        type={visible ? 'text' : 'password'}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        className={cn('pe-11', className)}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? t('password.hide') : t('password.show')}
        aria-pressed={visible}
        className="absolute inset-y-0 end-0 flex w-11 items-center justify-center rounded-e-lg text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring"
      >
        {visible ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
      </button>
    </div>
  )
}
