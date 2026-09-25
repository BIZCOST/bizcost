'use client'

import { normalizeCode } from '@bizcost/app-core'
import { AUTH_OTP_LENGTH } from '@bizcost/contracts'
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp'

// The email code: AUTH_OTP_LENGTH cells, paste support, the browser's one-time-code autofill, and
// Arabic-Indic digits accepted (normalized to 0-9). The row stays left to right in Arabic too.

/** Western and Arabic-Indic digits (typed on an Arabic keyboard). */
const DIGITS = '^[0-9٠-٩۰-۹]*$'

export interface CodeInputProps {
  id?: string
  value: string
  onChange: (value: string) => void
  onComplete?: (value: string) => void
  disabled?: boolean
  autoFocus?: boolean
  name?: string
  'aria-invalid'?: boolean
  'aria-describedby'?: string
  'aria-label'?: string
}

export function CodeInput({
  value,
  onChange,
  onComplete,
  'aria-invalid': invalid,
  ...props
}: CodeInputProps) {
  return (
    // LTR row, placed at the start of the field (right in Arabic), never wider than a phone.
    <div dir="ltr" className="w-full max-w-[22rem]">
      <InputOTP
        {...props}
        maxLength={AUTH_OTP_LENGTH}
        value={value}
        onChange={(next) => onChange(normalizeCode(next))}
        onComplete={(next: string) => onComplete?.(normalizeCode(next))}
        pattern={DIGITS}
        pasteTransformer={normalizeCode}
        inputMode="numeric"
        autoComplete="one-time-code"
        aria-invalid={invalid}
        containerClassName="w-full"
      >
        <InputOTPGroup className="grid w-full grid-cols-6 gap-2 has-aria-invalid:ring-0">
          {Array.from({ length: AUTH_OTP_LENGTH }, (_, index) => (
            <InputOTPSlot
              key={index}
              index={index}
              aria-invalid={invalid}
              className="h-12 w-full rounded-lg border bg-card text-xl font-semibold tabular-nums first:rounded-lg last:rounded-lg sm:h-13"
            />
          ))}
        </InputOTPGroup>
      </InputOTP>
    </div>
  )
}
