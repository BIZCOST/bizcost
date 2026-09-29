'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { ProductDto } from '@bizcost/contracts'
import {
  compareDecimal,
  DIMENSIONS,
  dimensionOf,
  newId,
  PRODUCT_TYPES,
  VAT_CATEGORIES,
  type ProductType,
  type StandardUnit,
  type TerminologyProfile,
  type VatCategory,
} from '@bizcost/domain'
import { currencySymbol, type I18nKey } from '@bizcost/i18n'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BriefcaseIcon, TagIcon } from 'lucide-react'
import { useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { TextField } from '@/components/form/text-field'
import { sameData } from '@/components/form/unsaved'
import { useUnsavedChanges } from '@/components/form/unsaved-changes'
import { isolate } from '@/components/form/use-message'
import { Button } from '@/components/ui/button'
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
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { hasModule } from '@/features/purchasing/data'
import { can } from '@/features/settings/sections'
import { useLocale, useTerminology } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import { draftUnits, formName, type MaterialDraft } from './material-draft'
import { withLatinDigits, type FieldError } from './numbers'
import {
  checkProduct,
  checkResaleUnits,
  productDraft,
  readOwnerMinutes,
  type ProductDraft,
} from './product-draft'
import { UnitSelect } from './unit-parts'
import { PacksAndConversions, useShownError } from './units-editor'

// Add or edit a product or service (M2 Step 2; D-121, D-123): what it is, the unit it is sold by,
// its usual price in the business currency, and, only where the business uses them, its VAT (VAT
// registered) and the branches where it is sold (more than one branch).
//
// Bought ready to sell (M2 Step 4, D-117): a new product can be one, with the packs it is bought in,
// and its material is made with it (one record from the owner's view, one name). On by default in the
// retail wording, and always when the Goods page opens the form. Once made, it stays a product (the
// type is not offered), sold in the kind of measure of its packs, and its name and unit change in
// Materials too.
//
// The owner's time (M2 Step 6, D-119): a business without a team counts the owner's minutes for one
// unit at the owner's hourly rate. The field shows only there, with the Cost Engine on, to a member
// who sees costs (the minutes are `cost`), and it is sent only once changed: minutes the form never
// read are never cleared.

const TYPE_ICONS = { product: TagIcon, service: BriefcaseIcon } as const

/** Problems that only say something is missing: shown once the person tries to save. */
const MISSING: ReadonlySet<I18nKey> = new Set<I18nKey>([
  'catalog.form.nameRequired',
  'catalog.products.locations.pickOne',
])

function TypePicker({
  value,
  onChange,
}: {
  value: ProductType
  onChange: (type: ProductType) => void
}) {
  const { t } = useTranslation()
  return (
    <fieldset className="space-y-2">
      <legend className="mb-2 text-sm font-medium">{t('catalog.products.type.label')}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {PRODUCT_TYPES.map((type) => {
          const Icon = TYPE_ICONS[type]
          return (
            <label
              key={type}
              className={cn(
                'relative flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors has-focus-visible:ring-3 has-focus-visible:ring-ring',
                value === type ? 'border-primary/40 bg-primary/5' : 'hover:bg-muted/50',
              )}
            >
              <input
                type="radio"
                name="product-type"
                value={type}
                checked={value === type}
                onChange={() => onChange(type)}
                className="sr-only"
              />
              <span
                className={cn(
                  'flex size-9 shrink-0 items-center justify-center rounded-lg',
                  value === type ? 'bg-primary text-primary-foreground' : 'bg-muted',
                )}
              >
                <Icon aria-hidden className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">
                  {t(`catalog.products.type.${type}`)}
                </span>
                <span className="block text-sm text-muted-foreground">
                  {t(`catalog.products.type.${type}Hint`)}
                </span>
              </span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

/** Where it is sold: every branch, or only the ones ticked. */
function WhereSold({
  draft,
  canPick,
  onChange,
  error,
}: {
  draft: ProductDraft
  canPick: boolean
  onChange: (next: Pick<ProductDraft, 'where' | 'locationIds'>) => void
  error: string | undefined
}) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const errorId = useId()
  const locations = useQuery({ ...trpc.location.list.queryOptions(), enabled: canPick })
  if (!canPick) {
    return (
      <section className="space-y-1">
        <h3 className="text-sm font-semibold">{t('catalog.products.locations.title')}</h3>
        <p className="text-sm text-muted-foreground">
          {draft.locationIds.length > 0
            ? t('catalog.products.locations.readOnlySome', { count: draft.locationIds.length })
            : t('catalog.products.locations.readOnlyAll')}{' '}
          {t('catalog.products.locations.readOnlyNote')}
        </p>
      </section>
    )
  }
  return (
    <fieldset className="space-y-2" aria-describedby={error ? errorId : undefined}>
      <legend className="mb-2 text-sm font-semibold">
        {t('catalog.products.locations.title')}
      </legend>
      {(['all', 'some'] as const).map((where) => (
        <label key={where} className="flex min-h-11 cursor-pointer items-start gap-3 py-1">
          <input
            type="radio"
            name="product-where"
            value={where}
            checked={draft.where === where}
            onChange={() => onChange({ where, locationIds: draft.locationIds })}
            className="mt-0.5 size-5 shrink-0 accent-primary"
          />
          <span className="min-w-0 text-sm">
            <span className="block font-medium">{t(`catalog.products.locations.${where}`)}</span>
            {where === 'all' ? (
              <span className="block text-muted-foreground">
                {t('catalog.products.locations.allHint')}
              </span>
            ) : null}
          </span>
        </label>
      ))}
      {draft.where === 'some' ? (
        <div className="ms-8 space-y-1 rounded-xl border bg-background/60 p-2">
          {(locations.data ?? []).map((location) => {
            const checked = draft.locationIds.includes(location.id)
            return (
              <label
                key={location.id}
                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2 hover:bg-muted/50"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() =>
                    onChange({
                      where: 'some',
                      locationIds: checked
                        ? draft.locationIds.filter((id) => id !== location.id)
                        : [...draft.locationIds, location.id],
                    })
                  }
                  className="size-5 shrink-0 accent-primary"
                />
                <span dir="auto" className="min-w-0 text-sm">
                  {location.name}
                </span>
              </label>
            )
          })}
        </div>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </fieldset>
  )
}

/**
 * The product form in a sheet (phones) or a side panel (desktop). `product` absent: a new one.
 * Closes itself after a save; the list refreshes.
 */
export function ProductSheet({
  product,
  profile,
  resale: resaleMode = 'offered',
  onClose,
}: {
  product?: ProductDto
  profile: TerminologyProfile
  /**
   * A new product bought ready to sell: `offered` as a switch (on by default in the retail
   * wording), `only` (the Goods page: nothing else), or `none` (a business without Materials, or
   * a member who may not add them).
   */
  resale?: 'offered' | 'only' | 'none'
  onClose: () => void
}) {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const term = useTerminology()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data: context } = useBusinessContext()
  const create = useMutation(trpc.product.create.mutationOptions())
  const update = useMutation(trpc.product.update.mutationOptions())
  const [newProductId] = useState(() => newId())
  const [initialDraft] = useState<ProductDraft>(() => productDraft(product))
  const [draft, setDraft] = useState<ProductDraft>(initialDraft)
  const [newMaterialId] = useState(() => newId())
  // A new product bought ready to sell, and the packs it is bought in (its material's).
  const [initialResale] = useState(
    () => !product && (resaleMode === 'only' || (resaleMode === 'offered' && profile === 'retail')),
  )
  const [resale, setResale] = useState(initialResale)
  const [units, setUnits] = useState<Pick<MaterialDraft, 'packs' | 'crossFactors'>>({
    packs: [],
    crossFactors: [],
  })
  const [lastChanged, setLastChanged] = useState<string | undefined>(undefined)
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState<I18nKey | null>(null)
  const [takenName, setTakenName] = useState<string | null>(null)
  const form = useRef<HTMLFormElement>(null)
  const vatId = useId()
  const busy = create.isPending || update.isPending

  // The owner's time: without a team, with the Cost Engine on, for a member who sees costs (and
  // product costs, where the minutes count). An existing product's minutes are read first.
  const ownerTime =
    context !== undefined &&
    context.capabilities.has_team !== true &&
    hasModule(context, 'cost_engine') &&
    context.visibleCategories.includes('cost') &&
    can(context, 'cost_engine.product_costs.view')
  const storedCost = useQuery({
    ...trpc.productCost.get.queryOptions({ productId: product?.id ?? '' }),
    enabled: ownerTime && product !== undefined,
  })
  const storedMinutes = product ? storedCost.data?.data.cost.ownerTime.minutes : null
  // Shown once what is stored is known (a new product has none).
  const showMinutes = ownerTime && (product === undefined || typeof storedMinutes !== 'undefined')
  const [minutesTyped, setMinutesTyped] = useState<string | null>(null)
  const minutesValue = minutesTyped ?? storedMinutes ?? ''
  const minutesRead = readOwnerMinutes(minutesValue)
  const minutesChanged =
    showMinutes &&
    minutesTyped !== null &&
    minutesRead.ok &&
    !(minutesRead.value === null
      ? (storedMinutes ?? null) === null
      : typeof storedMinutes === 'string' && compareDecimal(minutesRead.value, storedMinutes) === 0)

  const vatRegistered = context?.capabilities.vat_registered === true
  const access = {
    multiLocation: context?.capabilities.multi_location === true,
    canPickLocations: context ? can(context, 'settings.locations.manage') : false,
  }
  const check = checkProduct(draft, access, product?.locationIds)
  const shown = (error: FieldError | undefined): string | undefined =>
    error && (submitted || !MISSING.has(error.key)) ? t(error.key, error.values) : undefined
  // Bought ready to sell: new (with its packs), or made so (it stays a product in its kind of measure).
  const isResale = product ? product.resaleMaterialId !== null : resale && draft.type === 'product'
  const materialDraft: MaterialDraft = useMemo(
    () => ({ name: draft.name, unit: draft.unit, ...units }),
    [draft.name, draft.unit, units],
  )
  const unitsCheck = useMemo(
    () => checkResaleUnits(draft, units, { lastChanged }),
    [draft, units, lastChanged],
  )
  const unitsShown = useShownError(submitted)
  const unitDimensions = product?.resaleMaterialId ? [dimensionOf(product.unit)] : DIMENSIONS
  const typedName = formName(draft.name).toLowerCase()
  const nameError =
    shown(check.errors.name) ??
    (takenName !== null && typedName === takenName ? t('errors.name_taken') : undefined)
  const focusFirstError = () =>
    setTimeout(() => form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())

  /** Saves the product; true once saved (the form says what went wrong otherwise). */
  async function save(): Promise<boolean> {
    if (busy) return false
    setSubmitted(true)
    setServerError(null)
    const { fields } = check
    const resaleUnits = !product && isResale ? unitsCheck.fields : null
    if (
      !fields ||
      (takenName !== null && fields.name.toLowerCase() === takenName) ||
      (!product && isResale && !resaleUnits) ||
      (showMinutes && !minutesRead.ok)
    ) {
      focusFirstError()
      return false
    }
    // The owner's minutes only once changed (left out, the API keeps them).
    const minutes = minutesChanged && minutesRead.ok ? { ownerMinutes: minutesRead.value } : {}
    try {
      const saved = product
        ? await update.mutateAsync({
            id: product.id,
            version: product.version,
            ...fields,
            ...minutes,
          })
        : await create.mutateAsync({
            id: newProductId,
            ...fields,
            ...minutes,
            resale: resaleUnits
              ? {
                  materialId: newMaterialId,
                  packs: resaleUnits.packs,
                  crossFactors: resaleUnits.crossFactors,
                }
              : null,
          })
      toast.success(
        product ? t('catalog.list.saved') : t('catalog.list.added', { name: isolate(saved.name) }),
      )
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: trpc.product.list.pathKey() }),
        queryClient.invalidateQueries({ queryKey: trpc.product.costs.pathKey() }),
        // Its cost moves with its price, VAT and minutes (Product costs).
        queryClient.invalidateQueries({ queryKey: trpc.productCost.pathKey() }),
        ...(saved.resaleMaterialId
          ? [queryClient.invalidateQueries({ queryKey: trpc.material.list.pathKey() })]
          : []),
      ])
      return true
    } catch (error) {
      const code = apiErrorCode(error)
      if (code === 'name_taken') {
        setTakenName(fields.name.toLowerCase())
        focusFirstError()
      } else setServerError(code === 'conflict' ? 'catalog.form.conflict' : apiErrorKey(error))
      return false
    }
  }

  // Leaving with changes not saved asks first (the owner's request of 2026-09-29).
  const dirty =
    !sameData(draft, initialDraft) ||
    resale !== initialResale ||
    units.packs.length > 0 ||
    units.crossFactors.length > 0 ||
    minutesChanged ||
    (showMinutes && !minutesRead.ok)
  const guard = useUnsavedChanges({ dirty, save, close: onClose })

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (await save()) onClose()
  }

  const hasShownErrors =
    submitted &&
    (check.fields === null ||
      (takenName !== null && typedName === takenName) ||
      (!product && isResale && unitsCheck.fields === null) ||
      (showMinutes && !minutesRead.ok))

  return (
    <Sheet open onOpenChange={(open) => !open && !busy && guard.requestLeave(onClose)}>
      <SheetContent closeLabel={t('actions.close')}>
        <form
          ref={form}
          method="post"
          noValidate
          onSubmit={(event) => void submit(event)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <SheetHeader>
            <SheetTitle dir={product ? 'auto' : undefined}>
              {product
                ? product.name
                : resaleMode === 'only'
                  ? term('catalog.materials.newTitle', profile)
                  : term('catalog.products.newTitle', profile)}
            </SheetTitle>
            <SheetDescription>
              {product ? t('catalog.form.editDescription') : t('catalog.products.newDescription')}
            </SheetDescription>
          </SheetHeader>
          <SheetBody className="space-y-6">
            {serverError ? <FormAlert tone="error">{t(serverError)}</FormAlert> : null}
            {hasShownErrors && !serverError ? (
              <FormAlert tone="error">{t('catalog.form.fixErrors')}</FormAlert>
            ) : null}
            {product?.resaleMaterialId ? (
              <FormAlert tone="info">
                {t('catalog.products.resale.readOnly')}{' '}
                {term('catalog.products.resale.sameIn', profile)}
              </FormAlert>
            ) : resaleMode === 'only' ? null : (
              <TypePicker
                value={draft.type}
                onChange={(type) => setDraft((d) => ({ ...d, type }))}
              />
            )}
            {!product && resaleMode === 'offered' && draft.type === 'product' ? (
              <div className="flex items-start justify-between gap-4 rounded-xl border bg-background/60 p-4">
                <div className="min-w-0">
                  <p id={`${vatId}-resale`} className="text-sm font-medium">
                    {t('catalog.products.resale.label')}
                  </p>
                  <p id={`${vatId}-resale-hint`} className="mt-0.5 text-sm text-muted-foreground">
                    {term('catalog.products.resale.hint', profile)}
                  </p>
                </div>
                <Switch
                  checked={resale}
                  onCheckedChange={setResale}
                  aria-labelledby={`${vatId}-resale`}
                  aria-describedby={`${vatId}-resale-hint`}
                  className="mt-1"
                />
              </div>
            ) : null}
            <TextField
              label={t('catalog.form.name')}
              autoComplete="off"
              className="[unicode-bidi:plaintext]"
              value={draft.name}
              onChange={(event) => setDraft((d) => ({ ...d, name: event.target.value }))}
              error={nameError}
              hint={(id) => (
                <p id={id} className="text-sm text-muted-foreground">
                  {t('catalog.form.nameHint')}
                </p>
              )}
            />
            <TextField
              label={t('catalog.products.unit')}
              hint={(id) => (
                <p id={id} className="text-sm text-muted-foreground">
                  {product?.resaleMaterialId
                    ? t('catalog.products.resale.unitHint')
                    : t('catalog.products.unitHint')}
                </p>
              )}
              render={(a11y) => (
                <UnitSelect
                  {...a11y}
                  value={draft.unit}
                  onValueChange={(value) =>
                    setDraft((d) => ({ ...d, unit: value as StandardUnit }))
                  }
                  dimensions={unitDimensions}
                />
              )}
            />
            {!product && isResale ? (
              <PacksAndConversions
                draft={materialDraft}
                onChange={(update) =>
                  setUnits((current) => {
                    const next = update({ name: draft.name, unit: draft.unit, ...current })
                    return { packs: next.packs, crossFactors: next.crossFactors }
                  })
                }
                check={unitsCheck}
                units={draftUnits(materialDraft)}
                shown={unitsShown}
                onPackOfChanged={setLastChanged}
              />
            ) : null}
            <TextField
              label={t('catalog.products.price')}
              error={shown(check.errors.price)}
              hint={(id) => (
                <p id={id} className="text-sm text-muted-foreground">
                  {t('catalog.products.priceHint')}
                </p>
              )}
              render={(a11y) => (
                <div className="flex">
                  <span
                    aria-hidden
                    className="flex h-11 shrink-0 items-center rounded-s-lg border border-e-0 border-input bg-muted px-3 text-sm font-medium text-muted-foreground"
                  >
                    {context ? currencySymbol(locale, context.currency) : null}
                  </span>
                  <Input
                    {...a11y}
                    inputMode="decimal"
                    dir="ltr"
                    autoComplete="off"
                    spellCheck={false}
                    value={draft.price}
                    onChange={(event) => setDraft((d) => ({ ...d, price: event.target.value }))}
                    onBlur={() => setDraft((d) => ({ ...d, price: withLatinDigits(d.price) }))}
                    className="rounded-s-none tabular-nums rtl:text-end"
                  />
                </div>
              )}
            />
            {vatRegistered ? (
              <section aria-labelledby={`${vatId}-title`} className="space-y-3">
                <h3 id={`${vatId}-title`} className="text-sm font-semibold">
                  {t('catalog.products.vat.title')}
                </h3>
                <TextField
                  label={t('catalog.products.vat.category')}
                  render={(a11y) => (
                    <NativeSelect
                      {...a11y}
                      value={draft.vatCategory}
                      onChange={(event) =>
                        setDraft((d) => ({ ...d, vatCategory: event.target.value as VatCategory }))
                      }
                    >
                      {VAT_CATEGORIES.map((category) => (
                        <option key={category} value={category}>
                          {t(`catalog.products.vat.${category}`)}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                />
                <div className="flex items-start justify-between gap-4 rounded-xl border bg-background/60 p-4">
                  <div className="min-w-0">
                    <p id={`${vatId}-includes`} className="text-sm font-medium">
                      {t('catalog.products.vat.includes')}
                    </p>
                    <p
                      id={`${vatId}-includes-hint`}
                      className="mt-0.5 text-sm text-muted-foreground"
                    >
                      {t('catalog.products.vat.includesHint')}
                    </p>
                  </div>
                  <Switch
                    checked={draft.priceIncludesVat}
                    onCheckedChange={(checked) =>
                      setDraft((d) => ({ ...d, priceIncludesVat: checked }))
                    }
                    aria-labelledby={`${vatId}-includes`}
                    aria-describedby={`${vatId}-includes-hint`}
                    className="mt-1"
                  />
                </div>
              </section>
            ) : null}
            {showMinutes ? (
              <TextField
                label={t('catalog.products.ownerTime.label', {
                  per: t(`units.per.${draft.unit}`),
                })}
                error={
                  !minutesRead.ok ? t(minutesRead.error.key, minutesRead.error.values) : undefined
                }
                hint={(id) => (
                  <p id={id} className="text-sm text-muted-foreground">
                    {t('catalog.products.ownerTime.hint')}
                  </p>
                )}
                render={(a11y) => (
                  <div data-owner-minutes className="flex">
                    <Input
                      {...a11y}
                      inputMode="decimal"
                      dir="ltr"
                      autoComplete="off"
                      spellCheck={false}
                      value={minutesValue}
                      onChange={(event) => setMinutesTyped(event.target.value)}
                      onBlur={() => setMinutesTyped((typed) => typed && withLatinDigits(typed))}
                      className="max-w-40 rounded-e-none tabular-nums rtl:text-end"
                    />
                    <span
                      aria-hidden
                      className="flex h-11 shrink-0 items-center rounded-e-lg border border-s-0 border-input bg-muted px-3 text-sm font-medium text-muted-foreground"
                    >
                      {t('catalog.products.ownerTime.minutes')}
                    </span>
                  </div>
                )}
              />
            ) : null}
            {access.multiLocation ? (
              <WhereSold
                draft={draft}
                canPick={access.canPickLocations}
                error={shown(check.errors.locations)}
                onChange={(next) => setDraft((d) => ({ ...d, ...next }))}
              />
            ) : null}
            <TextField
              label={t('catalog.products.description')}
              error={shown(check.errors.description)}
              hint={(id) => (
                <p id={id} className="text-sm text-muted-foreground">
                  {t('catalog.products.descriptionHint')}
                </p>
              )}
              render={(a11y) => (
                <Textarea
                  {...a11y}
                  dir="auto"
                  rows={3}
                  value={draft.description}
                  onChange={(event) => setDraft((d) => ({ ...d, description: event.target.value }))}
                />
              )}
            />
          </SheetBody>
          <SheetFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => guard.requestLeave(onClose)}
            >
              {t('actions.cancel')}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? t('status.saving') : product ? t('catalog.form.save') : t('catalog.form.add')}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
