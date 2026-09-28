'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { MaterialDto, PurchaseLineDto, PurchaseResultDto } from '@bizcost/contracts'
import {
  BASE_UNITS,
  compareDecimal,
  newId,
  subtractDecimals,
  type PurchaseReturnKind,
  type Quantity,
} from '@bizcost/domain'
import { formatList, type I18nKey } from '@bizcost/i18n'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeftIcon,
  CheckCheckIcon,
  CopyIcon,
  HandCoinsIcon,
  PackageMinusIcon,
  Trash2Icon,
  TruckIcon,
  Undo2Icon,
} from 'lucide-react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { isolate } from '@/components/form/use-message'
import { PageContainer } from '@/components/shell/page-container'
import { Button } from '@/components/ui/button'
import { PackChainText } from '@/features/catalog/unit-parts'
import { NBSP } from '@/features/catalog/units'
import { can } from '@/features/settings/sections'
import { useLocale } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import { Locked, Money, useBusinessDate, useMoney, useUnitCost } from './amounts'
import { closedFor, nextDay } from './books'
import { ConfirmDialog } from './confirm-dialog'
import { hasModule, useAllMaterials, useLocationOptions } from './data'
import { pricePerCountingUnit, quantityInWords } from './line-units'
import { Panel } from './panel'
import { Totals } from './totals'
import { Receipts } from './receipts'
import { ReturnSheet, useLineQuantity } from './return-sheet'
import { StatusBadge } from './status-badge'

// A purchase as it was recorded (M2 Step 3; D-114, D-120, D-134): a final or reversed one, or a draft
// for a member who may not edit it. Its details, its lines with what their goods cost, its totals,
// its returns and credit notes, and its receipts. A final purchase can be reversed ("as if it was
// never entered") or corrected (reversed, and a copy opened as a new draft); goods can be sent back
// and a credit note recorded. Every action asks first, saying in plain words what it changes.

/** A line's quantity in words: "2 bags = 2 kg" (or as it was bought, without the material). */
function LineQuantity({
  line,
  material,
}: {
  line: PurchaseLineDto
  material: MaterialDto | undefined
}) {
  const lineQuantity = useLineQuantity()
  const ref = line.packId ? { pack: line.packId } : line.unit
  const steps =
    material && ref && (typeof ref === 'string' || material.packs.some((p) => p.id === ref.pack))
      ? quantityInWords(material, line.qty as Quantity, ref)
      : null
  if (steps && steps.length > 0) return <PackChainText steps={steps} />
  return <bdi>{lineQuantity(line.qty, line).replaceAll(' ', NBSP)}</bdi>
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium break-words">{children}</dd>
    </div>
  )
}

