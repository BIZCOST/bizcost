'use client'

import { ATTACHMENT_MAX_BYTES, type ProductDto } from '@bizcost/contracts'
import {
  compareDecimal,
  DIMENSIONS,
  subtractDecimals,
  VAT_CATEGORIES,
  type SaleLineAmounts,
  type StandardUnit,
  type TerminologyProfile,
  type VatCategory,
} from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BookmarkPlusIcon,
  ChevronsUpDownIcon,
  CropIcon,
  ImageIcon,
  ImagePlusIcon,
  Link2OffIcon,
  StickyNoteIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'
import { withLatinDigits, type FieldError } from '@/features/catalog/numbers'
import { UNITS_BY_DIMENSION } from '@/features/catalog/units'
import { useMoney } from '@/features/documents/amounts'
import { framePicture } from '@/features/documents/frame-picture'
import { Caption, DiscountRow, LineMessages, MoneyInput } from '@/features/documents/line-editor'
import { pickerOptions } from '@/features/documents/picker-options'
import { useLocale, useTerminology } from '@/lib/i18n/client'
import { cn } from '@/lib/utils'
import { PictureCropDialog } from './picture-cropper'
import type { LineErrors, LinePicture, QuotationLineDraft } from './quotation-draft'

// A quotation's line in the editor (M3 Step 7; Q21; the owner's document requests of 2026-10-16): the
// area or room it belongs to (offered from the areas already used), its title typed, with the
// business's products and services that match offered as you type (a pick fills in the price and
// unit; a typed title stays a typed line, and "Save as a work item" adds it to Products & Services),
// the details under it (line breaks kept, "Material: …" printed bold), how many in which unit, the
// price, and on demand a highlighted note (red on the PDF), a picture (printed in the PDF's picture
// column) and a discount. The line's amount shows under it. Since the owner's round of 2026-10-18
// (D-299) the area is one of the quotation's areas (or a new one, or none), the line moves up or down
// inside its area with buttons, and every picture is framed as the PDF prints it (800 × 600, filled,
// centred) as soon as it is picked; "Adjust" moves and zooms it in that frame.

/** The images a line's picture may be (as the API takes them: never SVG). */
export const PICTURE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const

/** The area select's choice that names a new area (no area name holds a control character). */
const NEW_AREA = '\u0001new'

/** A picked picture's problem, or null. */
export function pictureProblem(file: File): I18nKey | null {
  return (PICTURE_TYPES as readonly string[]).includes(file.type) &&
    file.size <= ATTACHMENT_MAX_BYTES
    ? null
    : 'documents.quotations.editor.pictureInvalid'
}

/**
 * The line's title: a box to type in, with the products and services whose names hold what is typed
 * (compared the way people read them), a combobox with a list (WAI-ARIA). A pick names the product;
 * typing keeps the text as the line's title. The box keeps the page's direction (its placeholder
 * and its icon on the page's sides), its text in its own direction (as the name pickers).
 */
