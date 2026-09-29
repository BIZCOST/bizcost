'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { MaterialDto, PurchaseDto, PurchaseResultDto, SupplierDto } from '@bizcost/contracts'
import {
  defaultPricesIncludeVat,
  isOwedPaymentMethod,
  newId,
  PAYMENT_METHODS,
  PURCHASE_DOCUMENT_TYPES,
  type CurrencyCode,
  type PaymentMethod,
  type PurchaseDocumentType,
} from '@bizcost/domain'
import { formatList, type I18nKey } from '@bizcost/i18n'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeftIcon, CheckCheckIcon, Trash2Icon } from 'lucide-react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { Required } from '@/components/form/required'
import { TextField } from '@/components/form/text-field'
import { sameData } from '@/components/form/unsaved'
import { useBeforeNavigate, useUnsavedChanges } from '@/components/form/unsaved-changes'
import { isolate } from '@/components/form/use-message'
import { PageContainer } from '@/components/shell/page-container'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/native-select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import type { FieldError } from '@/features/catalog/numbers'
import { can } from '@/features/settings/sections'
import { useLocale, useTerminology } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { useBusinessDate, useMoney } from './amounts'
import { closedFor, firstOpenDay } from './books'
import { ConfirmDialog } from './confirm-dialog'
import { hasModule, useAllMaterials, useLocationOptions, useSupplierOptions } from './data'
import { defaultUnitOf, isUnitOf } from './line-units'
import {
  AddLineButtons,
  DeliveryLineRow,
  DiscountRow,
  MaterialLineRow,
  VatModeChoice,
} from './purchase-lines'
import {
  checkPurchase,
  defaultVatRate,
  materialNames,
  MISSING_KEYS,
  newDeliveryLine,
  newMaterialLine,
  purchaseDraft,
  type LineDraft,
  type PurchaseDraft,
  type PurchaseFields,
} from './purchase-draft'
import { Panel } from './panel'
import { QuickMaterialSheet } from './quick-material-sheet'
import { PendingReceipts, ReceiptError, Receipts, useUploadReceipt } from './receipts'
import { StatusBadge } from './status-badge'
import { SupplierSheet } from './supplier-sheet'
import { Totals } from './totals'

// Enter a purchase (M2 Step 3; D-114, D-134): a new one or a saved draft. Fast on a phone: the
// supplier, the day and what was bought, each line in the unit or pack it was bought in, said in
// words, with its price per that unit; the totals follow as it is typed (the domain's purchase maths,
// as the API stores them). "Save draft" keeps it without touching any cost; "Finalize" (with
// purchases.documents.post) saves it and posts it, after a confirmation that says which averages
// change. VAT only for a VAT-registered business, the branch only with branches.
// The owner's requests of 2026-09-29: a VAT-registered business says whether the prices it types
// are before VAT or include it (before VAT on a tax invoice until the person chooses, with VAT
// otherwise); how it was paid is required (bought on credit needs the supplier, paid by a member
// names who); a material not in the list is added from its line; leaving with changes not saved asks
// first.

const NEW_SUPPLIER = '__new-supplier__'

