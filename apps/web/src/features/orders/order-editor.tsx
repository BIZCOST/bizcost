'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { OrderDto, OrderResultDto, ProductDto } from '@bizcost/contracts'
import {
  compareDecimal,
  newId,
  SETTLEMENT_METHODS,
  sumDecimals,
  type CurrencyCode,
  type SettlementMethod,
} from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeftIcon, PlusIcon } from 'lucide-react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { Required } from '@/components/form/required'
import { TextField } from '@/components/form/text-field'
import { sameData } from '@/components/form/unsaved'
import { useBeforeNavigate, useUnsavedChanges } from '@/components/form/unsaved-changes'
import { isolate, ltrIsolate } from '@/components/form/use-message'
import { PageContainer } from '@/components/shell/page-container'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'
import type { FieldError } from '@/features/catalog/numbers'
import { ProductSheet } from '@/features/catalog/product-sheet'
import { CustomerPicker } from '@/features/customers/customer-picker'
import { mayAddCustomers, mayPickCustomers } from '@/features/customers/data'
import { useMoney } from '@/features/documents/amounts'
import { DiscountRow, MoneyInput } from '@/features/documents/line-editor'
import { Panel } from '@/features/documents/panel'
import { Totals } from '@/features/documents/totals'
import { hasModule } from '@/features/purchasing/data'
import { Receipts } from '@/features/purchasing/receipts'
import {
  defaultChannelId,
  useAllProducts,
  useChannels,
  useSaleLocations,
} from '@/features/sales/data'
import { DeliveryFields } from '@/features/sales/delivery-fields'
import { newItemLine, type ItemLineDraft } from '@/features/sales/sale-draft'
import { ItemLineRow } from '@/features/sales/sale-lines'
import { can } from '@/features/settings/sections'
import { useTerminology } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import { mayRecordPayments, useRefreshOrders } from './data'
import { checkOrder, ORDER_MISSING, orderDraft, type OrderDraft, type PaidNow } from './order-draft'

// A new order, or a pending one changed (M3 Step 5; Q16, Q17, Q19, D-265): the customer (picked by
// name, with "Did you mean …?" before a new one is added) and their LPO; the day it was taken and
// when it is due; what they ordered (each line a product or service, added on the spot), a discount
// on the whole order; delivery yes or no (the area, what the customer is charged, what it costs);
// notes; and for a new order "Paid now / Deposit" with how it was paid (never picked for them). A
// saved order takes the customer's LPO and other files. Nothing counts in the books until the order is
// delivered. Leaving with changes asks first.

const PAID_NOW: readonly PaidNow[] = ['none', 'deposit', 'all']