export function PurchaseView({
  result,
  today,
  closedThrough,
}: {
  result: PurchaseResultDto
  today: string
  closedThrough: string | null
}) {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const trpc = useTRPC()
  const router = useRouter()
  const queryClient = useQueryClient()
  const money = useMoney()
  const unitCost = useUnitCost()
  const businessDate = useBusinessDate()
  const lineQuantity = useLineQuantity()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const purchase = result.data
  const canSeeMaterials =
    context !== undefined && hasModule(context, 'materials') && can(context, 'materials.items.view')
  const { materials } = useAllMaterials(canSeeMaterials)
  const locationOptions = useLocationOptions(context)
  const reverse = useMutation(trpc.purchase.reverse.mutationOptions())
  const correct = useMutation(trpc.purchase.correct.mutationOptions())
  const post = useMutation(trpc.purchase.post.mutationOptions())
  const discard = useMutation(trpc.purchase.discard.mutationOptions())
  const [confirm, setConfirm] = useState<'reverse' | 'correct' | 'finalize' | 'discard' | null>(
    null,
  )
  const [confirmError, setConfirmError] = useState<I18nKey | null>(null)
  const [busy, setBusy] = useState(false)
  const [sheet, setSheet] = useState<{ kind: PurchaseReturnKind; id?: string; key: string } | null>(
    null,
  )
  const [correctionId] = useState(() => newId())
  if (!context) return null

  const vatRegistered = context.capabilities.vat_registered === true
  const canManage = can(context, 'purchases.documents.manage')
  const canPost = can(context, 'purchases.documents.post')
  const canReverse = can(context, 'purchases.documents.reverse')
  // A credit note is checked against the prices paid: only for members who may see them (D-142).
  const canCredit = canManage && context.visibleCategories.includes('supplier_price')
  const listHref = `/b/${businessId}/purchases`
  const materialLines = purchase.lines.filter((line) => line.kind === 'material')
  const deliveryLines = purchase.lines.filter((line) => line.kind === 'delivery')
  const names = formatList(
    locale,
    [...new Set(materialLines.map((line) => line.description ?? ''))]
      .filter(Boolean)
      .map((name) => isolate(name)),
  )
  // The reversal's day (D-137): the purchase's own, or the first day after the closed books; a day
  // after today can't be (books closed up to today), so it waits for tomorrow or open books.
  const firstOpenDay =
    closedThrough && purchase.businessDate <= closedThrough ? nextDay(closedThrough) : null
  const reverseBlocked = firstOpenDay !== null && firstOpenDay > today
  const reversalDay = reverseBlocked ? null : firstOpenDay
  const location = locationOptions.locations.find((l) => l.id === purchase.locationId)
  const posted = purchase.status === 'posted'
  // A purchase is reversed (or corrected) only once its final returns and credit notes are (D-120).
  const finalReturns = purchase.returns.filter((r) => r.status === 'posted')
  const reversible = posted && finalReturns.length === 0
  const finalizeClosed =
    purchase.status === 'draft' ? closedFor(purchase.businessDate, today, closedThrough) : null
  // What the goods cost once final returns and credit notes took theirs off (null when hidden).
  const costAfterReturns =
    purchase.costTotal && finalReturns.length > 0 && finalReturns.every((r) => r.costTotal)
      ? subtractDecimals(purchase.costTotal, ...finalReturns.map((r) => r.costTotal!))
      : null

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.purchase.get.queryKey({ id: purchase.id }) }),
      queryClient.invalidateQueries({ queryKey: trpc.purchase.list.pathKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.material.costs.pathKey() }),
    ])
  }

  function errorKey(error: unknown): I18nKey {
    const code = apiErrorCode(error)
    if (code === 'conflict') return 'purchasing.editor.conflict'
    // Closed books refusing a reversal or a correction: say when it can be done (finalizing a
    // draft keeps the message about its date).
    if (code === 'books_closed' && confirm !== 'finalize') return 'purchasing.confirm.reverseClosed'
    return apiErrorKey(error)
  }

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setConfirmError(null)
    try {
      await action()
      setConfirm(null)
    } catch (error) {
      setConfirmError(errorKey(error))
    } finally {
      setBusy(false)
    }
  }

  const doReverse = () =>
    run(async () => {
      const reversed = await reverse.mutateAsync({ id: purchase.id })
      queryClient.setQueryData(trpc.purchase.get.queryKey({ id: purchase.id }), reversed)
      await refresh()
      toast.success(t('purchasing.confirm.reversed', { names }))
    })

  const doCorrect = () =>
    run(async () => {
      const copy = await correct.mutateAsync({ id: purchase.id, newId: correctionId })
      queryClient.setQueryData(trpc.purchase.get.queryKey({ id: copy.data.id }), copy)
      await refresh()
      toast.success(t('purchasing.confirm.corrected'))
      router.push(`${listHref}/${copy.data.id}`)
    })

  const doFinalize = () =>
    run(async () => {
      const posted = await post.mutateAsync({ id: purchase.id, version: purchase.version })
      queryClient.setQueryData(trpc.purchase.get.queryKey({ id: purchase.id }), posted)
      await refresh()
      toast.success(t('purchasing.confirm.finalized', { names }))
    })

  const doDiscard = () =>
    run(async () => {
      await discard.mutateAsync({ id: purchase.id, version: purchase.version })
      await refresh()
      toast.success(t('purchasing.confirm.discarded'))
      router.replace(listHref)
    })

  const title = t('purchasing.view.title', { date: businessDate(purchase.businessDate) })

  return (
    <PageContainer>
      <Link
        href={listHref}
        className="-ms-2 -mt-2 mb-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-primary hover:underline"
      >
        <ArrowLeftIcon aria-hidden className="size-4 rtl:rotate-180" />
        {t('common.nav.purchases')}
      </Link>
      <header className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
            <StatusBadge status={purchase.status} />
          </div>
          <p dir="auto" className="mt-1.5 text-muted-foreground">
            {purchase.supplierName ?? t('purchasing.noSupplier')}
            {purchase.reference ? ` · ${purchase.reference}` : null}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {posted && canManage ? (
            <>
              <Button
                variant="outline"
                onClick={() => setSheet({ kind: 'return', key: `new-${Date.now()}` })}
              >
                <PackageMinusIcon aria-hidden />
                {t('purchasing.view.return')}
              </Button>
              {canCredit ? (
                <Button
                  variant="outline"
                  onClick={() => setSheet({ kind: 'credit_note', key: `new-${Date.now()}` })}
                >
                  <HandCoinsIcon aria-hidden />
                  {t('purchasing.view.credit')}
                </Button>
              ) : null}
            </>
          ) : null}
          {reversible && canReverse && canManage ? (
            <Button
              variant="outline"
              onClick={() => {
                setConfirmError(null)
                setConfirm('correct')
              }}
            >
              <CopyIcon aria-hidden />
              {t('purchasing.view.correct')}
            </Button>
          ) : null}
          {reversible && canReverse ? (
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmError(null)
                setConfirm('reverse')
              }}
            >
              <Undo2Icon aria-hidden />
              {t('purchasing.view.reverse')}
            </Button>
          ) : null}
          {purchase.status === 'draft' && canManage ? (
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => {
                setConfirmError(null)
                setConfirm('discard')
              }}
            >
              <Trash2Icon aria-hidden />
              {t('purchasing.editor.discard')}
            </Button>
          ) : null}
          {purchase.status === 'draft' && canPost ? (
            <Button
              onClick={() => {
                setConfirmError(null)
                setConfirm('finalize')
              }}
            >
              <CheckCheckIcon aria-hidden />
              {t('purchasing.editor.finalize')}
            </Button>
          ) : null}
        </div>
      </header>

      <div className="space-y-5">
        {purchase.status === 'reversed' ? (
          <FormAlert tone="info">
            {t('purchasing.view.reversedNote', {
              date: businessDate(purchase.reversalDate ?? purchase.businessDate),
            })}
          </FormAlert>
        ) : purchase.status === 'draft' ? (
          <FormAlert tone="info">
            {result.meta.redacted.length > 0 && canManage
              ? t('purchasing.view.draftLocked')
              : t('purchasing.view.draftNote')}
          </FormAlert>
        ) : null}
        {purchase.copiedFromId ? (
          <FormAlert tone="info">
            {t('purchasing.editor.copiedFrom')}{' '}
            <Link
              href={`${listHref}/${purchase.copiedFromId}`}
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              {t('purchasing.editor.openOriginal')}
            </Link>
          </FormAlert>
        ) : null}
        {result.meta.redacted.length > 0 ? (
          <p className="text-sm text-muted-foreground">{t('common.locked.note')}</p>
        ) : null}

        <Panel title={t('purchasing.editor.details')}>
          <dl className="grid grid-cols-2 gap-4 lg:grid-cols-3">
            <Detail label={t('purchasing.editor.supplier')}>
              <bdi>{purchase.supplierName ?? t('purchasing.noSupplier')}</bdi>
            </Detail>
            <Detail label={t('purchasing.editor.date')}>
              {businessDate(purchase.businessDate)}
            </Detail>
            <Detail label={t('purchasing.editor.documentType')}>
              {t(`purchasing.documentTypes.${purchase.documentType}`)}
            </Detail>
            {purchase.reference ? (
              <Detail label={t('purchasing.editor.reference')}>
                <bdi>{purchase.reference}</bdi>
              </Detail>
            ) : null}
            {purchase.paymentMethod ? (
              <Detail label={t('purchasing.editor.payment')}>
                {t(`purchasing.paymentMethods.${purchase.paymentMethod}`)}
              </Detail>
            ) : null}
            {location && context.capabilities.multi_location ? (
              <Detail label={t('purchasing.editor.location')}>
                <bdi>{location.name}</bdi>
              </Detail>
            ) : null}
          </dl>
          {purchase.vatInCost !== null && vatRegistered ? (
            <p className="mt-4 text-sm text-muted-foreground">
              {purchase.vatInCost
                ? t('purchasing.view.vatInCost')
                : t('purchasing.view.vatOutOfCost')}
            </p>
          ) : null}
          {purchase.notes ? (
            <p dir="auto" className="mt-4 text-sm whitespace-pre-line">
              {purchase.notes}
            </p>
          ) : null}
        </Panel>

        <Panel title={t('purchasing.editor.items')}>
          <ul aria-label={t('purchasing.editor.items')} className="divide-y">
            {materialLines.map((line) => {
              const material = line.materialId ? materials.get(line.materialId) : undefined
              const costPerUnit =
                material && line.cost && line.baseQty && compareDecimal(line.baseQty, '0') > 0
                  ? pricePerCountingUnit(
                      material,
                      line.cost,
                      line.baseQty as Quantity,
                      BASE_UNITS[material.dimension],
                    )
                  : null
              return (
                <li key={line.id} data-purchase-line className="py-3 first:pt-0 last:pb-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p dir="auto" className="font-medium">
                        {line.description}
                      </p>
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        <LineQuantity line={line} material={material} />
                      </p>
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        {line.unitPrice === undefined ? (
                          <Locked category="supplier_price" />
                        ) : (
                          <>
                            <bdi className="tabular-nums">
                              {money(line.unitPrice, purchase.currency)}
                            </bdi>
                            {NBSP}
                            {t('purchasing.view.per', {
                              unit:
                                line.packName ?? (line.unit ? t(`units.short.${line.unit}`) : ''),
                            }).replaceAll(' ', NBSP)}
                          </>
                        )}
                        {line.discount ? (
                          <>
                            {' · '}
                            {'percent' in line.discount
                              ? t('purchasing.view.discountPercent', {
                                  percent: line.discount.percent,
                                })
                              : t('purchasing.view.discountAmount', {
                                  amount: money(line.discount.amount, purchase.currency),
                                })}
                          </>
                        ) : null}
                        {vatRegistered && compareDecimal(line.vatRate, '0') > 0 ? (
                          <>
                            {' · '}
                            {t('purchasing.editor.vatRate', { rate: line.vatRate })}
                          </>
                        ) : null}
                      </p>
                      {line.cost !== null ? (
                        <p className="mt-1 text-sm">
                          {t('purchasing.view.costOfGoods')}{' '}
                          {line.cost === undefined ? (
                            <Locked category="supplier_price" />
                          ) : (
                            <>
                              <bdi className="font-medium tabular-nums">
                                {money(line.cost, purchase.currency)}
                              </bdi>
                              {costPerUnit && material ? (
                                <span className="text-muted-foreground">
                                  {' · '}
                                  <bdi>
                                    {unitCost(costPerUnit, purchase.currency)}
                                    {NBSP}
                                    {t(`units.per.${material.unit}`).replaceAll(' ', NBSP)}
                                  </bdi>
                                </span>
                              ) : null}
                            </>
                          )}
                        </p>
                      ) : null}
                      {compareDecimal(line.returnedQty, '0') > 0 ||
                      (line.creditedAmount !== undefined &&
                        compareDecimal(line.creditedAmount, '0') > 0) ? (
                        <p className="mt-0.5 text-sm text-muted-foreground">
                          {compareDecimal(line.returnedQty, '0') > 0
                            ? t('purchasing.view.returned', {
                                qty: lineQuantity(line.returnedQty, line),
                              })
                            : null}
                          {compareDecimal(line.returnedQty, '0') > 0 &&
                          line.creditedAmount !== undefined &&
                          compareDecimal(line.creditedAmount, '0') > 0
                            ? ' · '
                            : null}
                          {line.creditedAmount !== undefined &&
                          compareDecimal(line.creditedAmount, '0') > 0
                            ? t('purchasing.view.credited', {
                                amount: money(line.creditedAmount, purchase.currency),
                              })
                            : null}
                        </p>
                      ) : null}
                    </div>
                    <p className="shrink-0 pt-0.5 text-end font-medium">
                      <Money
                        value={vatRegistered ? line.total : line.taxable}
                        currency={purchase.currency}
                      />
                      {vatRegistered && compareDecimal(line.vatRate, '0') > 0 ? (
                        <span className="block text-xs font-normal text-muted-foreground">
                          {t('purchasing.view.inclVat')}
                        </span>
                      ) : null}
                    </p>
                  </div>
                </li>
              )
            })}
            {deliveryLines.map((line) => (
              <li key={line.id} className="flex items-start justify-between gap-3 py-3 last:pb-0">
                <p className="flex min-w-0 items-center gap-2">
                  <TruckIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <span dir="auto">{line.description ?? t('purchasing.editor.delivery')}</span>
                </p>
                <p className="shrink-0 text-end font-medium">
                  <Money
                    value={vatRegistered ? line.total : line.taxable}
                    currency={purchase.currency}
                  />
                </p>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title={t('purchasing.totals.title')}>
          <Totals
            subtotal={purchase.subtotal}
            discount={purchase.discountTotal}
            vat={purchase.vatTotal}
            total={purchase.total}
            vatRegistered={vatRegistered}
            money={(amount) => money(amount, purchase.currency)}
          />
          {purchase.costTotal !== null && purchase.status !== 'draft' ? (
            <p className="mt-3 border-t pt-3 text-sm">
              {t('purchasing.view.costTotal')}{' '}
              <Money
                value={purchase.costTotal}
                currency={purchase.currency}
                className="font-medium"
              />
            </p>
          ) : null}
          {costAfterReturns !== null && posted ? (
            <p data-cost-after-returns className="mt-1 text-sm">
              {t('purchasing.view.costAfterReturns')}{' '}
              <Money
                value={costAfterReturns}
                currency={purchase.currency}
                className="font-medium"
              />
            </p>
          ) : null}
        </Panel>

        {purchase.status !== 'draft' ? (
          <Panel title={t('purchasing.returns.title')} hint={t('purchasing.returns.hint')}>
            {purchase.returns.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('purchasing.returns.none')}</p>
            ) : (
              <ul aria-label={t('purchasing.returns.title')} className="divide-y">
                {purchase.returns.map((document) => (
                  <li key={document.id}>
                    <button
                      type="button"
                      onClick={() =>
                        setSheet({ kind: document.kind, id: document.id, key: document.id })
                      }
                      className="flex w-full items-start justify-between gap-3 rounded-lg py-2.5 text-start outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring"
                    >
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-2 font-medium">
                          {t(`purchasing.returns.kind.${document.kind}`)}
                          <StatusBadge status={document.status} kind="document" />
                        </span>
                        <span className="block text-sm text-muted-foreground">
                          {businessDate(document.businessDate)}
                          {document.reference ? (
                            <>
                              {' · '}
                              <bdi>{document.reference}</bdi>
                            </>
                          ) : null}
                        </span>
                      </span>
                      <Money
                        value={document.total}
                        currency={purchase.currency}
                        className={cn(
                          'shrink-0 pt-0.5 font-medium',
                          document.status === 'reversed' && 'text-muted-foreground line-through',
                        )}
                      />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {posted && finalReturns.length > 0 && canReverse ? (
              <p className="mt-3 text-sm text-muted-foreground">
                {t('purchasing.returns.reverseFirst')}
              </p>
            ) : null}
          </Panel>
        ) : null}

        <Panel title={t('purchasing.receipts.title')} hint={t('purchasing.receipts.hint')}>
          <Receipts purchaseId={purchase.id} canManage={canManage} />
        </Panel>
      </div>

      <ConfirmDialog
        open={confirm === 'reverse'}
        icon={Undo2Icon}
        title={t('purchasing.confirm.reverseTitle')}
        body={t('purchasing.confirm.reverseBody', { names })}
        note={
          <>
            {t('purchasing.confirm.reverseNote')}
            {reversalDay ? (
              <> {t('purchasing.confirm.reverseDated', { date: businessDate(reversalDay) })}</>
            ) : null}
          </>
        }
        action={t('purchasing.view.reverse')}
        busyLabel={t('purchasing.confirm.reversing')}
        busy={busy}
        error={confirmError ?? (reverseBlocked ? 'purchasing.confirm.reverseClosed' : null)}
        disabled={reverseBlocked}
        destructive
        onConfirm={() => void doReverse()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'correct'}
        icon={CopyIcon}
        title={t('purchasing.confirm.correctTitle')}
        body={t('purchasing.confirm.correctBody', { names })}
        note={
          reversalDay
            ? t('purchasing.confirm.reverseDated', { date: businessDate(reversalDay) })
            : undefined
        }
        action={t('purchasing.confirm.correctAction')}
        busyLabel={t('purchasing.confirm.correcting')}
        busy={busy}
        error={confirmError ?? (reverseBlocked ? 'purchasing.confirm.reverseClosed' : null)}
        disabled={reverseBlocked}
        onConfirm={() => void doCorrect()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'finalize'}
        icon={CheckCheckIcon}
        title={t('purchasing.confirm.finalizeTitle')}
        body={t('purchasing.confirm.finalizeBody', { names })}
        note={t('purchasing.confirm.finalizeNote')}
        action={t('purchasing.confirm.finalizeAction')}
        busyLabel={t('purchasing.confirm.finalizing')}
        busy={busy}
        error={
          confirmError ??
          (finalizeClosed === 'today'
            ? 'purchasing.confirm.finalizeClosedToday'
            : finalizeClosed === 'earlier'
              ? 'errors.books_closed'
              : null)
        }
        disabled={finalizeClosed !== null}
        onConfirm={() => void doFinalize()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'discard'}
        icon={Trash2Icon}
        title={t('purchasing.confirm.discardTitle')}
        body={t('purchasing.confirm.discardBody')}
        action={t('purchasing.confirm.discardAction')}
        busyLabel={t('status.deleting')}
        busy={busy}
        error={confirmError}
        destructive
        onConfirm={() => void doDiscard()}
        onClose={() => setConfirm(null)}
      />
      {sheet ? (
        <ReturnSheet
          key={sheet.key}
          purchase={purchase}
          kind={sheet.kind}
          returnId={sheet.id}
          today={today}
          closedThrough={closedThrough}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </PageContainer>
  )
}
