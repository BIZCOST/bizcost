'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import {
  RECIPE_LINES_MAX,
  type MaterialCostDto,
  type MaterialDto,
  type ProductDto,
  type RecipeDto,
  type RecipeLineDto,
} from '@bizcost/contracts'
import {
  compareDecimal,
  costPerUnit,
  newId,
  sumDecimals,
  unitCostOf,
  type Quantity,
  type TerminologyProfile,
} from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  EllipsisVerticalIcon,
  PlusIcon,
  Trash2Icon,
} from 'lucide-react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useId, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { useUnsavedChanges } from '@/components/form/unsaved-changes'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Locked, useMoney, useUnitCost } from '@/features/documents/amounts'
import { useAllMaterials } from '@/features/purchasing/data'
import {
  dimensionsOf,
  isUnitOf,
  lineUnitOf,
  quantityInWords,
  unitRefOf,
  type LineUnit,
} from '@/features/purchasing/line-units'
import { can } from '@/features/settings/sections'
import { useLocale, useTerminology } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import { listOfNames } from './names'
import { readQuantity, withLatinDigits, type FieldError } from './numbers'
import {
  checkRecipe,
  isSaved,
  lineCostOf,
  moveLine,
  recipeDraft,
  recipeUnitOf,
  type RecipeLineDraft,
  type RecipeLineErrors,
} from './recipe-draft'
import { PackChainText, useFormatQuantity, useUnitQuantity } from './unit-parts'
import { NBSP, UNITS_BY_DIMENSION, type ChainStep } from './units'

// What goes into a product or service (M2 Step 4; D-115, D-146): "Recipe / الوصفة" for food,
// "Materials used / المواد المستخدمة" otherwise. First what it makes ("This recipe makes: 12
// pieces", «الوصفة تكفي: 12 قطعة»; 1 by default, D-178), then a line per material, packaging
// included: the quantity the recipe uses, in any unit or pack of the material ("200 ml = 0.2 L" as it
// is typed), and what it costs at the material's average, rounded only here. A material never bought
// says "No price yet", never 0, and the total says the recipe is incomplete, naming what has no
// price. Each line's menu moves it up or down (the recipe keeps its order) or takes it out. The total
// stays in view at the bottom with, for a recipe that makes more than one, what one unit sold costs
// (the total ÷ what it makes, as it is typed), and says how a material gets a price. Members who may
// see recipes but not costs see the quantities and a lock; members who may not change it read it, in
// the same words. A save names the version it read (a clash says so); a save that changes nothing
// only closes, and closing with changes not saved asks first.

/** Problems that only say something is missing: shown once the person tries to save. */
const MISSING: ReadonlySet<I18nKey> = new Set<I18nKey>([
  'catalog.recipes.needMaterial',
  'catalog.numbers.required',
  'catalog.form.pickUnit',
])

/** A line's cost as the screen shows it. */
type LineCost =
  | { kind: 'locked' }
  | { kind: 'none' }
  | { kind: 'pending' }
  | { kind: 'priced'; amount: string; perUnit: string | undefined; unit: MaterialDto['unit'] }

/** A small caption over a box (the box has its own accessible name). */
function Caption({ children }: { children: ReactNode }) {
  return (
    <span aria-hidden className="mb-1 block text-xs font-medium text-muted-foreground">
      {children}
    </span>
  )
}

/** A line's cost, at the end of the line: the amount, and the average per unit under it. */
function CostCell({ cost, className }: { cost: LineCost; className?: string }) {
  const { t } = useTranslation()
  const money = useMoney()
  const unitCost = useUnitCost()
  let content: ReactNode = null
  if (cost.kind === 'locked') content = <Locked category="cost" />
  else if (cost.kind === 'none') {
    content = (
      <span data-no-price className="text-muted-foreground">
        {t('catalog.recipes.noPrice')}
      </span>
    )
  } else if (cost.kind === 'priced') {
    content = (
      <>
        <bdi data-line-cost className="block font-medium text-foreground tabular-nums">
          {money(cost.amount).replaceAll(' ', NBSP)}
        </bdi>
        {cost.perUnit !== undefined ? (
          <bdi className="block text-xs text-muted-foreground tabular-nums">
            {`${unitCost(cost.perUnit)}${NBSP}${t(`units.per.${cost.unit}`).replaceAll(' ', NBSP)}`}
          </bdi>
        ) : null}
      </>
    )
  }
  return <div className={cn('min-w-0 text-sm text-end', className)}>{content}</div>
}

