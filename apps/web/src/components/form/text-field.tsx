'use client'

import { useId, type ComponentProps, type ReactNode } from 'react'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

export interface TextFieldProps extends Omit<ComponentProps<typeof Input>, 'id'> {
  label: ReactNode
  /** Translated error text; marks the input invalid. */
  error?: string
  description?: ReactNode
  /** Right of the label (e.g. a "Forgot password?" link). */
  labelAction?: ReactNode
  /** Replaces the input (e.g. an input with a button inside); receives the accessibility props. */
  render?: (props: {
    id: string
    'aria-invalid': boolean
    'aria-describedby': string | undefined
  }) => ReactNode
}

/** A labelled input with its hint and error, wired for screen readers. */
export function TextField({
  label,
  error,
  description,
  labelAction,
  render,
  ...inputProps
}: TextFieldProps) {
  const id = useId()
  const descriptionId = description ? `${id}-description` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [errorId, descriptionId].filter(Boolean).join(' ') || undefined
  const a11y = { id, 'aria-invalid': Boolean(error), 'aria-describedby': describedBy }
  return (
    <Field data-invalid={Boolean(error) || undefined}>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {labelAction}
      </div>
      {render ? render(a11y) : <Input {...inputProps} {...a11y} />}
      {description && !error ? (
        <FieldDescription id={descriptionId}>{description}</FieldDescription>
      ) : null}
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </Field>
  )
}
