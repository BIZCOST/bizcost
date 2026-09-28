'use client'

import { apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { BusinessContextDto, ProductDto } from '@bizcost/contracts'
import { formatCurrency, type I18nKey } from '@bizcost/i18n'
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { BriefcaseIcon, TagIcon } from 'lucide-react'
import { Fragment, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { isolate } from '@/components/form/use-message'
import { ModuleGate } from '@/components/shell/module-gate'
import { PageContainer } from '@/components/shell/page-container'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { can } from '@/features/settings/sections'
import { useLocale, useTerminology } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import {
  ArchiveDialog,
  isNothingInUse,
  ListBody,
  ListEmpty,
  ListHeader,
  ListRow,
  ListToolbar,
  useFirstTime,
  useListParams,
} from './catalog-list'
import { ProductSheet } from './product-sheet'
import { NBSP } from './units'

// Products & Services (M2 Step 2; ROADMAP.md Step 2, D-121, D-123): what the business sells, with
// its usual price in the business currency. VAT shows only for a VAT-registered business, and where
// it is sold only for a business with branches. Everyone with products.items.view sees the list;
// products.items.manage adds, edits and archives.

const VAT_SHORT = {
  zero_rated: 'catalog.products.vat.zeroShort',
  exempt: 'catalog.products.vat.exemptShort',
} as const satisfies Record<string, I18nKey>

/** A product's details in the list: its usual price per unit, VAT and branches. */
function ProductDetails({
  product,
  context,
}: {
  product: ProductDto
  context: BusinessContextDto
}) {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const parts: ReactNode[] = []
  if (product.defaultPrice !== null) {
    parts.push(
      <>
        <bdi className="font-medium text-foreground tabular-nums">
          {formatCurrency(locale, product.defaultPrice, context.currency)}
        </bdi>{' '}
        {t(`units.per.${product.unit}`)}
      </>,
    )
  } else parts.push(t('catalog.products.noPrice'))
  // "incl. VAT" or "excl. VAT" says something only about a price.
  if (
    context.capabilities.vat_registered &&
    (product.vatCategory !== 'standard' || product.defaultPrice !== null)
  ) {
    parts.push(
      product.vatCategory === 'standard'
        ? t(
            product.priceIncludesVat
              ? 'catalog.products.vat.inclShort'
              : 'catalog.products.vat.exclShort',
          )
        : t(VAT_SHORT[product.vatCategory]),
    )
  }
  if (context.capabilities.multi_location && product.locationIds.length > 0) {
    parts.push(t('catalog.products.locations.branches', { count: product.locationIds.length }))
  }
  // A line breaks only after a " ·": each part stays whole ("excl. VAT", "AED 18.50 per piece").
  return parts.map((part, index) => (
    <Fragment key={index}>
      {index > 0 ? `${NBSP}· ` : null}
      <span className="whitespace-nowrap">{part}</span>
    </Fragment>
  ))
}

type Editing = { product?: ProductDto; key: string }

function ProductsList() {
  const { t } = useTranslation()
  const term = useTerminology()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data: context } = useBusinessContext()
  const { search, status, set } = useListParams()
  const list = useInfiniteQuery(
    trpc.product.list.infiniteQueryOptions(
      { search: search || undefined, status },
      { getNextPageParam: (page) => page.nextCursor, placeholderData: keepPreviousData },
    ),
  )
  // Nothing in use: does the business have any at all? (The first-time page, D-132.)
  const nothingInUse = isNothingInUse(list, search, status)
  const everything = useQuery({
    ...trpc.product.list.queryOptions({ status: 'all', limit: 1 }),
    enabled: nothingInUse,
  })
  const firstTime = useFirstTime(
    list,
    nothingInUse,
    everything.isFetching ? undefined : everything.data,
  )
  const archive = useMutation(trpc.product.archive.mutationOptions())
  const unarchive = useMutation(trpc.product.unarchive.mutationOptions())
  const [editing, setEditing] = useState<Editing | null>(null)
  const [archiving, setArchiving] = useState<ProductDto | null>(null)
  const [archiveError, setArchiveError] = useState<I18nKey | null>(null)
  if (!context) return null
  const profile = context.terminologyProfile
  const canManage = can(context, 'products.items.manage')
  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.product.list.pathKey() })
  const add = () => setEditing({ key: `new-${Date.now()}` })

  async function confirmArchive() {
    if (!archiving) return
    setArchiveError(null)
    try {
      await archive.mutateAsync({ id: archiving.id })
      toast.success(t('catalog.list.archived', { name: isolate(archiving.name) }))
      setArchiving(null)
    } catch (error) {
      setArchiveError(apiErrorKey(error))
    } finally {
      await refresh()
    }
  }

  async function bringBack(product: ProductDto) {
    try {
      await unarchive.mutateAsync({ id: product.id })
      toast.success(t('catalog.list.unarchived', { name: isolate(product.name) }))
    } catch (error) {
      toast.error(t(apiErrorKey(error)))
    } finally {
      await refresh()
    }
  }

  const title = term('common.nav.products', profile)
  return (
    <PageContainer>
      <ListHeader
        title={title}
        intro={t('catalog.products.intro')}
        addLabel={canManage && !firstTime ? term('catalog.products.add', profile) : null}
        onAdd={add}
      />
      {firstTime ? null : <ListToolbar search={search} status={status} onChange={set} />}
      <ListBody
        query={list}
        search={search}
        status={status}
        label={title}
        firstTime={
          <ListEmpty
            icon={TagIcon}
            title={term('catalog.products.empty.title', profile)}
            body={canManage ? t('catalog.products.empty.body') : t('catalog.products.empty.viewer')}
          >
            {canManage ? (
              <Button size="lg" onClick={add}>
                {term('catalog.products.add', profile)}
              </Button>
            ) : null}
          </ListEmpty>
        }
        renderRow={(product: ProductDto) => (
          <ListRow
            icon={product.type === 'service' ? BriefcaseIcon : TagIcon}
            name={product.name}
            archived={product.archivedAt !== null}
            badges={
              product.type === 'service' ? (
                <Badge tone="primary">{t('catalog.products.type.service')}</Badge>
              ) : null
            }
            details={<ProductDetails product={product} context={context} />}
            onEdit={canManage ? () => setEditing({ product, key: product.id }) : undefined}
            onArchive={() => {
              setArchiveError(null)
              setArchiving(product)
            }}
            onUnarchive={() => void bringBack(product)}
          />
        )}
      />
      {editing ? (
        <ProductSheet
          key={editing.key}
          product={editing.product}
          profile={profile}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <ArchiveDialog
        name={archiving?.name ?? null}
        busy={archive.isPending}
        error={archiveError}
        onConfirm={() => void confirmArchive()}
        onClose={() => setArchiving(null)}
      />
    </PageContainer>
  )
}

/** The Products & Services page: the list inside the module's gate. */
export function ProductsPage() {
  return (
    <ModuleGate moduleId="products" entryId="products">
      <ProductsList />
    </ModuleGate>
  )
}