export function PurchaseEditor({
  purchase,
  today,
  closedThrough,
}: {
  /** Absent: a new purchase. */
  purchase?: PurchaseDto
  /** Today in the business's time zone (books.get). */
  today: string
  /** The books-closed date (books.get): said next to the date before Finalize (D-143). */
  closedThrough: string | null
}) {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const term = useTerminology()
  const money = useMoney()
  const businessDate = useBusinessDate()
  const trpc = useTRPC()
  const router = useRouter()
  const queryClient = useQueryClient()
  const beforeNavigate = useBeforeNavigate()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const vatRegistered = context?.capabilities.vat_registered === true
  const canPost = context ? can(context, 'purchases.documents.post') : false
  // Seeing the materials is enough to add one from a line (material.quickCreate: any member who
  // enters purchases).
  const canSeeMaterials =
    context !== undefined && hasModule(context, 'materials') && can(context, 'materials.items.view')
  const canAddSupplier =
    context !== undefined &&
    hasModule(context, 'suppliers') &&
    can(context, 'suppliers.items.manage')
  const { materials: loaded, ready: materialsReady } = useAllMaterials(canSeeMaterials)
  const supplierOptions = useSupplierOptions(context)
  const locationOptions = useLocationOptions(context)
  const payers = useQuery({ ...trpc.purchase.payers.queryOptions(), staleTime: 60_000 })
  const upload = useUploadReceipt()
  const create = useMutation(trpc.purchase.create.mutationOptions())
  const update = useMutation(trpc.purchase.update.mutationOptions())
  const post = useMutation(trpc.purchase.post.mutationOptions())
  const discard = useMutation(trpc.purchase.discard.mutationOptions())

  const [purchaseId] = useState(() => purchase?.id ?? newId())
  // The saved version (null until the first save of a new purchase).
  const [version, setVersion] = useState<number | null>(purchase?.version ?? null)
  const [initial] = useState<PurchaseDraft>(() => purchaseDraft(purchase, { today, vatRegistered }))
  const [draft, setDraft] = useState<PurchaseDraft>(initial)
  // What was last saved (or opened): changes since are asked about before leaving.
  const [baseline, setBaseline] = useState<PurchaseDraft>(initial)
  // A saved draft keeps its choice; a new one follows the document type until the person chooses.
  const [vatModeChosen, setVatModeChosen] = useState(purchase !== undefined)
  // Materials added from a line, until the list has read them.
  const [added, setAdded] = useState<MaterialDto[]>([])
  const [quickAdd, setQuickAdd] = useState<{ lineId: string; name: string } | null>(null)
  const [pending, setPending] = useState<File[]>([])
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState<I18nKey | null>(null)
  const [confirm, setConfirm] = useState<'finalize' | 'discard' | null>(null)
  const [confirmError, setConfirmError] = useState<I18nKey | null>(null)
  const [busy, setBusy] = useState<'saving' | 'finalizing' | 'discarding' | null>(null)
  const [addingSupplier, setAddingSupplier] = useState(false)
  // Finalize was tapped while the closed books stop it: said at the top too.
  const [finalizeBlocked, setFinalizeBlocked] = useState(false)
  const form = useRef<HTMLFormElement>(null)

  const materials = useMemo(
    () =>
      added.length === 0
        ? loaded
        : new Map<string, MaterialDto>([...loaded, ...added.map((m) => [m.id, m] as const)]),
    [loaded, added],
  )
  const payerItems = payers.data?.items
  const payerIds = useMemo(
    () => (payerItems ? new Set(payerItems.map((payer) => payer.memberId)) : undefined),
    [payerItems],
  )
  const me = payerItems?.find((payer) => payer.isMe)

  const currency = (purchase?.currency ?? context?.currency ?? 'AED') as CurrencyCode
  const check = useMemo(
    () => checkPurchase(draft, { currency, materials, vatRegistered, today, payers: payerIds }),
    [draft, currency, materials, vatRegistered, today, payerIds],
  )
  const profile = context?.terminologyProfile ?? 'general'
  // In the business's wording ("ingredients" for food, "raw materials" for a factory).
  const shown = (error: FieldError | undefined): string | undefined =>
    error && (submitted || !MISSING_KEYS.has(error.key))
      ? term(error.key, profile, error.values)
      : undefined
  const supplierNeeded =
    check.errors.paymentMethod?.key === 'purchasing.editor.errors.paymentMethodSupplier' &&
    shown(check.errors.paymentMethod) !== undefined
  const listHref = `/b/${businessId}/purchases`
  // The books-closed date stops finalizing on this date (D-114 rule 6): said under the date at once
  // to a member who may finalize.
  const closed = canPost ? closedFor(draft.businessDate, today, closedThrough) : null
  const closedNote =
    closed && closedThrough
      ? t(
          closed === 'today' ? 'purchasing.editor.closedToday' : 'purchasing.editor.closedEarlier',
          {
            date: businessDate(closedThrough),
          },
        )
      : null

  // The pickers: what is in use, and what this draft already names (an archived one stays shown).
  const pickableMaterials = useMemo(() => {
    const named = new Set(
      draft.lines.flatMap((line) => (line.kind === 'material' ? [line.materialId] : [])),
    )
    return [...materials.values()].filter((m) => m.archivedAt === null || named.has(m.id))
  }, [materials, draft.lines])
  const pickableSuppliers = supplierOptions.suppliers.filter(
    (supplier) => supplier.archivedAt === null || supplier.id === draft.supplierId,
  )

  const set = (patch: Partial<PurchaseDraft>) => setDraft((d) => ({ ...d, ...patch }))
  const setLine = (next: LineDraft) =>
    setDraft((d) => ({ ...d, lines: d.lines.map((line) => (line.id === next.id ? next : line)) }))
  const removeLine = (id: string) =>
    setDraft((d) => ({ ...d, lines: d.lines.filter((line) => line.id !== id) }))
  const lineVat = () => defaultVatRate(vatRegistered, draft.documentType)

  // Paid by a member: the one entering it, until someone else is picked.
  const meId = me?.memberId
  useEffect(() => {
    if (draft.paymentMethod === 'paid_by_member' && draft.paidByMemberId === '' && meId) {
      setDraft((d) => ({ ...d, paidByMemberId: meId }))
    }
  }, [draft.paymentMethod, draft.paidByMemberId, meId])

  function setDocumentType(documentType: PurchaseDocumentType) {
    // Lines still at the old type's starting VAT follow the new type's; so do the prices' VAT until
    // the person chooses.
    const before = defaultVatRate(vatRegistered, draft.documentType)
    const after = defaultVatRate(vatRegistered, documentType)
    setDraft((d) => ({
      ...d,
      documentType,
      pricesIncludeVat: vatModeChosen ? d.pricesIncludeVat : defaultPricesIncludeVat(documentType),
      lines: d.lines.map((line) => (line.vatRate === before ? { ...line, vatRate: after } : line)),
    }))
  }

  function setPaymentMethod(paymentMethod: PaymentMethod | '') {
    set({
      paymentMethod,
      paidByMemberId:
        paymentMethod === 'paid_by_member' ? draft.paidByMemberId || (meId ?? '') : '',
    })
  }

  /** The material a line's quick-add picked: the new one, or one that already had the name. */
  function pickAdded(lineId: string, material: MaterialDto) {
    if (!loaded.has(material.id)) {
      setAdded((current) => [...current.filter((m) => m.id !== material.id), material])
    }
    setDraft((d) => ({
      ...d,
      lines: d.lines.map((line) =>
        line.id === lineId && line.kind === 'material'
          ? {
              ...line,
              materialId: material.id,
              unit: isUnitOf(material, line.unit) ? line.unit : defaultUnitOf(material),
              savedName: null,
            }
          : line,
      ),
    }))
  }

  // The first field to fix, in the middle of the screen (its label too, not under the top bar).
  const focusFirstError = () =>
    setTimeout(() => {
      const field = form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')
      field?.focus({ preventScroll: true })
      field?.scrollIntoView({ block: 'center' })
    })

  /** Creates or updates the draft, then attaches the receipts picked before its first save. */
  async function save(fields: PurchaseFields): Promise<PurchaseResultDto> {
    const snapshot = draft
    const result =
      version === null
        ? await create.mutateAsync({ id: purchaseId, ...fields })
        : await update.mutateAsync({ id: purchaseId, version, ...fields })
    setVersion(result.data.version)
    setBaseline(snapshot)
    queryClient.setQueryData(trpc.purchase.get.queryKey({ id: purchaseId }), result)
    if (pending.length > 0) {
      const files = pending
      setPending([])
      for (const file of files) {
        try {
          await upload(purchaseId, file)
        } catch (caught) {
          toast.error(
            t(caught instanceof ReceiptError ? caught.key : 'errors.internal') + ` (${file.name})`,
          )
        }
      }
    }
    void queryClient.invalidateQueries({ queryKey: trpc.purchase.list.pathKey() })
    return result
  }

  function errorKey(error: unknown): I18nKey {
    return apiErrorCode(error) === 'conflict' ? 'purchasing.editor.conflict' : apiErrorKey(error)
  }

  /** Checks the form; true when it can be saved (else the first field to fix gets the focus). */
  function ready(): boolean {
    setSubmitted(true)
    setServerError(null)
    if (!check.fields) {
      focusFirstError()
      return false
    }
    return true
  }

  /** Saves the draft where it is; true once saved (the form says what went wrong otherwise). */
  async function saveHere(): Promise<boolean> {
    if (busy || !ready()) return false
    setBusy('saving')
    try {
      await save(check.fields!)
      toast.success(t('purchasing.editor.saved'))
      return true
    } catch (error) {
      setServerError(errorKey(error))
      return false
    } finally {
      setBusy(null)
    }
  }

  // Leaving with changes asks first (Save saves the draft, then leaves).
  const dirty = !sameData(draft, baseline) || pending.length > 0
  useUnsavedChanges({ dirty, save: saveHere })

  /** A new purchase, once saved, opens at its own address (in place of the new-purchase page). */
  async function openSaved() {
    await beforeNavigate()
    router.replace(`${listHref}/${purchaseId}`)
  }

  async function saveDraft(event: FormEvent) {
    event.preventDefault()
    const isNew = version === null
    if (!(await saveHere())) return
    if (isNew) await openSaved()
  }

  function askFinalize() {
    if (busy || !ready()) return
    if (!check.hasMaterial) {
      setServerError('purchasing.editor.errors.needMaterial')
      return
    }
    if (closed) {
      setFinalizeBlocked(true)
      setTimeout(() => form.current?.querySelector<HTMLElement>('input[type="date"]')?.focus())
      return
    }
    setFinalizeBlocked(false)
    setConfirmError(null)
    setConfirm('finalize')
  }

  async function finalize() {
    if (!check.fields) return
    setBusy('finalizing')
    setConfirmError(null)
    const isNew = version === null
    let saved: PurchaseResultDto | null = null
    try {
      saved = await save(check.fields)
      const posted = await post.mutateAsync({ id: purchaseId, version: saved.data.version })
      queryClient.setQueryData(trpc.purchase.get.queryKey({ id: purchaseId }), posted)
      void queryClient.invalidateQueries({ queryKey: trpc.purchase.list.pathKey() })
      void queryClient.invalidateQueries({ queryKey: trpc.material.costs.pathKey() })
      void queryClient.invalidateQueries({ queryKey: trpc.product.costs.pathKey() })
      void queryClient.invalidateQueries({ queryKey: trpc.recipe.get.pathKey() })
      void queryClient.invalidateQueries({ queryKey: trpc.payable.list.pathKey() })
      toast.success(t('purchasing.confirm.finalized', { names: names() }))
      setConfirm(null)
      if (isNew) await openSaved()
    } catch (error) {
      if (isNew && saved) {
        // Saved as a draft, then finalizing failed: the draft's own page from now on, with the
        // problem said there (this page and its dialog go away).
        toast.error(t('purchasing.editor.savedNotFinalized', { reason: t(errorKey(error)) }))
        setConfirm(null)
        await openSaved()
      } else setConfirmError(errorKey(error))
    } finally {
      setBusy(null)
    }
  }

  async function discardDraft() {
    if (version === null) return
    setBusy('discarding')
    setConfirmError(null)
    try {
      await discard.mutateAsync({ id: purchaseId, version })
      setBaseline(draft)
      setPending([])
      void queryClient.invalidateQueries({ queryKey: trpc.purchase.list.pathKey() })
      toast.success(t('purchasing.confirm.discarded'))
      await beforeNavigate()
      router.replace(listHref)
    } catch (error) {
      setConfirmError(errorKey(error))
      setBusy(null)
    }
  }

  const names = () =>
    formatList(
      locale,
      materialNames(draft, materials).map((name) => isolate(name)),
    )

  function pickSupplier(value: string) {
    if (value === NEW_SUPPLIER) setAddingSupplier(true)
    else set({ supplierId: value })
  }

  const hasShownErrors = submitted && check.fields === null
  const materialLabel = term('purchasing.editor.addMaterial', profile)
  const materialLines = draft.lines.filter((line) => line.kind === 'material')
  // The one who paid, when they have left the business since (a draft saved before).
  const leftPayer =
    draft.paymentMethod === 'paid_by_member' &&
    draft.paidByMemberId !== '' &&
    payerIds !== undefined &&
    !payerIds.has(draft.paidByMemberId)
      ? draft.paidByMemberId
      : null
  const includesVat = vatRegistered && draft.pricesIncludeVat

  if (!context) return null
  return (
    <PageContainer>
      <Link
        href={listHref}
        className="-ms-2 -mt-2 mb-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-primary hover:underline"
      >
        <ArrowLeftIcon aria-hidden className="size-4 rtl:rotate-180" />
        {t('common.nav.purchases')}
      </Link>
      <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              {version === null
                ? t('purchasing.editor.newTitle')
                : t('purchasing.editor.draftTitle')}
            </h1>
            {version === null ? null : <StatusBadge status="draft" />}
          </div>
          <p className="mt-1.5 max-w-2xl text-muted-foreground">
            {term('purchasing.editor.intro', profile)}
          </p>
        </div>
        {version === null ? null : (
          <Button
            type="button"
            variant="ghost"
            className="self-start text-destructive hover:text-destructive"
            onClick={() => {
              setConfirmError(null)
              setConfirm('discard')
            }}
          >
            <Trash2Icon aria-hidden />
            {t('purchasing.editor.discard')}
          </Button>
        )}
      </header>
      {purchase?.copiedFromId ? (
        <FormAlert tone="info" className="mb-4">
          {t('purchasing.editor.copiedFrom')}{' '}
          <Link
            href={`${listHref}/${purchase.copiedFromId}`}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            {t('purchasing.editor.openOriginal')}
          </Link>
        </FormAlert>
      ) : null}

      <form
        ref={form}
        method="post"
        noValidate
        onSubmit={(event) => void saveDraft(event)}
        className="space-y-5"
      >
        {serverError ? <FormAlert tone="error">{term(serverError, profile)}</FormAlert> : null}
        {finalizeBlocked && closedNote ? <FormAlert tone="error">{closedNote}</FormAlert> : null}
        {hasShownErrors && !serverError ? (
          <FormAlert tone="error">{t('catalog.form.fixErrors')}</FormAlert>
        ) : null}

        <Panel title={t('purchasing.editor.details')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label={t('purchasing.editor.supplier')}
              render={(a11y) => (
                <NativeSelect
                  {...a11y}
                  // On credit without a supplier: the supplier is what to fix (the message is under
                  // the payment method), so it is marked and gets the focus first.
                  aria-invalid={a11y['aria-invalid'] || supplierNeeded}
                  value={draft.supplierId}
                  onChange={(event) => pickSupplier(event.target.value)}
                  disabled={!supplierOptions.enabled}
                >
                  <option value="">{t('purchasing.editor.noSupplier')}</option>
                  {supplierOptions.enabled ? null : draft.supplierId ? (
                    <option value={draft.supplierId}>{purchase?.supplierName ?? '…'}</option>
                  ) : null}
                  {pickableSuppliers.map((supplier) => (
                    <option key={supplier.id} value={supplier.id}>
                      {supplier.name}
                    </option>
                  ))}
                  {canAddSupplier ? (
                    <option value={NEW_SUPPLIER}>{t('purchasing.editor.newSupplier')}</option>
                  ) : null}
                </NativeSelect>
              )}
            />
            <TextField
              label={t('purchasing.editor.date')}
              type="date"
              min={canPost ? firstOpenDay(today, closedThrough) : undefined}
              max={today}
              value={draft.businessDate}
              onChange={(event) => set({ businessDate: event.target.value })}
              error={
                shown(check.errors.businessDate) ??
                (closed === 'earlier' && closedNote ? closedNote : undefined)
              }
              hint={
                closed === 'today' && closedNote
                  ? (id) => (
                      <div id={id}>
                        <FormAlert tone="info">{closedNote}</FormAlert>
                      </div>
                    )
                  : undefined
              }
            />
            <TextField
              label={t('purchasing.editor.documentType')}
              render={(a11y) => (
                <NativeSelect
                  {...a11y}
                  value={draft.documentType}
                  onChange={(event) => setDocumentType(event.target.value as PurchaseDocumentType)}
                >
                  {PURCHASE_DOCUMENT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {t(`purchasing.documentTypes.${type}`)}
                    </option>
                  ))}
                </NativeSelect>
              )}
            />
            {locationOptions.enabled ? (
              <TextField
                label={t('purchasing.editor.location')}
                render={(a11y) => (
                  <NativeSelect
                    {...a11y}
                    value={
                      draft.locationId ??
                      locationOptions.locations.find((location) => location.isDefault)?.id ??
                      ''
                    }
                    onChange={(event) => set({ locationId: event.target.value || null })}
                  >
                    {locationOptions.locations.map((location) => (
                      <option key={location.id} value={location.id}>
                        {location.name}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              />
            ) : null}
            <TextField
              label={<Required>{t('purchasing.editor.payment')}</Required>}
              error={shown(check.errors.paymentMethod)}
              hint={
                isOwedPaymentMethod(draft.paymentMethod)
                  ? (id) => (
                      <p id={id} className="text-sm text-muted-foreground">
                        {t(
                          draft.paymentMethod === 'supplier_credit'
                            ? 'purchasing.editor.owedToSupplierHint'
                            : 'purchasing.editor.owedToMemberHint',
                        )}
                      </p>
                    )
                  : undefined
              }
              render={(a11y) => (
                <NativeSelect
                  {...a11y}
                  aria-required
                  value={draft.paymentMethod}
                  onChange={(event) => setPaymentMethod(event.target.value as PaymentMethod | '')}
                >
                  <option value="" disabled>
                    {t('purchasing.editor.paymentPick')}
                  </option>
                  {PAYMENT_METHODS.map((method) => (
                    <option key={method} value={method}>
                      {t(`purchasing.paymentMethods.${method}`)}
                    </option>
                  ))}
                </NativeSelect>
              )}
            />
            {draft.paymentMethod === 'paid_by_member' ? (
              // Under the payment method it depends on (beside it when the location is shown).
              <div className="sm:col-start-2">
                <TextField
                  label={<Required>{t('purchasing.editor.payer')}</Required>}
                  render={(a11y) => (
                    <NativeSelect
                      {...a11y}
                      aria-required
                      value={draft.paidByMemberId}
                      onChange={(event) => set({ paidByMemberId: event.target.value })}
                    >
                      <option value="" disabled>
                        {t('purchasing.editor.payerPick')}
                      </option>
                      {leftPayer ? (
                        <option value={leftPayer} disabled>
                          {t('purchasing.editor.payerLeftOption', {
                            name: purchase?.paidByMemberName ?? '…',
                          })}
                        </option>
                      ) : null}
                      {(payerItems ?? []).map((payer) => (
                        <option key={payer.memberId} value={payer.memberId}>
                          {payer.isMe
                            ? t('purchasing.editor.payerMe', { name: payer.name })
                            : payer.name}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                />
              </div>
            ) : null}
          </div>
          {vatRegistered && draft.documentType === 'tax_invoice' ? (
            <div className="mt-4 flex items-start justify-between gap-4 rounded-xl border bg-background/60 p-4">
              <div className="min-w-0">
                <p id="vat-not-reclaimable" className="text-sm font-medium">
                  {t('purchasing.editor.vatNotReclaimable')}
                </p>
                <p id="vat-not-reclaimable-hint" className="mt-0.5 text-sm text-muted-foreground">
                  {t('purchasing.editor.vatNotReclaimableHint')}
                </p>
              </div>
              <Switch
                checked={draft.vatNotReclaimable}
                onCheckedChange={(checked) => set({ vatNotReclaimable: checked })}
                aria-labelledby="vat-not-reclaimable"
                aria-describedby="vat-not-reclaimable-hint"
                className="mt-1"
              />
            </div>
          ) : null}
        </Panel>

        <Panel
          title={t('purchasing.editor.items')}
          hint={term('purchasing.editor.itemsHint', profile)}
        >
          {vatRegistered ? (
            <VatModeChoice
              value={draft.pricesIncludeVat}
              onChange={(pricesIncludeVat) => {
                setVatModeChosen(true)
                set({ pricesIncludeVat })
              }}
            />
          ) : null}
          {!canSeeMaterials ? (
            <FormAlert tone="info" className="mb-3">
              {term('purchasing.editor.noMaterialAccess', profile)}
            </FormAlert>
          ) : materialsReady && pickableMaterials.length === 0 ? (
            <FormAlert tone="info" className="mb-3">
              {term('purchasing.editor.noMaterialsYet', profile)}
            </FormAlert>
          ) : null}
          <div className="space-y-3">
            {draft.lines.map((line) =>
              line.kind === 'material' ? (
                <MaterialLineRow
                  key={line.id}
                  index={materialLines.indexOf(line)}
                  line={line}
                  materials={materials}
                  pickable={pickableMaterials}
                  errors={check.errors.lines[line.id]}
                  shown={shown}
                  amounts={check.lineAmounts.get(line.id)}
                  vatRegistered={vatRegistered}
                  pricesIncludeVat={includesVat}
                  profile={profile}
                  onChange={setLine}
                  onRemove={draft.lines.length > 1 ? () => removeLine(line.id) : undefined}
                  onAddMaterial={
                    canSeeMaterials ? (name) => setQuickAdd({ lineId: line.id, name }) : undefined
                  }
                />
              ) : (
                <DeliveryLineRow
                  key={line.id}
                  line={line}
                  profile={profile}
                  errors={check.errors.lines[line.id]}
                  shown={shown}
                  vatRegistered={vatRegistered}
                  pricesIncludeVat={includesVat}
                  onChange={setLine}
                  onRemove={() => removeLine(line.id)}
                />
              ),
            )}
            {check.errors.document ? (
              <p role="alert" className="text-sm text-destructive">
                {term(check.errors.document.key, profile, check.errors.document.values)}
              </p>
            ) : null}
            <AddLineButtons
              materialLabel={materialLabel}
              onMaterial={() => set({ lines: [...draft.lines, newMaterialLine(lineVat())] })}
              onDelivery={() => set({ lines: [...draft.lines, newDeliveryLine(lineVat())] })}
            />
          </div>
          <div className="mt-4 border-t pt-3">
            <DiscountRow
              kind={draft.discountKind}
              value={draft.discount}
              invalid={Boolean(shown(check.errors.discount))}
              addLabel={t('purchasing.editor.addDocumentDiscount')}
              label={t('purchasing.editor.documentDiscount')}
              onChange={(next) => set({ discountKind: next.kind, discount: next.value })}
            />
            {draft.discountKind !== 'none' ? (
              <p className="mt-1.5 text-sm text-muted-foreground">
                {term(
                  includesVat
                    ? 'purchasing.editor.documentDiscountHintInclVat'
                    : 'purchasing.editor.documentDiscountHint',
                  profile,
                )}
              </p>
            ) : null}
            {shown(check.errors.discount) ? (
              <p role="alert" className="mt-1.5 text-sm text-destructive">
                {shown(check.errors.discount)}
              </p>
            ) : null}
          </div>
        </Panel>

        <Panel
          title={t('purchasing.totals.title')}
          hint={includesVat ? t('purchasing.totals.includedHint') : undefined}
        >
          <Totals
            subtotal={check.amounts.subtotal}
            discount={check.amounts.discount}
            net={check.amounts.net}
            vat={check.amounts.vat}
            total={check.amounts.total}
            vatRegistered={vatRegistered}
            money={(amount) => money(amount, currency)}
          />
        </Panel>

        <Panel title={t('purchasing.editor.moreDetails')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label={t('purchasing.editor.reference')}
              autoComplete="off"
              className="[unicode-bidi:plaintext]"
              value={draft.reference}
              onChange={(event) => set({ reference: event.target.value })}
              error={shown(check.errors.reference)}
              hint={(id) => (
                <p id={id} className="text-sm text-muted-foreground">
                  {t('purchasing.optional')}
                </p>
              )}
            />
          </div>
          <div className="mt-4 space-y-2">
            <p className="text-sm font-medium">{t('purchasing.notes')}</p>
            <Textarea
              aria-label={t('purchasing.notes')}
              aria-invalid={Boolean(shown(check.errors.notes))}
              className="[unicode-bidi:plaintext]"
              rows={3}
              placeholder={t('purchasing.notesHint')}
              value={draft.notes}
              onChange={(event) => set({ notes: event.target.value })}
            />
            {shown(check.errors.notes) ? (
              <p role="alert" className="mt-1.5 text-sm text-destructive">
                {shown(check.errors.notes)}
              </p>
            ) : null}
          </div>
        </Panel>

        <Panel title={t('purchasing.receipts.title')} hint={t('purchasing.receipts.hint')}>
          {version === null ? (
            <PendingReceipts files={pending} onChange={setPending} />
          ) : (
            <Receipts recordId={purchaseId} canManage />
          )}
        </Panel>

        <div className="sticky bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-10 flex items-center gap-3 rounded-2xl bg-card/95 p-3 shadow-lg ring-1 ring-foreground/10 backdrop-blur md:bottom-4">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground">{t('purchasing.totals.total')}</p>
            <p className="truncate font-semibold tabular-nums">
              {money(check.amounts.total, currency)}
            </p>
          </div>
          <Button type="submit" variant="outline" disabled={busy !== null}>
            {busy === 'saving' ? t('status.saving') : t('purchasing.editor.saveDraft')}
          </Button>
          {canPost ? (
            <Button type="button" disabled={busy !== null} onClick={askFinalize}>
              <CheckCheckIcon aria-hidden />
              {t('purchasing.editor.finalize')}
            </Button>
          ) : null}
        </div>
      </form>

      <ConfirmDialog
        open={confirm === 'finalize'}
        icon={CheckCheckIcon}
        title={t('purchasing.confirm.finalizeTitle')}
        body={t('purchasing.confirm.finalizeBody', { names: names() })}
        note={t('purchasing.confirm.finalizeNote')}
        action={t('purchasing.confirm.finalizeAction')}
        busyLabel={t('purchasing.confirm.finalizing')}
        busy={busy === 'finalizing'}
        error={confirmError}
        onConfirm={() => void finalize()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'discard'}
        icon={Trash2Icon}
        title={t('purchasing.confirm.discardTitle')}
        body={t('purchasing.confirm.discardBody')}
        action={t('purchasing.confirm.discardAction')}
        busyLabel={t('status.deleting')}
        busy={busy === 'discarding'}
        error={confirmError}
        destructive
        onConfirm={() => void discardDraft()}
        onClose={() => setConfirm(null)}
      />
      {addingSupplier ? (
        <SupplierSheet
          onClose={() => setAddingSupplier(false)}
          onSaved={(supplier: SupplierDto) => set({ supplierId: supplier.id })}
        />
      ) : null}
      {quickAdd ? (
        <QuickMaterialSheet
          name={quickAdd.name}
          materials={materials}
          profile={profile}
          onClose={() => setQuickAdd(null)}
          onPicked={(material) => pickAdded(quickAdd.lineId, material)}
        />
      ) : null}
    </PageContainer>
  )
}
