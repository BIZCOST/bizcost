'use client'

import type { ProductDto } from '@bizcost/contracts'
import { areaBlocks, areaKey, areaNames, type TerminologyProfile } from '@bizcost/domain'
import { LayersIcon, PlusIcon } from 'lucide-react'
import { useMemo, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { FormAlert } from '@/components/form/form-alert'
import { isolate } from '@/components/form/use-message'
import { Button } from '@/components/ui/button'
import type { FieldError } from '@/features/catalog/numbers'
import { ProductSheet } from '@/features/catalog/product-sheet'
import {
  addLineTo,
  areaTaken,
  canMoveArea,
  canMoveLine,
  moveArea,
  moveLine,
  renameArea,
  setLineArea,
} from './areas'
import { AreaNameDialog, AreaSection } from './quotation-areas'
import {
  isBlankLine,
  newQuotationLine,
  type LineErrors,
  type LinePicture,
  type QuotationLineDraft,
} from './quotation-draft'
import { QuotationLineRow } from './quotation-lines'
import type { SaleLineAmounts } from '@bizcost/domain'

// A document's lines in its editor (M3 Step 7, D-299; shared with the invoice made from scratch, M3
// Step 8): each line a product or service picked by name or typed ("Save as a work item"), with its
// area, details, red note and picture; the lines grouped under their areas ("Add an area", a line moved
// into another area or out of any, lines and areas moved up and down with buttons, each area with how
// many lines it has). The focus follows what moved and stays clear of a phone's save bar.

export function DocumentLines({
  lines,
  setLines,
  products,
  onProductSaved,
  errors,
  shown,
  lineAmounts,
  vatRegistered,
  profile,
  canSeeProducts,
  canAddProducts,
  form,
  phoneBar,
  typedLabel,
}: {
  lines: readonly QuotationLineDraft[]
  /** Changes the lines from the ones they are then. */
  setLines: (change: (lines: readonly QuotationLineDraft[]) => QuotationLineDraft[]) => void
  /** Every product and service the lines may name, by id (archived ones included). */
  products: ReadonlyMap<string, ProductDto>
  /** A typed line saved as a work item: its product, to name from now on. */
  onProductSaved: (product: ProductDto) => void
  errors: Readonly<Record<string, LineErrors>>
  shown: (error: FieldError | undefined) => string | undefined
  lineAmounts: ReadonlyMap<string, SaleLineAmounts>
  vatRegistered: boolean
  profile: TerminologyProfile
  canSeeProducts: boolean
  canAddProducts: boolean
  /** The editor's form (where the focus is looked for). */
  form: RefObject<HTMLFormElement | null>
  /** A phone's save bar at the foot (a line moved down lands clear of it). */
  phoneBar: RefObject<HTMLDivElement | null>
  /** "Typed on this quotation" (an invoice says its own). */
  typedLabel?: string
}) {
  const { t } = useTranslation()
  const [saveAsItem, setSaveAsItem] = useState<QuotationLineDraft | null>(null)
  // The name asked for a new area (from "Add an area", or for a line), or for one renamed.
  const [naming, setNaming] = useState<
    { kind: 'add' } | { kind: 'line'; lineId: string } | { kind: 'rename'; area: string } | null
  >(null)
  // What a move did, said to a screen reader (the buttons keep the focus).
  const [announcement, setAnnouncement] = useState('')
  const pickable = useMemo(() => {
    const named = new Set(lines.map((line) => line.productId))
    return [...products.values()].filter((p) => p.archivedAt === null || named.has(p.id))
  }, [products, lines])
  const areas = useMemo(() => areaNames(lines), [lines])
  const blocks = useMemo(() => areaBlocks(lines), [lines])
  const numbers = useMemo(
    () => new Map(lines.map((line, index) => [line.id, index] as const)),
    [lines],
  )

  const setLine = (next: QuotationLineDraft) =>
    setLines((all) => all.map((line) => (line.id === next.id ? next : line)))
  /**
   * Changes only line `id`'s picture, from the picture it has now: a picture framed while the line
   * changed (its title typed, its area changed) never brings back the line as it was.
   */
  const setLinePicture = (id: string, change: (picture: LinePicture) => LinePicture) =>
    setLines((all) =>
      all.map((line) => (line.id === id ? { ...line, picture: change(line.picture) } : line)),
    )
  const removeLine = (id: string) => setLines((all) => all.filter((line) => line.id !== id))
  /**
   * Focuses the first of `selectors` that is on the page and can take it, once React has drawn, and
   * scrolls it into view clear of the bars: the top bar and a phone's tab bar (the page's scroll
   * padding), and a phone's save bar above the tab bar (WCAG 2.4.11), where a line moved down lands.
   */
  const focusSoon = (...selectors: string[]) =>
    setTimeout(() => {
      for (const selector of selectors) {
        const target = form.current?.querySelector<HTMLElement>(selector)
        if (target && !(target as HTMLButtonElement).disabled) {
          target.focus({ preventScroll: true })
          target.scrollIntoView({ block: 'nearest' })
          const bar = phoneBar.current
          if (bar && bar.offsetParent !== null) {
            const under = target.getBoundingClientRect().bottom - bar.getBoundingClientRect().top
            if (under > -8) target.scrollIntoView({ block: 'center' })
          }
          return
        }
      }
    })
  /** A new line at the end of `area` (null: at the end, in no area), its title focused. */
  const addLine = (area: string | null = null) => {
    const line = newQuotationLine()
    setLines((all) => addLineTo(all, line, area))
    focusSoon(`[data-line-id="${line.id}"] [role="combobox"][aria-autocomplete]`)
  }
  const lineAt = (id: string) => numbers.get(id) ?? -1
  function moveLineBy(id: string, step: -1 | 1) {
    const next = moveLine(lines, id, step)
    setLines(() => next)
    const to = next.findIndex((line) => line.id === id) + 1
    setAnnouncement(t('documents.quotations.editor.areas.lineMoved', { number: to }))
    const there = `[data-line-id="${id}"] [data-line-move="${step < 0 ? 'up' : 'down'}"]`
    const back = `[data-line-id="${id}"] [data-line-move="${step < 0 ? 'down' : 'up'}"]`
    focusSoon(there, back)
  }
  function moveAreaBy(name: string, step: -1 | 1) {
    setLines(() => moveArea(lines, name, step))
    setAnnouncement(t('documents.quotations.editor.areas.areaMoved', { area: isolate(name) }))
    const section = `[data-area-key="${CSS.escape(areaKey(name))}"]`
    focusSoon(
      `${section} [data-area-move="${step < 0 ? 'up' : 'down'}"]`,
      `${section} [data-area-move="${step < 0 ? 'down' : 'up'}"]`,
    )
  }
  function putLineIn(id: string, area: string | null) {
    const number = lineAt(id) + 1
    // An area started with an empty line (nothing entered in it) takes the line in its place.
    setLines(() => setLineArea(lines, id, area, isBlankLine))
    setAnnouncement(
      area === null
        ? t('documents.quotations.editor.areas.lineToNone', { number })
        : t('documents.quotations.editor.areas.lineToArea', { number, area: isolate(area) }),
    )
    focusSoon(`[data-line-id="${id}"] [data-line-area]`)
  }
  function named(name: string) {
    if (!naming) return
    if (naming.kind === 'add') {
      // A line nothing was entered in yet, without an area, goes into the new area (a new
      // document's first line); else the area starts with a new line.
      const blank = lines.findLast((line) => line.area === null && isBlankLine(line))
      if (blank) {
        setLines(() => setLineArea(lines, blank.id, name))
        focusSoon(`[data-line-id="${blank.id}"] [role="combobox"][aria-autocomplete]`)
      } else addLine(name)
    } else if (naming.kind === 'line') putLineIn(naming.lineId, name)
    else {
      setLines(() => renameArea(lines, naming.area, name))
      // The area's section is drawn again under its new name: the focus goes back to its button.
      focusSoon(`[data-area-key="${CSS.escape(areaKey(name))}"] [data-area-rename]`)
    }
    setNaming(null)
  }

  function savedAsItem(lineId: string, product: ProductDto) {
    onProductSaved(product)
    setLines((all) =>
      all.map((line) =>
        line.id === lineId
          ? {
              ...line,
              productId: product.id,
              title: product.name,
              unit: product.unit,
              vatCategory: product.vatCategory,
              price: line.price.trim() !== '' ? line.price : (product.defaultPrice ?? ''),
            }
          : line,
      ),
    )
  }

  return (
    <>
      {!canSeeProducts ? (
        <FormAlert tone="info" className="mb-3">
          {t('documents.quotations.editor.typedOnly')}
        </FormAlert>
      ) : null}
      <div className="space-y-3">
        {blocks.map((block, b) => {
          const rows = block.lines.map((line) => (
            <div key={line.id} data-line-id={line.id}>
              <QuotationLineRow
                index={lineAt(line.id)}
                line={line}
                products={products}
                pickable={pickable}
                areas={areas}
                errors={errors[line.id]}
                shown={shown}
                amounts={lineAmounts.get(line.id)}
                vatRegistered={vatRegistered}
                profile={profile}
                onChange={setLine}
                onPicture={(change) => setLinePicture(line.id, change)}
                onRemove={lines.length > 1 ? () => removeLine(line.id) : undefined}
                onSaveAsItem={
                  canAddProducts && canSeeProducts ? () => setSaveAsItem(line) : undefined
                }
                onArea={(area) => putLineIn(line.id, area)}
                onNewArea={() => setNaming({ kind: 'line', lineId: line.id })}
                canMove={(step) => canMoveLine(lines, line.id, step)}
                onMove={(step) => moveLineBy(line.id, step)}
                typedLabel={typedLabel}
              />
            </div>
          ))
          if (block.area === null) return rows
          const name = block.area
          return (
            <div key={`area:${areaKey(name)}`} data-area-key={areaKey(name)}>
              <AreaSection
                name={name}
                count={block.lines.length}
                canUp={b > 0 && canMoveArea(lines, name, -1)}
                canDown={canMoveArea(lines, name, 1)}
                onRename={() => setNaming({ kind: 'rename', area: name })}
                onMove={(step) => moveAreaBy(name, step)}
                onAddLine={() => addLine(name)}
              >
                {rows}
              </AreaSection>
            </div>
          )
        })}
        <p className="sr-only" role="status" aria-live="polite">
          {announcement}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => addLine(null)}>
            <PlusIcon aria-hidden />
            {areas.length > 0
              ? t('documents.quotations.editor.areas.addLineNoArea')
              : t('documents.quotations.editor.addLine')}
          </Button>
          <Button
            type="button"
            variant="outline"
            data-area-add
            onClick={() => setNaming({ kind: 'add' })}
          >
            <LayersIcon aria-hidden />
            {t('documents.quotations.editor.areas.add')}
          </Button>
        </div>
      </div>

      {/* The dialogs' own forms are drawn elsewhere but sit inside the editor's form in React's tree:
          their submit stops here, never reaching the editor (which would save the document). */}
      <div className="contents" onSubmit={(event) => event.stopPropagation()}>
        {naming ? (
          <AreaNameDialog
            mode={naming.kind === 'rename' ? 'rename' : 'add'}
            initial={naming.kind === 'rename' ? naming.area : ''}
            profile={profile}
            taken={(name) => areaTaken(lines, name, naming.kind === 'rename' ? naming.area : null)}
            onCancel={() => setNaming(null)}
            onSubmit={named}
          />
        ) : null}

        {saveAsItem ? (
          <ProductSheet
            name={saveAsItem.title.trim()}
            start={{
              unit: saveAsItem.unit === '' ? undefined : saveAsItem.unit,
              price: saveAsItem.price.trim() || undefined,
              vatCategory: saveAsItem.vatCategory,
            }}
            profile={profile}
            resale="none"
            onSaved={(product) => savedAsItem(saveAsItem.id, product)}
            onClose={() => setSaveAsItem(null)}
          />
        ) : null}
      </div>
    </>
  )
}