export function OrderEditor({
  order,
  today,
}: {
  /** Absent: a new order. */
  order?: OrderDto
  /** Today in the business's time zone (books.get). */
  today: string
}) {
  const { t } = useTranslation()
  const term = useTerminology()
  const money = useMoney()
  const trpc = useTRPC()
  const router = useRouter()
  const queryClient = useQueryClient()
  const beforeNavigate = useBeforeNavigate()
  const refresh = useRefreshOrders()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const vatRegistered = context?.capabilities.vat_registered === true
  const canSeeProducts =
    context !== undefined && hasModule(context, 'products') && can(context, 'products.items.view')
  const canAddProducts = context !== undefined && can(context, 'products.items.manage')
  const resale =
    context !== undefined &&
    hasModule(context, 'materials') &&
    can(context, 'materials.items.manage')
      ? 'offered'
      : 'none'
  const seesCosts = context?.visibleCategories.includes('cost') === true
  const { channels } = useChannels()
  const { products: loaded, ready: productsReady } = useAllProducts(canSeeProducts)
  const create = useMutation(trpc.order.create.mutationOptions())
  const update = useMutation(trpc.order.update.mutationOptions())

  const [orderId] = useState(() => order?.id ?? newId())
  const [paymentId] = useState(() => newId())
  const [initial] = useState<OrderDraft>(() =>
    orderDraft(order, {
      today,
      locationId:
        context && !context.locationScope.all ? (context.locationScope.ids[0] ?? null) : null,
    }),
  )
  const [draft, setDraft] = useState<OrderDraft>(initial)
  const [baseline, setBaseline] = useState<OrderDraft>(initial)
  const [added, setAdded] = useState<ProductDto[]>([])
  const [quickAdd, setQuickAdd] = useState<{ lineId: string; name: string } | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState<I18nKey | null>(null)
  const [busy, setBusy] = useState(false)
  const form = useRef<HTMLFormElement>(null)
  const paidId = useId()

  const channelId = draft.channelId ?? defaultChannelId(channels)
  const locations = useSaleLocations(context, today, channelId)
  const products = useMemo(
    () =>
      added.length === 0
        ? loaded
        : new Map<string, ProductDto>([...loaded, ...added.map((p) => [p.id, p] as const)]),
    [loaded, added],
  )
  const currency = (order?.currency ?? context?.currency ?? 'AED') as CurrencyCode
  // The delivery cost is the member's to type on their own order, or with the costs switch (D-230).
  const deliveryCostShown = order === undefined || order.mine || seesCosts
  const paymentAsked = order === undefined && context !== undefined && mayRecordPayments(context)
  const check = useMemo(
    () =>
      checkOrder(
        { ...draft, channelId },
        {
          currency,
          vatRegistered,
          today,
          products,
          deliveryCostShown,
          storedDeliveryCost: initial.deliveryCost,
          paymentAsked,
        },
      ),
    [
      draft,
      channelId,
      currency,
      vatRegistered,
      today,
      products,
      deliveryCostShown,
      initial,
      paymentAsked,
    ],
  )
  const profile = context?.terminologyProfile ?? 'general'
  const shown = (error: FieldError | undefined): string | undefined =>
    error && (submitted || !ORDER_MISSING.has(error.key))
      ? term(error.key, profile, error.values)
      : undefined
  const listHref = `/b/${businessId}/orders`
  const pickable = useMemo(() => {
    const named = new Set(draft.lines.map((line) => line.productId))
    return [...products.values()].filter((p) => p.archivedAt === null || named.has(p.id))
  }, [products, draft.lines])
  // An order with payments keeps its customer (D-265).
  const paid = order?.payment ? compareDecimal(order.payment.paid, '0') > 0 : false

  const set = (patch: Partial<OrderDraft>) => setDraft((d) => ({ ...d, ...patch }))
  const setLine = (next: ItemLineDraft) =>
    setDraft((d) => ({ ...d, lines: d.lines.map((line) => (line.id === next.id ? next : line)) }))
  const removeLine = (id: string) =>
    setDraft((d) => ({ ...d, lines: d.lines.filter((line) => line.id !== id) }))

  function pickAdded(lineId: string, product: ProductDto) {
    if (!loaded.has(product.id)) {
      setAdded((current) => [...current.filter((p) => p.id !== product.id), product])
    }
    setDraft((d) => ({
      ...d,
      lines: d.lines.map((line) =>
        line.id === lineId
          ? { ...line, productId: product.id, price: product.defaultPrice ?? line.price }
          : line,
      ),
    }))
  }

  function errorKey(error: unknown): I18nKey {
    return apiErrorCode(error) === 'conflict' ? 'orders.conflict' : apiErrorKey(error)
  }

  /** Saves the order; its result once saved (the form says what went wrong otherwise). */
  async function save(): Promise<OrderResultDto | null> {
    if (busy) return null
    setSubmitted(true)
    setServerError(null)
    const fields = check.fields
    if (!fields) {
      setTimeout(() => {
        const field = form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')
        field?.focus({ preventScroll: true })
        field?.scrollIntoView({ block: 'center' })
      })
      return null
    }
    setBusy(true)
    const snapshot = draft
    try {
      const result = order
        ? await update.mutateAsync({ id: orderId, version: order.version, ...fields })
        : await create.mutateAsync({
            id: orderId,
            ...fields,
            payment: check.payment ? { id: paymentId, ...check.payment, note: null } : null,
          })
      setBaseline(snapshot)
      queryClient.setQueryData(trpc.order.get.queryKey({ id: orderId }), result)
      void refresh()
      return result
    } catch (error) {
      setServerError(errorKey(error))
      return null
    } finally {
      setBusy(false)
    }
  }

  const dirty = !sameData(draft, baseline)
  useUnsavedChanges({ dirty, save: async () => (await save()) !== null })

  async function submit(event: FormEvent) {
    event.preventDefault()
    const saved = await save()
    if (!saved) return
    toast.success(
      order
        ? t('orders.editor.saved')
        : t('orders.editor.created', { number: isolate(saved.data.number) }),
    )
    await beforeNavigate()
    router.replace(`${listHref}/${saved.data.id}`)
  }

  if (!context) return null
  const hasShownErrors = submitted && check.fields === null
  const amounts = check.amounts
  const addLabel = (name: string) =>
    term(
      context.sellsOnlyServices ? 'sales.editor.addOption_services' : 'sales.editor.addOption',
      profile,
      { name },
    )
  const customersShown = mayPickCustomers(context)

  return (
    <PageContainer>
      <Link
        href={order ? `${listHref}/${order.id}` : listHref}
        className="-ms-2 -mt-2 mb-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-primary hover:underline"
      >
        <ArrowLeftIcon aria-hidden className="size-4 rtl:rotate-180" />
        {order ? t('orders.view.title', { number: isolate(order.number) }) : t('common.nav.orders')}
      </Link>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {order
            ? t('orders.editor.editTitle', { number: isolate(order.number) })
            : t('orders.editor.newTitle')}
        </h1>
        <p className="mt-1.5 max-w-2xl text-muted-foreground">
          {term('orders.editor.intro', profile)}
        </p>
      </header>

      <form
        ref={form}
        method="post"
        noValidate
        onSubmit={(event) => void submit(event)}
        className="space-y-5"
      >
        {serverError ? <FormAlert tone="error">{term(serverError, profile)}</FormAlert> : null}
        {hasShownErrors && !serverError ? (
          <FormAlert tone="error">{t('catalog.form.fixErrors')}</FormAlert>
        ) : null}

        <Panel title={t('orders.editor.forWhom')}>
          <div className="grid gap-4 sm:grid-cols-2">
            {customersShown ? (
              <TextField
                label={t('orders.customers.picker.label')}
                hint={
                  paid
                    ? (id) => (
                        <p id={id} className="text-sm text-muted-foreground">
                          {t('orders.editor.customerKept')}
                        </p>
                      )
                    : undefined
                }
                render={(a11y) => (
                  <CustomerPicker
                    value={draft.customer}
                    label={t('orders.customers.picker.label')}
                    describedBy={a11y['aria-describedby']}
                    canAdd={mayAddCustomers(context)}
                    disabled={paid}
                    onChange={(customer) => set({ customer })}
                  />
                )}
              />
            ) : null}
            <TextField
              label={term('orders.editor.customerRef', profile)}
              autoComplete="off"
              dir="auto"
              className="[unicode-bidi:plaintext]"
              value={draft.customerRef}
              onChange={(event) => set({ customerRef: event.target.value })}
              error={shown(check.errors.customerRef)}
              hint={(id) => (
                <p id={id} className="text-sm text-muted-foreground">
                  {term('orders.editor.customerRefHint', profile)}
                </p>
              )}
            />
          </div>
        </Panel>

        <Panel title={t('sales.editor.details')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label={t('orders.editor.date')}
              type="date"
              max={today}
              value={draft.businessDate}
              onChange={(event) => set({ businessDate: event.target.value })}
              error={shown(check.errors.businessDate)}
            />
            <TextField
              label={t('orders.editor.dueDate')}
              type="date"
              min={draft.businessDate || undefined}
              value={draft.dueDate}
              onChange={(event) => set({ dueDate: event.target.value })}
              error={shown(check.errors.dueDate)}
              hint={(id) => (
                <p id={id} className="text-sm text-muted-foreground">
                  {t('orders.optional')}
                </p>
              )}
            />
            {channels.length > 1 ? (
              <TextField
                label={term('orders.editor.channel', profile)}
                render={(a11y) => (
                  <NativeSelect
                    {...a11y}
                    value={channelId ?? ''}
                    onChange={(event) => set({ channelId: event.target.value || null })}
                  >
                    {channels.map((channel) => (
                      <option key={channel.id} value={channel.id}>
                        {channel.name}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              />
            ) : null}
            {locations && locations.length > 1 ? (
              <TextField
                label={t('sales.editor.location')}
                render={(a11y) => (
                  <NativeSelect
                    {...a11y}
                    value={
                      draft.locationId ??
                      locations.find((location) => location.isDefault)?.id ??
                      locations[0]!.id
                    }
                    onChange={(event) => set({ locationId: event.target.value || null })}
                  >
                    {locations.map((location) => (
                      <option key={location.id} value={location.id}>
                        {location.name}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              />
            ) : null}
          </div>
        </Panel>

        <Panel title={t('orders.editor.items')}>
          {!canSeeProducts ? (
            <FormAlert tone="info" className="mb-3">
              {t('sales.editor.noProductAccess')}
            </FormAlert>
          ) : productsReady && pickable.length === 0 ? (
            <FormAlert tone="info" className="mb-3">
              {canAddProducts ? t('sales.editor.noProductsYet') : t('sales.editor.noProductsAsk')}
            </FormAlert>
          ) : null}
          <div className="space-y-3">
            {draft.lines.map((line, index) => (
              <ItemLineRow
                key={line.id}
                index={index}
                line={line}
                products={products}
                pickable={pickable}
                errors={check.errors.lines[line.id]}
                shown={shown}
                amounts={check.lineAmounts.get(line.id)}
                vatRegistered={vatRegistered}
                addLabel={addLabel}
                onChange={setLine}
                onRemove={draft.lines.length > 1 ? () => removeLine(line.id) : undefined}
                onAdd={
                  canAddProducts ? (name) => setQuickAdd({ lineId: line.id, name }) : undefined
                }
              />
            ))}
            <Button
              type="button"
              variant="outline"
              onClick={() => set({ lines: [...draft.lines, newItemLine()] })}
            >
              <PlusIcon aria-hidden />
              {t('sales.editor.addItem')}
            </Button>
            <div data-order-discount>
              <DiscountRow
                kind={draft.discountKind}
                value={draft.discount}
                invalid={Boolean(shown(check.errors.discount))}
                addLabel={t('orders.editor.addDiscount')}
                label={t('orders.editor.discount')}
                onChange={(next) => set({ discountKind: next.kind, discount: next.value })}
              />
              {shown(check.errors.discount) ? (
                <p role="alert" className="mt-1.5 text-sm text-destructive">
                  {shown(check.errors.discount)}
                </p>
              ) : null}
            </div>
          </div>
        </Panel>

        <DeliveryFields
          draft={draft}
          errors={check.errors}
          shown={shown}
          vatRegistered={vatRegistered}
          costShown={deliveryCostShown}
          question={t('orders.editor.deliveryQuestion')}
          onChange={set}
        />

        <Panel title={t('purchasing.totals.title')}>
          <Totals
            subtotal={amounts ? sumDecimals(amounts.lines.map((l) => l.subtotal)) : '0'}
            discount={
              amounts
                ? sumDecimals([...amounts.lines.map((l) => l.discount), amounts.documentDiscount])
                : '0'
            }
            net={amounts?.net ?? '0'}
            vat={amounts?.vat ?? '0'}
            total={amounts?.total ?? '0'}
            vatRegistered={vatRegistered}
            money={(amount) => money(amount, currency)}
          />
          {order?.roundTo ? (
            // An order made from a quotation keeps its rounded total when saved (D-297).
            <p data-order-rounded className="mt-3 border-t pt-3 text-sm text-muted-foreground">
              {t('orders.editor.roundedTotal', {
                total: ltrIsolate(money(order.roundTo, currency)),
              })}
            </p>
          ) : null}
        </Panel>

        {paymentAsked ? (
          <Panel title={t('orders.editor.paidNow')} hint={t('orders.editor.paidNowHint')}>
            <fieldset>
              <legend className="sr-only">{t('orders.editor.paidNow')}</legend>
              <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1 sm:max-w-md">
                {PAID_NOW.map((value) => (
                  <label key={value} className="relative min-w-0">
                    <input
                      type="radio"
                      name={`${paidId}-paid`}
                      value={value}
                      checked={draft.paidNow === value}
                      onChange={() => set({ paidNow: value })}
                      className="peer sr-only"
                    />
                    <span
                      className={cn(
                        'flex min-h-11 cursor-pointer items-center justify-center rounded-md px-1.5 py-1.5 text-center text-sm font-medium text-muted-foreground transition-colors',
                        'peer-checked:bg-card peer-checked:text-foreground peer-checked:shadow-sm',
                        'peer-focus-visible:ring-3 peer-focus-visible:ring-ring',
                      )}
                    >
                      {t(`orders.editor.paid.${value}`)}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            {draft.paidNow !== 'none' ? (
              <div data-paid-now className="mt-4 grid gap-4 sm:grid-cols-2">
                {draft.paidNow === 'deposit' ? (
                  <TextField
                    label={t('orders.editor.depositAmount')}
                    error={shown(check.errors.paidAmount)}
                    render={(a11y) => (
                      <MoneyInput
                        id={a11y.id}
                        invalid={a11y['aria-invalid']}
                        describedBy={a11y['aria-describedby']}
                        value={draft.paidAmount}
                        onChange={(paidAmount) => set({ paidAmount })}
                      />
                    )}
                  />
                ) : (
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{t('orders.editor.paidAll')}</p>
                    <p className="mt-2 font-semibold tabular-nums">
                      <bdi>{money(amounts?.total ?? '0', currency)}</bdi>
                    </p>
                    {shown(check.errors.paidAmount) ? (
                      <p role="alert" className="mt-1.5 text-sm text-destructive">
                        {shown(check.errors.paidAmount)}
                      </p>
                    ) : null}
                  </div>
                )}
                <TextField
                  label={<Required>{t('orders.payment.method')}</Required>}
                  error={shown(check.errors.paidMethod)}
                  render={(a11y) => (
                    <NativeSelect
                      {...a11y}
                      aria-required
                      value={draft.paidMethod}
                      onChange={(event) =>
                        set({ paidMethod: event.target.value as SettlementMethod })
                      }
                    >
                      <option value="" disabled>
                        {t('orders.payment.methodPick')}
                      </option>
                      {SETTLEMENT_METHODS.map((method) => (
                        <option key={method} value={method}>
                          {t(`purchasing.paymentMethods.${method}`)}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                />
              </div>
            ) : null}
          </Panel>
        ) : null}

        <Panel title={t('sales.editor.moreDetails')}>
          <div className="space-y-2">
            <p className="text-sm font-medium">{t('sales.editor.notes')}</p>
            <Textarea
              aria-label={t('sales.editor.notes')}
              aria-invalid={Boolean(shown(check.errors.notes))}
              className="[unicode-bidi:plaintext]"
              rows={3}
              placeholder={term('orders.editor.notesHint', profile)}
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

        {hasModule(context, 'files') ? (
          <Panel title={t('orders.files.title')} hint={term('orders.files.hint', profile)}>
            {order ? (
              <Receipts entity="order" recordId={order.id} canManage />
            ) : (
              <p className="text-sm text-muted-foreground">{t('orders.files.afterSave')}</p>
            )}
          </Panel>
        ) : null}

        <div className="sticky bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-10 flex items-center gap-3 rounded-2xl bg-card/95 p-3 shadow-lg ring-1 ring-foreground/10 backdrop-blur md:bottom-4">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground">{t('purchasing.totals.total')}</p>
            <p data-running-total className="truncate font-semibold tabular-nums">
              {money(amounts?.total ?? '0', currency)}
            </p>
          </div>
          <Button type="submit" disabled={busy}>
            {busy
              ? t('status.saving')
              : order
                ? t('orders.editor.saveChanges')
                : t('orders.editor.save')}
          </Button>
        </div>
      </form>

      {quickAdd ? (
        <ProductSheet
          name={quickAdd.name}
          profile={profile}
          resale={resale}
          onSaved={(product) => pickAdded(quickAdd.lineId, product)}
          onClose={() => setQuickAdd(null)}
        />
      ) : null}
    </PageContainer>
  )
}