/** The unit box of a line: the material's packs, then the units of its kinds of measure. */
function UnitBox({
  material,
  value,
  onChange,
  invalid,
  describedBy,
}: {
  material: MaterialDto | undefined
  value: LineUnit
  onChange: (unit: LineUnit) => void
  invalid: boolean
  describedBy: string | undefined
}) {
  const { t } = useTranslation()
  const unitQuantity = useUnitQuantity()
  const valid = material !== undefined && isUnitOf(material, value)
  return (
    <NativeSelect
      aria-label={t('catalog.recipes.unit')}
      aria-invalid={invalid}
      aria-describedby={describedBy}
      value={valid ? value : ''}
      onChange={(event) => onChange(event.target.value as LineUnit)}
      disabled={!material}
    >
      <option value="" disabled>
        {t('catalog.form.unitPlaceholder')}
      </option>
      {material
        ? dimensionsOf(material).map((dimension) => (
            <optgroup key={dimension} label={t(`units.dimensions.${dimension}`)}>
              {UNITS_BY_DIMENSION[dimension].map((unit) => (
                <option key={unit} value={`unit:${unit}`}>
                  {t(`units.names.${unit}`)}
                </option>
              ))}
            </optgroup>
          ))
        : null}
      {material && material.packs.length > 0 ? (
        <optgroup label={t('catalog.recipes.packs')}>
          {material.packs.map((pack) => {
            const holds = quantityInWords(material, '1' as Quantity, { pack: pack.id })
            const last = holds?.at(-1)
            return (
              <option key={pack.id} value={`pack:${pack.id}`}>
                {last?.kind === 'unit'
                  ? `${pack.name} (${unitQuantity(last.qty, last.unit)})`
                  : pack.name}
              </option>
            )
          })}
        </optgroup>
      ) : null}
    </NativeSelect>
  )
}

/**
 * A line's quantity in words, down to the unit its material is counted in: "200 ml = 0.2 L",
 * "0.5 bottle = 0.5 L", [] when it is already in that unit. Null when it cannot be said.
 */
function wordsOf(
  material: MaterialDto | undefined,
  qty: string,
  unit: LineUnit,
): ChainStep[] | null {
  const ref = unitRefOf(unit)
  if (!material || !ref || !isUnitOf(material, unit)) return null
  return quantityInWords(material, qty as Quantity, ref)
}