function TitleBox({
  value,
  label,
  invalid,
  describedBy,
  pickable,
  onType,
  onPick,
}: {
  value: string
  label: string
  invalid: boolean
  describedBy?: string
  pickable: readonly ProductDto[]
  onType: (title: string) => void
  onPick: (product: ProductDto) => void
}) {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const listId = useId()
  const optionId = useId()
  const list = useRef<HTMLUListElement>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const options = useMemo(
    () =>
      pickerOptions(value, pickable, locale, false)
        .flatMap((option) => (option.kind === 'item' ? [option.item] : []))
        .slice(0, 8),
    [value, pickable, locale],
  )
  const shown = open && options.length > 0
  const activeIndex = Math.min(active, options.length - 1)

  useEffect(() => {
    if (!shown) return
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [shown, activeIndex])

  function choose(index: number) {
    const product = options[index]
    setOpen(false)
    setActive(0)
    if (product) onPick(product)
  }

  return (
    <div className="relative">
      <Input
        role="combobox"
        aria-label={label}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        aria-expanded={shown}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={shown ? `${optionId}-${activeIndex}` : undefined}
        autoComplete="off"
        placeholder={t('documents.quotations.editor.titlePlaceholder')}
        value={value}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={() => {
          setOpen(false)
          setActive(0)
        }}
        onChange={(event) => {
          onType(event.target.value)
          setActive(0)
          setOpen(true)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            if (!shown) return setOpen(true)
            const step = event.key === 'ArrowDown' ? 1 : -1
            setActive((activeIndex + step + options.length) % options.length)
          } else if (event.key === 'Enter') {
            // Enter picks from the list, never submits the form.
            event.preventDefault()
            if (shown) choose(activeIndex)
          } else if (event.key === 'Escape' && shown) {
            event.preventDefault()
            event.stopPropagation()
            setOpen(false)
          }
        }}
        className="pe-9 font-medium [unicode-bidi:plaintext]"
      />
      <ChevronsUpDownIcon
        aria-hidden
        className="pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
      {shown ? (
        <ul
          ref={list}
          id={listId}
          role="listbox"
          aria-label={label}
          onPointerDown={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
          className="absolute inset-x-0 top-full z-30 mt-1 max-h-64 overflow-y-auto overscroll-contain rounded-xl bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-foreground/10"
        >
          {options.map((product, index) => (
            <li
              key={product.id}
              id={`${optionId}-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              data-index={index}
              data-product-option
              onClick={() => choose(index)}
              onPointerMove={() => index !== activeIndex && setActive(index)}
              className={cn(
                'flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm lg:pointer-fine:min-h-9',
                index === activeIndex && 'bg-muted',
              )}
            >
              <span dir="auto" className="min-w-0 [overflow-wrap:anywhere]">
                {product.name}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {t(`units.short.${product.unit}`)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** A typed line's unit: none, or a standard unit by kind of measure. */
function UnitBox({
  value,
  label,
  onChange,
}: {
  value: StandardUnit | ''
  label: string
  onChange: (unit: StandardUnit | '') => void
}) {
  const { t } = useTranslation()
  return (
    <NativeSelect
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value as StandardUnit | '')}
    >
      <option value="">{t('documents.quotations.editor.noUnit')}</option>
      {DIMENSIONS.map((dimension) => (
        <optgroup key={dimension} label={t(`units.dimensions.${dimension}`)}>
          {UNITS_BY_DIMENSION[dimension].map((unit) => (
            <option key={unit} value={unit}>
              {t(`units.names.${unit}`)}
            </option>
          ))}
        </optgroup>
      ))}
    </NativeSelect>
  )
}

/**
 * The line's picture: the saved one or the one picked, shown exactly as the PDF frames it (4:3,
 * filled), with Adjust, Change and Remove; or "Add a picture". A picked picture is framed at once
 * (D-299): centred, filling the frame, whatever its shape.
 */
function PictureField({
  line,
  number,
  onPicture,
}: {
  line: QuotationLineDraft
  number: number
  /** Changes the line's picture from the one it has then, and nothing else of the line. */
  onPicture: (change: (picture: LinePicture) => LinePicture) => void
}) {
  const { t } = useTranslation()
  const input = useRef<HTMLInputElement>(null)
  // Each pick, removal or adjustment takes a turn: a picture still being framed when a later choice
  // was made (a large photo, then another) is dropped, never written over it.
  const turn = useRef(0)
  const [error, setError] = useState<I18nKey | null>(null)
  const [adjusting, setAdjusting] = useState<{ src: string; local: boolean } | null>(null)
  const { pending, saved, remove, source } = line.picture
  // The picked file's picture, freed once another is picked or the line goes.
  const pendingUrl = useMemo(() => (pending ? URL.createObjectURL(pending) : null), [pending])
  useEffect(
    () => () => {
      if (pendingUrl) URL.revokeObjectURL(pendingUrl)
    },
    [pendingUrl],
  )
  const shown = pendingUrl ?? (saved && !remove ? saved.url : null)
  const has = pending !== null || (saved !== null && !remove)
  // What "Adjust" opens: the picture as picked; else, once a saved one was adjusted, the saved one;
  // else the picture shown (picked but not read by the browser, or saved).
  const original = source ? source.file : pending
  const canAdjust =
    original !== null || (saved !== null && saved.url !== null && (!remove || source))

  function adjust() {
    if (original) setAdjusting({ src: URL.createObjectURL(original), local: true })
    else if (saved?.url) setAdjusting({ src: saved.url, local: false })
  }
  function stopAdjusting() {
    if (adjusting?.local) URL.revokeObjectURL(adjusting.src)
    setAdjusting(null)
  }

  return (
    <div className="min-w-0">
      <input
        ref={input}
        type="file"
        accept={PICTURE_TYPES.join(',')}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        data-line-picture-input
        onChange={(event) => {
          const picked = event.target.files?.[0]
          event.target.value = ''
          if (!picked) return
          // Framed as the PDF prints it (800 × 600, centred, filled), then checked.
          const mine = ++turn.current
          void framePicture(picked).then(({ file, crop }) => {
            if (mine !== turn.current) return
            const problem = pictureProblem(file)
            setError(problem)
            if (!problem)
              onPicture((current) => ({
                saved: current.saved,
                pending: file,
                remove: current.saved !== null,
                source: crop ? { file: picked, crop } : null,
              }))
          })
        }}
      />
      {has ? (
        <div className="flex items-center gap-3">
          <span className="flex h-15 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted">
            {shown ? (
              // The picked file, or a signed URL of the business's private bucket: a plain image,
              // framed as the PDF frames it (filled, centred).
              <img
                src={shown}
                alt={t('documents.quotations.editor.pictureAlt')}
                className="size-full object-cover"
                data-line-picture
              />
            ) : (
              <ImageIcon aria-hidden className="size-5 text-muted-foreground" />
            )}
          </span>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap gap-1">
              {canAdjust ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={t('documents.quotations.editor.pictureAdjustLine', { number })}
                  data-line-picture-adjust
                  onClick={adjust}
                >
                  <CropIcon aria-hidden />
                  {t('documents.quotations.editor.pictureAdjust')}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => input.current?.click()}
              >
                {t('documents.quotations.editor.pictureChange')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => {
                  turn.current += 1
                  setError(null)
                  onPicture((current) => ({
                    saved: current.saved,
                    pending: null,
                    remove: current.saved !== null,
                    source: null,
                  }))
                }}
              >
                <XIcon aria-hidden />
                {t('documents.quotations.editor.pictureRemove')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('documents.quotations.editor.pictureHint')}
            </p>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="link"
          className="h-9 px-0"
          onClick={() => input.current?.click()}
        >
          <ImagePlusIcon aria-hidden />
          {t('documents.quotations.editor.pictureAdd')}
        </Button>
      )}
      {error ? (
        <p role="alert" className="mt-1 text-sm text-destructive">
          {t(error)}
        </p>
      ) : null}
      {adjusting ? (
        <PictureCropDialog
          src={adjusting.src}
          crop={source?.crop ?? null}
          name={source?.file?.name ?? pending?.name ?? saved?.fileName ?? 'picture'}
          saved={!adjusting.local}
          onPickAgain={() => {
            stopAdjusting()
            input.current?.click()
          }}
          onCancel={stopAdjusting}
          onSave={(file, crop) => {
            turn.current += 1
            onPicture((current) => ({
              saved: current.saved,
              pending: file,
              remove: current.saved !== null,
              source: { file: original, crop },
            }))
            stopAdjusting()
          }}
        />
      ) : null}
    </div>
  )
}

/** One line of the quotation in the editor. */
export function QuotationLineRow({
  index,
  line,
  products,
  pickable,
  areas,
  errors,
  shown,
  amounts,
  vatRegistered,
  profile,
  onChange,
  onPicture,
  onRemove,
  onSaveAsItem,
  onArea,
  onNewArea,
  canMove,
  onMove,
}: {
  index: number
  line: QuotationLineDraft
  products: ReadonlyMap<string, ProductDto>
  /** What the title box offers (active products and services, and the line's own). */
  pickable: readonly ProductDto[]
  /** The quotation's areas (the line's own among them). */
  areas: readonly string[]
  errors: LineErrors | undefined
  shown: (error: FieldError | undefined) => string | undefined
  amounts: SaleLineAmounts | undefined
  vatRegistered: boolean
  profile: TerminologyProfile
  onChange: (line: QuotationLineDraft) => void
  /** Changes only the line's picture, from the one it has then. */
  onPicture: (change: (picture: LinePicture) => LinePicture) => void
  onRemove: (() => void) | undefined
  /** Opens the product form for the typed title (absent: may not add products). */
  onSaveAsItem?: () => void
  /** Puts the line in another area (null: in none). */
  onArea: (area: string | null) => void
  /** Asks the name of a new area to put the line in. */
  onNewArea: () => void
  /** Whether it can move up (-1) or down (1): inside its area, or past the block beside it. */
  canMove: (step: -1 | 1) => boolean
  onMove: (step: -1 | 1) => void
}) {
  const { t } = useTranslation()
  const term = useTerminology()
  const money = useMoney()
  const messagesId = useId()
  const product = line.productId ? products.get(line.productId) : undefined
  const [noteOpen, setNoteOpen] = useState(line.note !== '')
  const messages = [
    shown(errors?.title),
    shown(errors?.qty),
    shown(errors?.price),
    shown(errors?.discount),
    shown(errors?.area),
    shown(errors?.details),
    shown(errors?.note),
  ].filter((m): m is string => Boolean(m))
  const describedBy = messages.length > 0 ? messagesId : undefined
  const priceLabel = !vatRegistered
    ? t('documents.quotations.editor.price')
    : product?.priceIncludesVat
      ? t('documents.quotations.editor.priceInclVat')
      : t('documents.quotations.editor.priceBeforeVat')

  function pick(next: ProductDto) {
    onChange({
      ...line,
      productId: next.id,
      title: next.name,
      unit: next.unit,
      vatCategory: next.vatCategory,
      // A new pick takes its usual price; a price already typed stays.
      price: line.price.trim() !== '' ? line.price : (next.defaultPrice ?? ''),
    })
  }

  return (
    <fieldset
      data-quotation-line
      className="rounded-xl border bg-background/60 p-3 sm:p-4"
      aria-describedby={describedBy}
    >
      <legend className="sr-only">
        {t('documents.quotations.editor.line', { number: index + 1 })}
      </legend>
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className="mt-2.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground"
        >
          {index + 1}
        </span>
        <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2.4fr)]">
          <div className="min-w-0">
            <Caption>{t('documents.quotations.editor.area')}</Caption>
            {/* One of the quotation's areas, none, or a new one (its name asked): the line moves
                into that area's section (D-299). */}
            <NativeSelect
              aria-label={t('documents.quotations.editor.area')}
              aria-invalid={Boolean(shown(errors?.area))}
              data-line-area
              value={line.area ?? ''}
              onChange={(event) => {
                const value = event.target.value
                if (value === NEW_AREA) onNewArea()
                else onArea(value === '' ? null : value)
              }}
            >
              <option value="">{t('documents.quotations.editor.areas.none')}</option>
              {areas.map((area) => (
                <option key={area} value={area}>
                  {area}
                </option>
              ))}
              <option value={NEW_AREA}>{t('documents.quotations.editor.areas.new')}</option>
            </NativeSelect>
          </div>
          <div className="min-w-0">
            <Caption>{t('documents.quotations.editor.title')}</Caption>
            <TitleBox
              value={line.title}
              label={t('documents.quotations.editor.title')}
              invalid={Boolean(shown(errors?.title))}
              describedBy={describedBy}
              pickable={pickable}
              onType={(title) => onChange({ ...line, title })}
              onPick={pick}
            />
          </div>
        </div>
        {onRemove ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('documents.quotations.editor.removeLine', { number: index + 1 })}
            onClick={onRemove}
            className="mt-5 shrink-0 text-muted-foreground"
          >
            <Trash2Icon aria-hidden />
          </Button>
        ) : null}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 ps-8 text-sm">
        {product ? (
          <>
            <span data-line-product className="text-muted-foreground">
              {term('documents.quotations.editor.fromList', profile)}
            </span>
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-8 px-0"
              onClick={() => onChange({ ...line, productId: null })}
            >
              <Link2OffIcon aria-hidden />
              {t('documents.quotations.editor.unlink')}
            </Button>
          </>
        ) : line.title.trim() !== '' ? (
          <>
            <span className="text-muted-foreground">{t('documents.quotations.editor.typed')}</span>
            {onSaveAsItem ? (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-8 px-0"
                data-save-as-item
                onClick={onSaveAsItem}
              >
                <BookmarkPlusIcon aria-hidden />
                {term('documents.quotations.editor.saveAsItem', profile)}
              </Button>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="mt-2 ps-8">
        <Caption>{t('documents.quotations.editor.details')}</Caption>
        <Textarea
          aria-label={t('documents.quotations.editor.details')}
          aria-invalid={Boolean(shown(errors?.details))}
          rows={2}
          placeholder={t('documents.quotations.editor.detailsPlaceholder')}
          value={line.details}
          onChange={(event) => onChange({ ...line, details: event.target.value })}
          className="min-h-16 [unicode-bidi:plaintext]"
        />
      </div>

      <div
        className={cn(
          'mt-2 grid gap-2 ps-8',
          vatRegistered && !product
            ? 'grid-cols-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1.6fr)_minmax(0,1.2fr)]'
            : 'grid-cols-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1.6fr)]',
        )}
      >
        <div className="min-w-0">
          <Caption>{t('documents.quotations.editor.qty')}</Caption>
          <Input
            aria-label={t('documents.quotations.editor.qty')}
            aria-invalid={Boolean(shown(errors?.qty))}
            inputMode="decimal"
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
            value={line.qty}
            onChange={(event) => onChange({ ...line, qty: event.target.value })}
            onBlur={() => onChange({ ...line, qty: withLatinDigits(line.qty) })}
            className="tabular-nums rtl:text-end"
          />
        </div>
        <div className="min-w-0">
          <Caption>{t('documents.quotations.editor.unit')}</Caption>
          {product ? (
            <p className="flex h-11 items-center rounded-lg border bg-muted/50 px-3 text-sm text-muted-foreground">
              {t(`units.names.${product.unit}`)}
            </p>
          ) : (
            <UnitBox
              value={line.unit}
              label={t('documents.quotations.editor.unit')}
              onChange={(unit) => onChange({ ...line, unit })}
            />
          )}
        </div>
        <div className="col-span-2 min-w-0 sm:col-span-1">
          <Caption>{priceLabel}</Caption>
          <MoneyInput
            label={priceLabel}
            value={line.price}
            invalid={Boolean(shown(errors?.price))}
            describedBy={describedBy}
            onChange={(price) => onChange({ ...line, price })}
          />
        </div>
        {vatRegistered && !product ? (
          <div className="col-span-2 min-w-0 sm:col-span-1">
            <Caption>{t('documents.quotations.editor.vat')}</Caption>
            <NativeSelect
              aria-label={t('documents.quotations.editor.vat')}
              value={line.vatCategory}
              onChange={(event) =>
                onChange({ ...line, vatCategory: event.target.value as VatCategory })
              }
            >
              {VAT_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {t(`documents.quotations.editor.vatCategories.${category}`)}
                </option>
              ))}
            </NativeSelect>
          </div>
        ) : null}
      </div>

      <div className="mt-2 space-y-2 ps-8">
        {noteOpen ? (
          <div className="min-w-0">
            <div className="flex items-center justify-between gap-2">
              <Caption>{t('documents.quotations.editor.note')}</Caption>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground"
                aria-label={t('documents.quotations.editor.noteRemove')}
                onClick={() => {
                  onChange({ ...line, note: '' })
                  setNoteOpen(false)
                }}
              >
                <XIcon aria-hidden />
              </Button>
            </div>
            <Textarea
              aria-label={t('documents.quotations.editor.note')}
              aria-invalid={Boolean(shown(errors?.note))}
              rows={1}
              placeholder={t('documents.quotations.editor.notePlaceholder')}
              value={line.note}
              onChange={(event) => onChange({ ...line, note: event.target.value })}
              className="min-h-11 font-medium text-destructive [unicode-bidi:plaintext]"
            />
          </div>
        ) : null}
        <PictureField line={line} number={index + 1} onPicture={onPicture} />
        <div className="flex flex-wrap items-center gap-x-4">
          {noteOpen ? null : (
            <Button
              type="button"
              variant="link"
              className="h-9 px-0"
              onClick={() => setNoteOpen(true)}
            >
              <StickyNoteIcon aria-hidden />
              {t('documents.quotations.editor.noteAdd')}
            </Button>
          )}
          <DiscountRow
            kind={line.discountKind}
            value={line.discount}
            invalid={Boolean(shown(errors?.discount))}
            describedBy={describedBy}
            addLabel={t('purchasing.editor.addDiscount')}
            label={t('purchasing.editor.lineDiscount')}
            onChange={(next) =>
              onChange({ ...line, discountKind: next.kind, discount: next.value })
            }
            className={line.discountKind === 'none' ? undefined : 'basis-full'}
          />
        </div>
      </div>

      <LineMessages id={messagesId} messages={messages} className="ps-8" />
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-2">
        {/* Up and down: inside its area, or past the area or line beside it (D-299). */}
        <div className="flex shrink-0 gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('documents.quotations.editor.areas.lineUp', { number: index + 1 })}
            disabled={!canMove(-1)}
            data-line-move="up"
            onClick={() => onMove(-1)}
            className="text-muted-foreground"
          >
            <ArrowUpIcon aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('documents.quotations.editor.areas.lineDown', { number: index + 1 })}
            disabled={!canMove(1)}
            data-line-move="down"
            onClick={() => onMove(1)}
            className="text-muted-foreground"
          >
            <ArrowDownIcon aria-hidden />
          </Button>
        </div>
        {amounts ? (
          <p className="ms-auto flex flex-wrap items-baseline justify-end gap-x-3 text-sm">
            {/* The line's VAT only while it is the VAT of the amount beside it: a discount on the
              whole quotation or a rounded total moves part of it (the totals show VAT per rate). */}
            {vatRegistered &&
            compareDecimal(amounts.vat, '0') > 0 &&
            compareDecimal(amounts.documentDiscount, '0') === 0 &&
            compareDecimal(amounts.adjustment, '0') === 0 ? (
              <span data-line-vat className="text-muted-foreground">
                {t('documents.quotations.editor.lineVat', { amount: money(amounts.vat) })}
              </span>
            ) : null}
            <span data-line-total className="font-medium">
              {t('documents.quotations.editor.lineAmount', {
                amount: money(subtractDecimals(amounts.subtotal, amounts.discount)),
              })}
              {amounts.priceIncludesVat && compareDecimal(amounts.vat, '0') > 0 ? (
                <span className="ms-1 font-normal text-muted-foreground">
                  {t('sales.view.inclVat')}
                </span>
              ) : null}
            </span>
          </p>
        ) : null}
      </div>
    </fieldset>
  )
}
