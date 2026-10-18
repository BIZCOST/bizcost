'use client'

import { hasVisibleCharacter, QUOTATION_AREA_MAX_LENGTH } from '@bizcost/contracts'
import type { TerminologyProfile } from '@bizcost/domain'
import { ArrowDownIcon, ArrowUpIcon, PencilIcon, PlusIcon } from 'lucide-react'
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { TextField } from '@/components/form/text-field'
import { isolate } from '@/components/form/use-message'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useTerminology } from '@/lib/i18n/client'

// A quotation's areas or rooms in the editor (the owner's round of 2026-10-18, D-299: «يقدر يحدد عدد
// البنود فالمنطقه اللي يطلع اسمها مائل»): each area is a section holding its lines, with how many
// lines it has, its name to change, buttons to move it up or down with its lines, and a line to add
// inside it. The PDF writes its name up the side of exactly these lines.

/** One area: its name and count, its buttons, its lines and "Add a line to …". */
export function AreaSection({
  name,
  count,
  canUp,
  canDown,
  onRename,
  onMove,
  onAddLine,
  children,
}: {
  name: string
  count: number
  canUp: boolean
  canDown: boolean
  onRename: () => void
  onMove: (step: -1 | 1) => void
  onAddLine: () => void
  children: ReactNode
}) {
  const { t } = useTranslation()
  const headingId = useId()
  const area = isolate(name)
  return (
    <section
      aria-labelledby={headingId}
      data-area-section
      className="space-y-3 rounded-2xl border border-s-4 border-s-primary/70 bg-primary/[0.03] p-2 sm:p-3"
    >
      <div className="flex items-center gap-1 ps-1">
        <div className="min-w-0 flex-1">
          <h3
            id={headingId}
            dir="auto"
            data-area-name
            className="text-start font-semibold text-primary [overflow-wrap:anywhere] [unicode-bidi:plaintext]"
          >
            {name}
          </h3>
          <p data-area-count className="text-sm text-muted-foreground">
            {t('documents.quotations.editor.areas.count', { count })}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t('documents.quotations.editor.areas.rename', { area })}
          data-area-rename
          onClick={onRename}
          className="shrink-0 text-muted-foreground"
        >
          <PencilIcon aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t('documents.quotations.editor.areas.moveUp', { area })}
          disabled={!canUp}
          data-area-move="up"
          onClick={() => onMove(-1)}
          className="shrink-0 text-muted-foreground"
        >
          <ArrowUpIcon aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t('documents.quotations.editor.areas.moveDown', { area })}
          disabled={!canDown}
          data-area-move="down"
          onClick={() => onMove(1)}
          className="shrink-0 text-muted-foreground"
        >
          <ArrowDownIcon aria-hidden />
        </Button>
      </div>
      {children}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-area-add-line
        onClick={onAddLine}
        className="text-primary"
      >
        <PlusIcon aria-hidden />
        {t('documents.quotations.editor.areas.addLine', { area })}
      </Button>
    </section>
  )
}

/**
 * The name of a new area, or of one renamed: required (something to see, as the API asks: not only
 * invisible characters), at most QUOTATION_AREA_MAX_LENGTH characters (its name prints up the side of
 * its lines), and not an area the quotation has already. Closed without a name, it gives the focus
 * back to the control that opened it.
 */
export function AreaNameDialog({
  mode,
  initial = '',
  profile,
  taken,
  onCancel,
  onSubmit,
}: {
  mode: 'add' | 'rename'
  initial?: string
  profile: TerminologyProfile
  /** Whether the name is another area of the quotation. */
  taken: (name: string) => boolean
  onCancel: () => void
  onSubmit: (name: string) => void
}) {
  const { t } = useTranslation()
  const term = useTerminology()
  const [name, setName] = useState(initial)
  const [tried, setTried] = useState(false)
  // Once a name is given the editor moves the focus (to the line or the area): the dialog leaves it.
  const given = useRef(false)
  // What had the focus when it opened (it has no trigger of its own to go back to).
  const [opener] = useState(() =>
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null),
  )
  const value = name.replace(/\s+/g, ' ').trim()
  const blank = !hasVisibleCharacter(value)
  const error = blank
    ? tried
      ? t('documents.quotations.editor.areas.errors.required')
      : undefined
    : value.length > QUOTATION_AREA_MAX_LENGTH
      ? t('documents.quotations.editor.errors.tooLong', { count: QUOTATION_AREA_MAX_LENGTH })
      : taken(value)
        ? t('documents.quotations.editor.areas.errors.exists')
        : undefined

  function submit(event: FormEvent) {
    // A form of its own, never the quotation's (a portal's events still reach the page's form).
    event.preventDefault()
    event.stopPropagation()
    setTried(true)
    if (blank || value.length > QUOTATION_AREA_MAX_LENGTH || taken(value)) return
    given.current = true
    onSubmit(value)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        closeLabel={t('actions.close')}
        className="max-w-md"
        data-area-dialog
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (!given.current && opener?.isConnected) opener.focus()
        }}
      >
        <form noValidate onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>
              {mode === 'add'
                ? t('documents.quotations.editor.areas.dialogAdd')
                : t('documents.quotations.editor.areas.dialogRename')}
            </DialogTitle>
            <DialogDescription>
              {t('documents.quotations.editor.areas.dialogHint')}
            </DialogDescription>
          </DialogHeader>
          <TextField
            label={t('documents.quotations.editor.area')}
            autoFocus
            autoComplete="off"
            className="[unicode-bidi:plaintext]"
            placeholder={term('documents.quotations.editor.areaPlaceholder', profile)}
            value={name}
            onChange={(event) => setName(event.target.value)}
            error={error}
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onCancel}>
              {t('actions.cancel')}
            </Button>
            <Button type="submit" className="min-w-24">
              {mode === 'add'
                ? t('documents.quotations.editor.areas.addButton')
                : t('documents.quotations.editor.areas.saveButton')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
