'use client'

import { apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { BusinessContextDto, ProductDto } from '@bizcost/contracts'
import type { TerminologyProfile } from '@bizcost/domain'
import { formatCurrency, type I18nKey } from '@bizcost/i18n'
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  BriefcaseIcon,
  CalculatorIcon,
  ChevronRightIcon,
  CookingPotIcon,
  ListChecksIcon,
  PackageCheckIcon,
  TagIcon,
} from 'lucide-react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { Fragment, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { isolate } from '@/components/form/use-message'
import { ModuleGate } from '@/components/shell/module-gate'
import { moduleAccess } from '@/components/shell/nav'
import { PageContainer } from '@/components/shell/page-container'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { hasModule } from '@/features/purchasing/data'
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
import { ProductCostLine, useProductCosts } from './product-cost'
import { ProductSheet } from './product-sheet'
import { RecipeSheet } from './recipe-sheet'
import { NBSP } from './units'

// Products & Services (M2 Step 2; ROADMAP.md Step 2, D-121, D-123): what the business sells, with
// its usual price in the business currency. VAT shows only for a VAT-registered business, and where
// it is sold only for a business with branches. Everyone with products.items.view sees the list;
// products.items.manage adds, edits and archives.
//
// M2 Step 4 (D-115, D-117): members who may see what goes into each product (products.recipes.view
// with materials.items.view, and Materials on) also see its material cost on its row and open its recipe ("Materials used";
// "Recipe" for food) from there: under the price, or columns of the row from 1280 px. An item
// bought ready to sell is tagged so, costs what it is bought for, and has no recipe.
//
// M2 Step 6: a way to Product costs (what each one really costs and earns), for members who may
// open it.

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

/** The button under a row that opens what goes into it. */
function RecipeButton({ profile, onOpen }: { profile: TerminologyProfile; onOpen: () => void }) {
  const term = useTerminology()
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onOpen}
      data-recipe-open
      className="h-9 gap-1.5 rounded-full px-3"
    >
      {profile === 'food' ? <CookingPotIcon aria-hidden /> : <ListChecksIcon aria-hidden />}
      {term('catalog.recipes.title', profile)}
      <ChevronRightIcon aria-hidden className="text-muted-foreground rtl:-scale-x-100" />
    </Button>
  )
}

function ProductsList({ startNew }: { startNew: boolean }) {
  const { t } = useTranslation()
  const term = useTerminology()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data: context } = useBusinessContext()
  const { businessId } = useParams<{ businessId: string }>()
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
  // What goes into each product, and its material cost: members who may see recipes (and so the
  // materials they name, D-155).
  const withRecipes =
    context !== undefined &&
    hasModule(context, 'materials') &&
    can(context, 'materials.items.view') &&
    can(context, 'products.recipes.view')
  const costs = useProductCosts(list.data?.pages ?? [], withRecipes)
  const archive = useMutation(trpc.product.archive.mutationOptions())
  const unarchive = useMutation(trpc.product.unarchive.mutationOptions())
  const router = useRouter()
  // The "+" action's address (products/new, D-189) opens the list with a new item's form.
  const [editing, setEditing] = useState<Editing | null>(() =>
    startNew ? { key: 'new-from-address' } : null,
  )
  const [recipeOf, setRecipeOf] = useState<ProductDto | null>(null)
  const [archiving, setArchiving] = useState<ProductDto | null>(null)
  const [archiveError, setArchiveError] = useState<I18nKey | null>(null)
  if (!context) return null
  const profile = context.terminologyProfile
  const canManage = can(context, 'products.items.manage')
  // Only for a member who may add them (the API refuses the others too).
  const shownEditing = editing && (editing.product || canManage) ? editing : null
  // A new product can be bought ready to sell while the member may add materials too (D-117).
  const resale =
    hasModule(context, 'materials') && can(context, 'materials.items.manage') ? 'offered' : 'none'
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.product.list.pathKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.product.costs.pathKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.productCost.pathKey() }),
    ])
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
  // What each one really costs and earns (Product costs, M2 Step 6), for members who may open it.
  const seeCosts =
    moduleAccess(context.modules, 'cost_engine', 'product_costs') === 'open' ? (
      <Button asChild variant="outline" size="lg">
        <Link href={`/b/${businessId}/product-costs`}>
          <CalculatorIcon aria-hidden />
          {t('catalog.products.seeCosts')}
        </Link>
      </Button>
    ) : null
  return (
    <PageContainer>
      <ListHeader
        title={title}
        intro={t('catalog.products.intro')}
        addLabel={canManage && !firstTime ? term('catalog.products.add', profile) : null}
        onAdd={add}
        more={firstTime ? null : seeCosts}
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
            icon={
              product.type === 'service'
                ? BriefcaseIcon
                : product.resaleMaterialId
                  ? PackageCheckIcon
                  : TagIcon
            }
            name={product.name}
            archived={product.archivedAt !== null}
            badges={
              product.type === 'service' ? (
                <Badge tone="primary">{t('catalog.products.type.service')}</Badge>
              ) : product.resaleMaterialId ? (
                <Badge>{t('catalog.products.resale.badge')}</Badge>
              ) : null
            }
            details={<ProductDetails product={product} context={context} />}
            aside={
              withRecipes ? (
                <ProductCostLine cost={costs.get(product.id)} profile={profile} />
              ) : undefined
            }
            footer={
              withRecipes ? (
                product.resaleMaterialId === null ? (
                  <RecipeButton profile={profile} onOpen={() => setRecipeOf(product)} />
                ) : null
              ) : undefined
            }
            onEdit={canManage ? () => setEditing({ product, key: product.id }) : undefined}
            onArchive={() => {
              setArchiveError(null)
              setArchiving(product)
            }}
            onUnarchive={() => void bringBack(product)}
          />
        )}
      />
      {shownEditing ? (
        <ProductSheet
          key={shownEditing.key}
          product={shownEditing.product}
          profile={profile}
          resale={resale}
          onClose={() => {
            setEditing(null)
            // Opened from products/new: the list's own address once the form is closed.
            if (startNew) router.replace(`/b/${businessId}/products`)
          }}
        />
      ) : null}
      {recipeOf ? (
        <RecipeSheet
          key={recipeOf.id}
          product={recipeOf}
          profile={profile}
          onClose={() => setRecipeOf(null)}
        />
      ) : null}
      <ArchiveDialog
        name={archiving?.name ?? null}
        body={archiving?.resaleMaterialId ? t('catalog.list.archiveBodyPair') : undefined}
        busy={archive.isPending}
        error={archiveError}
        onConfirm={() => void confirmArchive()}
        onClose={() => setArchiving(null)}
      />
    </PageContainer>
  )
}

/**
 * The Products & Services page: the list inside the module's gate. `startNew`: opened at products/new
 * (the "+" action "New product or service", D-189), with a new item's form open.
 */
export function ProductsPage({ startNew = false }: { startNew?: boolean }) {
  return (
    <ModuleGate moduleId="products" entryId="products">
      <ProductsList startNew={startNew} />
    </ModuleGate>
  )
}