/** A line's menu: move it up or down (the recipe keeps its order), or take it out. */
function LineMenu({
  index,
  count,
  onMove,
  onRemove,
}: {
  index: number
  count: number
  onMove: (by: -1 | 1) => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-line-menu
          aria-label={t('catalog.recipes.lineActions', { number: index + 1 })}
          className="shrink-0 text-muted-foreground md:col-start-5 md:row-start-1"
        >
          <EllipsisVerticalIcon aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem className="py-2" disabled={index === 0} onSelect={() => onMove(-1)}>
          <ArrowUpIcon aria-hidden />
          {t('catalog.recipes.moveUp')}
        </DropdownMenuItem>
        <DropdownMenuItem
          className="py-2"
          disabled={index === count - 1}
          onSelect={() => onMove(1)}
        >
          <ArrowDownIcon aria-hidden />
          {t('catalog.recipes.moveDown')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="py-2" variant="destructive" onSelect={onRemove}>
          <Trash2Icon aria-hidden />
          {t('catalog.recipes.remove')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A line being edited: the material, how much in which unit, the words, and its cost. */
function LineEditor({
  index,
  count,
  line,
  materials,
  pickable,
  errors,
  shown,
  cost,
  profile,
  per,
  onChange,
  onMove,
  onRemove,
}: {
  index: number
  /** How many lines the recipe has (the last one cannot move down). */
  count: number
  line: RecipeLineDraft
  materials: ReadonlyMap<string, MaterialDto>
  pickable: readonly MaterialDto[]
  errors: RecipeLineErrors | undefined
  shown: (error: FieldError | undefined) => string | undefined
  cost: LineCost
  profile: TerminologyProfile
  /** For one unit of the product: "per piece". */
  per: string
  onChange: (line: RecipeLineDraft) => void
  onMove: (by: -1 | 1) => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const term = useTerminology()
  const messagesId = useId()
  const material = line.materialId ? materials.get(line.materialId) : undefined
  const messages = [shown(errors?.material), shown(errors?.qty), shown(errors?.unit)].filter(
    (m): m is string => Boolean(m),
  )
  const describedBy = messages.length > 0 ? messagesId : undefined
  const steps = errors?.qty ? null : wordsOf(material, withLatinDigits(line.qty), line.unit)
  const words = steps && steps.length > 1 ? <PackChainText steps={steps} /> : null
  const qtyLabel = t('catalog.recipes.qty', { per })

  function pick(id: string) {
    const next = materials.get(id)
    onChange({
      ...line,
      materialId: id,
      unit: next ? (isUnitOf(next, line.unit) ? line.unit : recipeUnitOf(next)) : '',
    })
  }

  return (
    <fieldset
      data-recipe-line
      className="rounded-xl border bg-background/60 p-3 md:grid md:grid-cols-[minmax(0,2.4fr)_minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,1.3fr)_2.75rem] md:items-end md:gap-x-3 md:gap-y-1"
    >
      <legend className="sr-only">{t('catalog.recipes.line', { number: index + 1 })}</legend>
      <div className="flex items-end gap-2 md:contents">
        <div className="min-w-0 flex-1 md:col-start-1 md:row-start-1">
          <Caption>{term('catalog.recipes.material', profile)}</Caption>
          <NativeSelect
            aria-label={term('catalog.recipes.material', profile)}
            aria-invalid={Boolean(shown(errors?.material))}
            aria-describedby={describedBy}
            value={line.materialId}
            onChange={(event) => pick(event.target.value)}
          >
            <option value="" disabled>
              {t('catalog.recipes.pick')}
            </option>
            {pickable.map((option) => (
              <option key={option.id} value={option.id}>
                {option.archivedAt
                  ? `${option.name} (${t('catalog.recipes.archived')})`
                  : option.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <LineMenu index={index} count={count} onMove={onMove} onRemove={onRemove} />
      </div>
      <div className="mt-2 grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2 md:contents">
        <div className="min-w-0 md:col-start-2 md:row-start-1">
          <Caption>{qtyLabel}</Caption>
          <Input
            aria-label={qtyLabel}
            aria-invalid={Boolean(shown(errors?.qty))}
            aria-describedby={describedBy}
            placeholder={t('catalog.recipes.qtyPlaceholder')}
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
        <div className="min-w-0 md:col-start-3 md:row-start-1">
          <Caption>{t('catalog.recipes.unit')}</Caption>
          <UnitBox
            material={material}
            value={line.unit}
            onChange={(unit) => onChange({ ...line, unit })}
            invalid={Boolean(shown(errors?.unit))}
            describedBy={describedBy}
          />
        </div>
      </div>
      <div className="mt-2 flex items-start justify-between gap-3 md:contents">
        <p
          data-qty-words
          className="min-w-0 ps-1 text-sm text-muted-foreground md:col-span-3 md:col-start-1 md:row-start-2"
        >
          {words}
        </p>
        <CostCell
          cost={cost}
          className="shrink-0 md:col-start-4 md:row-span-2 md:row-start-1 md:self-center"
        />
      </div>
      {messages.length > 0 ? (
        <div
          id={messagesId}
          role="alert"
          className="mt-2 space-y-1 text-sm text-destructive md:col-span-5 md:row-start-3"
        >
          {[...new Set(messages)].map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      ) : null}
    </fieldset>
  )
}

/**
 * A saved line, read only: the material, the quantity in the editor's words ("18 g = 0.018 kg") and
 * its cost.
 */
function LineView({
  line,
  material,
  cost,
}: {
  line: RecipeLineDto
  material: MaterialDto | undefined
  cost: LineCost
}) {
  const { t } = useTranslation()
  const format = useFormatQuantity()
  const unitQuantity = useUnitQuantity()
  const steps = wordsOf(material, line.qty, lineUnitOf(line.unit, line.packId))
  const typed = line.unit
    ? unitQuantity(line.qty, line.unit)
    : `${format(line.qty)}${NBSP}${line.packName ?? ''}`
  return (
    <li data-recipe-line className="flex items-start justify-between gap-3 px-3 py-3">
      <div className="min-w-0">
        <p dir="auto" className="font-medium break-words">
          {line.materialName}
          {line.materialArchived ? (
            <span className="ms-1.5 text-xs font-normal text-muted-foreground">
              ({t('catalog.recipes.archived')})
            </span>
          ) : null}
        </p>
        <p data-qty-words className="text-sm text-muted-foreground">
          {steps && steps.length > 0 ? (
            <PackChainText steps={steps} />
          ) : (
            <bdi>{typed.replaceAll(' ', NBSP)}</bdi>
          )}
        </p>
      </div>
      <CostCell cost={cost} className="shrink-0" />
    </li>
  )
}

/** The cost of a saved line, as recipe.get sent it. */
function savedCostOf(line: RecipeLineDto, seesCosts: boolean): LineCost {
  if (!seesCosts) return { kind: 'locked' }
  if (!line.cost) return { kind: 'none' }
  if (line.cost.lineCost === undefined) return { kind: 'locked' }
  return {
    kind: 'priced',
    amount: line.cost.lineCost,
    perUnit: line.cost.perUnit,
    unit: line.materialUnit,
  }
}

/**
 * The recipe of a product or service in a sheet (phones) or a side panel (desktop): editable with
 * products.recipes.manage (and the materials to pick from), read only otherwise. Every member who may
 * see it may see its materials (D-155), whose packs say each line in words.
 */
export function RecipeSheet({
  product,
  profile,
  onClose,
}: {
  product: ProductDto
  profile: TerminologyProfile
  onClose: () => void
}) {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const term = useTerminology()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const money = useMoney()
  const format = useFormatQuantity()
  const unitQuantity = useUnitQuantity()
  const seesCosts = context?.visibleCategories.includes('cost') === true
  const seesMaterials = context !== undefined && can(context, 'materials.items.view')
  const canEdit = context !== undefined && seesMaterials && can(context, 'products.recipes.manage')
  const recipe = useQuery(trpc.recipe.get.queryOptions({ productId: product.id }))
  const { materials, ready, error: materialsError } = useAllMaterials(seesMaterials)
  const save = useMutation(trpc.recipe.save.mutationOptions())
  const [edited, setEdited] = useState<RecipeLineDraft[] | null>(null)
  // What the recipe makes, as typed (null: as saved).
  const [yieldEdited, setYieldEdited] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState<I18nKey | null>(null)
  const yieldId = useId()
  const yieldHintId = useId()
  const saved: RecipeDto | undefined = recipe.data?.data
  const lines = useMemo(() => edited ?? (saved ? recipeDraft(saved) : []), [edited, saved])
  const check = useMemo(() => checkRecipe(lines, materials), [lines, materials])
  const savedYield = saved?.yieldQty ?? '1'
  const yieldText = yieldEdited ?? savedYield
  const yieldRead = readQuantity(yieldText)
  // What the screen divides by: as typed while it reads, else as saved.
  const yieldQty = yieldRead.ok ? yieldRead.value : savedYield
  const yieldChanged =
    yieldEdited !== null && (!yieldRead.ok || compareDecimal(yieldRead.value, savedYield) !== 0)
  const dirty =
    saved !== undefined && ((edited !== null && !isSaved(edited, saved)) || yieldChanged)

  // The averages of the materials on the lines, for the costs shown as the recipe is typed.
  const materialIds = [...new Set(lines.map((l) => l.materialId).filter(Boolean))].sort()
  const averages = useQuery({
    ...trpc.material.costs.queryOptions({ ids: materialIds }),
    enabled: canEdit && seesCosts && materialIds.length > 0,
    placeholderData: keepPreviousData,
  })
  const averageOf = new Map<string, MaterialCostDto>(
    (averages.data?.data.items ?? []).map((item) => [item.materialId, item] as const),
  )

  const shown = (error: FieldError | undefined): string | undefined =>
    error && (submitted || !MISSING.has(error.key)) ? t(error.key, error.values) : undefined

  const setLines = (update: (current: RecipeLineDraft[]) => RecipeLineDraft[]) =>
    setEdited((current) => update(current ?? (saved ? recipeDraft(saved) : [])))

  /** What a line being edited costs: at its material's average, for the screen. */
  function editedCostOf(line: RecipeLineDraft): LineCost {
    if (!seesCosts) return { kind: 'locked' }
    const material = materials.get(line.materialId)
    const base = check.baseQty.get(line.id)
    if (!material || base === undefined) return { kind: 'pending' }
    const average = averageOf.get(material.id)
    if (!average) return { kind: 'pending' }
    if (!average.average) return { kind: 'none' }
    if (average.average.perBaseUnit === undefined) return { kind: 'locked' }
    const amount = lineCostOf(base, average.average.perBaseUnit)
    return amount === null
      ? { kind: 'none' }
      : { kind: 'priced', amount, perUnit: average.average.perUnit, unit: material.unit }
  }

  const costs = lines.map((line) => editedCostOf(line))
  const unpricedNames = canEdit
    ? lines.flatMap((line, i) =>
        costs[i]?.kind === 'none' ? [materials.get(line.materialId)?.name ?? ''] : [],
      )
    : (saved?.lines ?? []).filter((line) => !line.cost).map((line) => line.materialName)
  let total: ReactNode
  // One unit sold, for a recipe that makes more than one (D-178): the total ÷ what it makes.
  let perUnit: ReactNode
  if (!seesCosts) {
    total = <Locked category="cost" />
    perUnit = <Locked category="cost" />
  } else {
    const priced = costs.flatMap((cost) => (cost.kind === 'priced' ? [cost.amount] : []))
    const amount =
      !dirty || !canEdit ? saved?.cost.total : priced.length > 0 ? sumDecimals(priced) : null
    const show = (
      value: string | null | undefined,
      data: Record<string, string>,
      tooLarge = false,
    ) =>
      value === undefined ? (
        <Locked category="cost" />
      ) : value === null ? (
        <span className="text-muted-foreground">
          {tooLarge ? t('catalog.recipes.tooLarge') : t('catalog.recipes.noTotal')}
        </span>
      ) : (
        <bdi {...data} className="tabular-nums">
          {money(value).replaceAll(' ', NBSP)}
        </bdi>
      )
    total = show(amount, { 'data-recipe-total': '' })
    // As saved, or as typed (a cost per unit too large to work out says so, as the API does).
    const typed =
      !dirty || !canEdit || amount === null || amount === undefined
        ? null
        : unitCostOf(costPerUnit(amount, yieldQty))
    perUnit = typed
      ? show(typed.perUnit, { 'data-recipe-per-unit': '' }, typed.tooLarge)
      : show(
          !dirty || !canEdit ? saved?.cost.perUnit : amount,
          { 'data-recipe-per-unit': '' },
          !dirty || !canEdit ? saved?.cost.tooLarge : false,
        )
  }
  const makesMore = compareDecimal(yieldQty, '1') !== 0

  /** Saves the recipe; true once saved (the sheet says what went wrong otherwise). */
  async function saveRecipe(): Promise<boolean> {
    if (!saved || save.isPending) return false
    setSubmitted(true)
    setServerError(null)
    if (!check.lines || !yieldRead.ok) return false
    try {
      const result = await save.mutateAsync({
        productId: product.id,
        version: saved.version,
        yieldQty: yieldRead.value,
        lines: check.lines,
      })
      queryClient.setQueryData(trpc.recipe.get.queryKey({ productId: product.id }), result)
      setYieldEdited(null)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: trpc.product.costs.pathKey() }),
        queryClient.invalidateQueries({ queryKey: trpc.productCost.pathKey() }),
      ])
      toast.success(t('catalog.recipes.saved'))
      return true
    } catch (error) {
      const code = apiErrorCode(error)
      setServerError(code === 'conflict' ? 'catalog.form.conflict' : apiErrorKey(error))
      return false
    }
  }

  // Changes not saved are asked about before the sheet closes or the page is left (D-156; the
  // owner's request of 2026-09-29: Save, Don't save, Keep editing).
  const guard = useUnsavedChanges({ dirty: canEdit && dirty, save: saveRecipe, close: onClose })

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!saved || save.isPending) return
    // Nothing changed: nothing to save (no new version, no audit row).
    if (!dirty) {
      onClose()
      return
    }
    if (await saveRecipe()) onClose()
  }

  const pickableFor = (line: RecipeLineDraft) =>
    [...materials.values()]
      .filter(
        (m) =>
          m.id === line.materialId ||
          (m.archivedAt === null && !lines.some((other) => other.materialId === m.id)),
      )
      .sort((a, b) => a.name.localeCompare(b.name, locale))
  const noMaterials =
    canEdit && ready && [...materials.values()].every((m) => m.archivedAt !== null)
  const busy = save.isPending
  const title = term('catalog.recipes.title', profile)
  // One unit sold: "per piece". The lines are for what the recipe makes: "for 12 pieces" (D-178).
  const perOne = t(`units.per.${product.unit}`)
  const per = makesMore
    ? t(`units.forQty.${product.unit}`, { count: Number(yieldQty), value: format(yieldQty) })
    : perOne
  const yieldError = submitted || yieldText.trim() !== '' ? shownYieldError() : undefined
  /** What is wrong with what the recipe makes, as typed. */
  function shownYieldError(): string | undefined {
    return yieldRead.ok ? undefined : t(yieldRead.error.key, yieldRead.error.values)
  }
  /** The unit after the box, as many as typed: "pieces", «قطعة». */
  const yieldUnit = unitQuantity(yieldQty, product.unit).replace(format(yieldQty), '').trim()
  // A tap beside the sheet, Escape, × or Cancel: changes not saved are only dropped once confirmed.
  const requestClose = () => {
    if (busy) return
    guard.requestLeave(onClose)
  }

  return (
    <Sheet open onOpenChange={(open) => !open && requestClose()}>
      <SheetContent closeLabel={t('actions.close')} className="md:max-w-3xl">
        <form
          method="post"
          noValidate
          onSubmit={(event) => void submit(event)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <SheetHeader>
            <p className="text-sm font-medium text-primary">{title}</p>
            {/* In the page's direction, under its caption: an Arabic name in English stays at the start. */}
            <SheetTitle>
              <bdi>{product.name}</bdi>
            </SheetTitle>
            {/* Visible on phones too: what the lines are for (one unit sold, or what it makes). */}
            <SheetDescription className="max-sm:not-sr-only">
              {seesCosts
                ? t('catalog.recipes.description', { per })
                : t('catalog.recipes.descriptionNoCosts', { per })}
            </SheetDescription>
          </SheetHeader>
          <SheetBody className="space-y-4">
            {serverError ? <FormAlert tone="error">{t(serverError)}</FormAlert> : null}
            {submitted && !check.lines && !serverError ? (
              <FormAlert tone="error">{t('catalog.form.fixErrors')}</FormAlert>
            ) : null}
            {!seesCosts ? (
              <FormAlert tone="info">{t('catalog.recipes.lockedCosts')}</FormAlert>
            ) : null}
            {recipe.isPending || (!ready && !materialsError) ? (
              <div className="space-y-3">
                <Skeleton className="h-24 w-full rounded-xl" />
                <Skeleton className="h-24 w-full rounded-xl" />
              </div>
            ) : recipe.isError ? (
              <FormAlert tone="error">{t(apiErrorKey(recipe.error))}</FormAlert>
            ) : canEdit && materialsError ? (
              <FormAlert tone="error">{t(apiErrorKey(materialsError))}</FormAlert>
            ) : canEdit ? (
              <>
                {/* What the recipe makes (D-178): the lines are for that many of what is sold. */}
                <div data-recipe-yield className="rounded-xl border bg-background/60 p-3">
                  <label htmlFor={yieldId} className="block text-sm font-medium">
                    {term('catalog.recipes.yield', profile)}
                  </label>
                  <div className="mt-1.5 flex items-center gap-2">
                    <Input
                      id={yieldId}
                      aria-invalid={Boolean(yieldError)}
                      aria-describedby={yieldHintId}
                      inputMode="decimal"
                      dir="ltr"
                      autoComplete="off"
                      spellCheck={false}
                      value={yieldText}
                      onChange={(event) => setYieldEdited(event.target.value)}
                      onBlur={() => setYieldEdited(withLatinDigits(yieldText))}
                      className="w-28 tabular-nums rtl:text-end"
                    />
                    <span className="min-w-0 text-sm text-muted-foreground">{yieldUnit}</span>
                  </div>
                  <p id={yieldHintId} className="mt-1.5 text-xs text-muted-foreground">
                    {yieldError ? (
                      <span role="alert" className="block text-sm text-destructive">
                        {yieldError}
                      </span>
                    ) : null}
                    {term('catalog.recipes.yieldHint', profile, { per: perOne })}
                  </p>
                </div>
                {noMaterials ? (
                  <FormAlert tone="info">
                    {term('catalog.recipes.noMaterials', profile)}{' '}
                    <Link
                      href={`/b/${businessId}/materials`}
                      className="font-medium text-primary underline-offset-4 hover:underline"
                    >
                      {t('states.goTo', { section: term('common.nav.materials', profile) })}
                    </Link>
                  </FormAlert>
                ) : lines.length === 0 ? (
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {term('catalog.recipes.empty', profile, { per })}
                  </p>
                ) : null}
                <div className="space-y-3">
                  {lines.map((line, index) => (
                    <LineEditor
                      key={line.id}
                      index={index}
                      count={lines.length}
                      line={line}
                      materials={materials}
                      pickable={pickableFor(line)}
                      errors={check.errors[line.id]}
                      shown={shown}
                      cost={costs[index] ?? { kind: 'pending' }}
                      profile={profile}
                      per={per}
                      onChange={(next) =>
                        setLines((current) => current.map((l) => (l.id === next.id ? next : l)))
                      }
                      onMove={(by) => setLines((current) => moveLine(current, line.id, by))}
                      onRemove={() =>
                        setLines((current) => current.filter((l) => l.id !== line.id))
                      }
                    />
                  ))}
                </div>
                {lines.length < RECIPE_LINES_MAX ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={noMaterials}
                    onClick={() =>
                      setLines((current) => [
                        ...current,
                        { id: newId(), materialId: '', qty: '', unit: '' },
                      ])
                    }
                  >
                    <PlusIcon aria-hidden />
                    {term('catalog.recipes.add', profile)}
                  </Button>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t('catalog.recipes.tooMany', { count: RECIPE_LINES_MAX })}
                  </p>
                )}
              </>
            ) : saved && saved.lines.length > 0 ? (
              <>
                {makesMore ? (
                  <p data-recipe-makes className="text-sm font-medium">
                    {term('catalog.recipes.makes', profile, {
                      qty: unitQuantity(yieldQty, product.unit),
                    })}
                  </p>
                ) : null}
                <ul className="divide-y rounded-xl border">
                  {saved.lines.map((line) => (
                    <LineView
                      key={line.id}
                      line={line}
                      material={materials.get(line.materialId)}
                      cost={savedCostOf(line, seesCosts)}
                    />
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{t('catalog.recipes.viewerEmpty')}</p>
            )}
            {seesCosts && lines.length > 0 ? (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t('catalog.recipes.basis')}
              </p>
            ) : null}
          </SheetBody>
          {/* The total, once something goes into it (an empty recipe has no cost to say). */}
          {lines.length > 0 ? (
            <div
              data-recipe-footer
              className="shrink-0 space-y-1 border-t bg-popover px-5 pt-3 sm:px-6"
            >
              {makesMore ? (
                <>
                  {/* The whole recipe names what it makes; one unit sold leads, as the Products
                      list shows it ("Recipe cost: AED 1.45 per piece"). */}
                  <p className="flex items-baseline justify-between gap-3 text-sm font-medium">
                    <span>
                      {term('catalog.recipes.totalWhole', profile, {
                        qty: unitQuantity(yieldQty, product.unit),
                      })}
                    </span>
                    {total}
                  </p>
                  <p className="flex items-baseline justify-between gap-3 text-base font-semibold">
                    <span>{term('catalog.recipes.perUnitCost', profile, { per: perOne })}</span>
                    {perUnit}
                  </p>
                </>
              ) : (
                <p className="flex items-baseline justify-between gap-3 text-base font-semibold">
                  <span>{term('catalog.recipes.total', profile)}</span>
                  {total}
                </p>
              )}
              {seesCosts && unpricedNames.length > 0 ? (
                <p data-incomplete className="text-sm text-warning">
                  {t('catalog.recipes.incomplete', {
                    count: unpricedNames.length,
                    names: listOfNames(locale, unpricedNames),
                  })}
                  <span className="block text-xs text-muted-foreground">
                    {t('catalog.recipes.noPriceHint')}
                  </span>
                </p>
              ) : null}
            </div>
          ) : null}
          <SheetFooter className={cn(lines.length > 0 && 'border-t-0', !canEdit && 'grid-cols-1')}>
            <Button type="button" variant="outline" disabled={busy} onClick={requestClose}>
              {canEdit ? t('actions.cancel') : t('actions.close')}
            </Button>
            {canEdit ? (
              <Button type="submit" disabled={busy || !saved}>
                {busy ? t('status.saving') : t('catalog.form.save')}
              </Button>
            ) : null}
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
