'use client'

import { useTRPC } from '@bizcost/app-core'
import type { CustomerDto, CustomerPickItemDto } from '@bizcost/contracts'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ChevronsUpDownIcon, PlusIcon, XIcon } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { phoneHint, useDebounced } from './data'
import { CustomerName, CustomerSheet } from './customer-sheet'

// The customer of an order, a sale or a payment (M3 Step 5; Q2, D-263): a box to type a name in (or,
// for a member who sees customers, part of a phone number from 3 digits), with the active customers
// that match, each with their phone (or its last 4 digits for a member who may not see customers:
// customer.pick gives them no more), and "+ Add «name» as a new customer", which opens the customer
// form ("Did you mean …?" there picks one of the same name instead). A combobox with a list
// (WAI-ARIA): arrows move through the list, Enter picks, Escape closes it; × takes the customer off.

/** A customer as the picker holds it once picked. */
export type PickedCustomer = CustomerPickItemDto

/** A customer saved by the form, as the picker holds it. */
/** Left-to-right isolate and its end (U+2066, U+2069), and every isolate mark. */
const LRI = '\u2066'
const PDI = '\u2069'
const ISOLATE_MARKS = /[\u2066-\u2069]/g

export function pickedOf(customer: CustomerDto): PickedCustomer {
  return {
    id: customer.id,
    name: customer.name,
    kind: customer.kind,
    phone: customer.phone,
    phoneLast4: null,
    archived: customer.archivedAt !== null,
  }
}

type Option = { kind: 'item'; item: CustomerPickItemDto } | { kind: 'add'; name: string }

export function CustomerPicker({
  value,
  label,
  invalid = false,
  describedBy,
  canAdd,
  disabled = false,
  onChange,
}: {
  /** The customer named ('' / null: none). */
  value: PickedCustomer | null
  /** The box's accessible name. */
  label: string
  invalid?: boolean
  describedBy?: string
  /** The member may add a customer here (customers.items.manage). */
  canAdd: boolean
  /** The customer can't be changed (an order with payments keeps its customer). */
  disabled?: boolean
  onChange: (customer: PickedCustomer | null) => void
}) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const listId = useId()
  const optionId = useId()
  const list = useRef<HTMLUListElement>(null)
  const [open, setOpen] = useState(false)
  // What is typed; null while nothing is (the box shows the customer's name).
  const [typed, setTyped] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const [adding, setAdding] = useState<string | null>(null)
  const search = useDebounced((typed ?? '').trim(), 250)
  const found = useQuery({
    ...trpc.customer.pick.queryOptions({ search: search || undefined }),
    enabled: open,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  })
  const items = (found.data?.items ?? []).filter((item) => !item.archived)
  const name = (typed ?? '').trim()
  const options: Option[] = [
    ...items.map((item) => ({ kind: 'item' as const, item })),
    ...(canAdd && name ? [{ kind: 'add' as const, name }] : []),
  ]
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
    if (option.kind === 'item') onChange(option.item)
    else setAdding(option.name)
  }

  // The phone in a left-to-right isolate (LRI … PDI): after an Arabic name its digit groups would
  // otherwise read reversed in the box (D-297). Typing over it takes the marks out again.
  const hint = value ? phoneHint(value) : null
  const shownName = value
    ? [value.name, hint ? `${LRI}${hint}${PDI}` : null].filter(Boolean).join(' · ')
    : ''

  return (
    <div className="relative">
      <Input
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
        disabled={disabled}
        placeholder={t('orders.customers.picker.placeholder')}
        value={typed ?? shownName}
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
          setTyped(event.target.value.replace(ISOLATE_MARKS, ''))
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
        className={cn('scroll-mt-24 [unicode-bidi:plaintext]', value ? 'pe-16' : 'pe-9')}
      />
      {value && !disabled ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t('orders.customers.picker.clear')}
          onClick={() => onChange(null)}
          className="absolute end-7 top-1/2 size-8 -translate-y-1/2 text-muted-foreground"
        >
          <XIcon aria-hidden />
        </Button>
      ) : null}
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
              {found.isPending
                ? t('status.loading')
                : name
                  ? t('orders.customers.picker.noMatch')
                  : t('orders.customers.picker.none')}
            </li>
          ) : null}
          {options.map((option, index) => (
            <li
              key={option.kind === 'item' ? option.item.id : 'add'}
              id={`${optionId}-${index}`}
              role="option"
              aria-selected={option.kind === 'item' && option.item.id === value?.id}
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
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    {t('orders.customers.picker.add', { name: option.name })}
                  </span>
                </>
              ) : (
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  <CustomerName customer={option.item} />
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {adding !== null ? (
        <CustomerSheet
          name={adding}
          onClose={() => setAdding(null)}
          onSaved={(customer) => onChange(pickedOf(customer))}
          onPickExisting={(customer) => onChange(customer)}
        />
      ) : null}
    </div>
  )
}
