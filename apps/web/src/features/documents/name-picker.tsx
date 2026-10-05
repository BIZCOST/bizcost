'use client'

import { ChevronsUpDownIcon, PlusIcon } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { useLocale } from '@/lib/i18n/client'
import { cn } from '@/lib/utils'
import { pickerOptions, type Pickable } from './picker-options'

// The name of a document line: a purchase line's material (the owner's request of 2026-09-29), a sale
// line's product or service (M3 Step 2). A box to type in, with the records whose names hold what is
// typed (compared the way people read them: case, Arabic letter forms, marks and digits ignored),
// and, when none has that very name, the archived record that has it (marked archived), or "+ Add
// «name» as a new …", which opens the line's quick-add sheet. A combobox with a list (WAI-ARIA):
// arrows move through the list, Enter picks, Escape closes it.

export function NamePicker<T extends Pickable>({
  label,
  value,
  items,
  pickable,
  placeholder,
  invalid,
  describedBy,
  addLabel,
  onPick,
  onAdd,
}: {
  /** The box's accessible name. */
  label: string
  /** The line's record id ('' for none). */
  value: string
  /** Every record the line may name, by id (archived ones too). */
  items: ReadonlyMap<string, T>
  /** What the list offers (active records, and the line's own). */
  pickable: readonly T[]
  /** Shown while nothing is picked ("Pick one", or the name of a record removed since). */
  placeholder: string
  invalid: boolean
  describedBy?: string
  /** "Add «name» as a new material" (or product), in the business's wording. */
  addLabel: (name: string) => string
  onPick: (item: T) => void
  /** Absent: the member may not add one here. */
  onAdd?: (name: string) => void
}) {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const listId = useId()
  const optionId = useId()
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const [open, setOpen] = useState(false)
  // What is typed; null while nothing is (the box shows the picked record's name).
  const [typed, setTyped] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const selected = value ? items.get(value) : undefined
  const options = pickerOptions(typed ?? '', pickable, locale, onAdd !== undefined, [
    ...items.values(),
  ])
  const activeIndex = Math.min(active, options.length - 1)

  // The option moved to with the arrows stays in view.
  useEffect(() => {
    if (!open) return
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex])

  function close() {
    setOpen(false)
    setTyped(null)
    setActive(0)
  }

  function choose(index: number) {
    const option = options[index]
    if (!option) return
    close()
    if (option.kind === 'item') onPick(option.item)
    else onAdd?.(option.name)
  }

  return (
    <div className="relative">
      <Input
        ref={input}
        role="combobox"
        aria-label={label}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          open && options.length > 0 ? `${optionId}-${activeIndex}` : undefined
        }
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={typed ?? selected?.name ?? ''}
        onFocus={(event) => {
          setOpen(true)
          const box = event.currentTarget
          box.select()
          // Low on a phone's screen (the keyboard and the bars below take the rest): the box goes
          // up, so its list has room.
          if (window.innerHeight - box.getBoundingClientRect().bottom < 320) {
            box.scrollIntoView({ block: 'start', behavior: 'smooth' })
          }
        }}
        onClick={() => setOpen(true)}
        onChange={(event) => {
          setTyped(event.target.value)
          setActive(0)
          setOpen(true)
        }}
        onBlur={close}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            if (!open) {
              setOpen(true)
              return
            }
            const step = event.key === 'ArrowDown' ? 1 : -1
            setActive((activeIndex + step + options.length) % Math.max(options.length, 1))
          } else if (event.key === 'Enter') {
            // Never the form's submit: Enter picks.
            event.preventDefault()
            if (open) choose(activeIndex)
            else setOpen(true)
          } else if (event.key === 'Escape' && open) {
            event.preventDefault()
            event.stopPropagation()
            close()
          }
        }}
        className="scroll-mt-24 pe-9 [unicode-bidi:plaintext]"
      />
      <ChevronsUpDownIcon
        aria-hidden
        className="pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
      {open ? (
        <ul
          ref={list}
          id={listId}
          role="listbox"
          aria-label={label}
          // A tap in the list keeps the focus in the box (the pick happens on click).
          onPointerDown={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
          className="absolute inset-x-0 top-full z-30 mt-1 max-h-64 overflow-y-auto overscroll-contain rounded-xl bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-foreground/10"
        >
          {options.length === 0 ? (
            <li role="presentation" className="px-3 py-2.5 text-sm text-muted-foreground">
              {t('purchasing.editor.noMatch')}
            </li>
          ) : null}
          {options.map((option, index) => (
            <li
              key={option.kind === 'item' ? option.item.id : 'add'}
              id={`${optionId}-${index}`}
              role="option"
              aria-selected={option.kind === 'item' && option.item.id === value}
              data-index={index}
              data-add-option={option.kind === 'add' || undefined}
              onClick={() => choose(index)}
              onPointerMove={() => index !== activeIndex && setActive(index)}
              className={cn(
                'flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm lg:pointer-fine:min-h-9',
                index === activeIndex && 'bg-muted',
                option.kind === 'add' && 'font-medium text-primary',
              )}
            >
              {option.kind === 'add' ? (
                <>
                  <PlusIcon aria-hidden className="size-4 shrink-0" />
                  <span className="min-w-0 [overflow-wrap:anywhere]">{addLabel(option.name)}</span>
                </>
              ) : (
                <>
                  <span dir="auto" className="min-w-0 [overflow-wrap:anywhere]">
                    {option.item.name}
                  </span>
                  {option.archived ? (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {t('purchasing.editor.archivedOption')}
                    </span>
                  ) : null}
                </>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
