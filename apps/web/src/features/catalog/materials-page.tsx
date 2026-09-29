'use client'

import { apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { MaterialCostDto, MaterialDto } from '@bizcost/contracts'
import type { I18nKey } from '@bizcost/i18n'
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { PackageCheckIcon, PackageIcon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { isolate } from '@/components/form/use-message'
import { ModuleGate } from '@/components/shell/module-gate'
import { PageContainer } from '@/components/shell/page-container'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { hasModule } from '@/features/purchasing/data'
import { can } from '@/features/settings/sections'
import { useTerminology } from '@/lib/i18n/client'
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
import { MaterialCostDetails, useMaterialCosts } from './material-cost'
import { MaterialSheet } from './material-sheet'
import { ProductSheet } from './product-sheet'
import { PackChainText, useUnitQuantity } from './unit-parts'
import { materialUnits, outerPacks, packChain } from './units'

// Materials (M2 Step 2; ROADMAP.md Step 2, D-118, D-122, D-123): what the business buys to make or
// sell, in its wording ("Ingredients & supplies" for food, "Raw materials" for a factory, "Goods"
// for a shop, D-117). Everyone with materials.items.view sees the list; materials.items.manage adds,
// edits and archives.
//
// Items bought ready to sell (M2 Step 4, D-117) are tagged "Sold as it is": they are one record with
// their product, so archiving says it leaves Products & Services too. A shop's Goods page adds an
// item to sell (the product form bought ready to sell, when the member may add products), and a
// supply it uses (the material form) as a second choice.

/**
 * A material's details in the list: its unit, each pack in words and, while the business uses
 * Purchases (M2 Step 3), its average cost and last purchase price.
 */
function MaterialDetails({
  material,
  cost,
}: {
  material: MaterialDto
  /** Absent while the costs load, or when the business doesn't use Purchases. */
  cost: MaterialCostDto | undefined
}) {
  const { t } = useTranslation()
  const unitQuantity = useUnitQuantity()
  const units = materialUnits(material.unit, material.packs, material.crossFactors)
  const chains = outerPacks(material.packs)
    .map((pack) => ({
      id: pack.id,
      steps: packChain(pack.id, material.packs, units, material.unit),
    }))
    .filter((chain) => chain.steps !== null)
  return (
    <>
      <span className="block">
        {t('catalog.materials.unitShort')}: <bdi>{t(`units.short.${material.unit}`)}</bdi>
      </span>
      {chains.map((chain) => (
        <span key={chain.id} className="block">
          <PackChainText steps={chain.steps!} />
        </span>
      ))}
      {material.crossFactors.map((cross) => (
        <span key={cross.id} className="block">
          <bdi>{unitQuantity('1', cross.unit)}</bdi> ={' '}
          <bdi>{unitQuantity(cross.qty, cross.ofUnit)}</bdi>
        </span>
      ))}
      <MaterialCostDetails material={material} cost={cost} />
    </>
  )
}

type Editing = { material?: MaterialDto; key: string; toSell?: boolean; used?: boolean }

function MaterialsList() {
  const { t } = useTranslation()
  const term = useTerminology()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data: context } = useBusinessContext()
  const { search, status, set } = useListParams()
  const list = useInfiniteQuery(
    trpc.material.list.infiniteQueryOptions(
      { search: search || undefined, status },
      { getNextPageParam: (page) => page.nextCursor, placeholderData: keepPreviousData },
    ),
  )
  // Nothing in use: does the business have any at all? (The first-time page, D-132.)
  const nothingInUse = isNothingInUse(list, search, status)
  const everything = useQuery({
    ...trpc.material.list.queryOptions({ status: 'all', limit: 1 }),
    enabled: nothingInUse,
  })
  const firstTime = useFirstTime(
    list,
    nothingInUse,
    everything.isFetching ? undefined : everything.data,
  )
  // Costs come from purchases: shown while the business uses Purchases, to a member who may see
  // costs or supplier prices. The others (an employee who reads recipes, D-179) get one note instead
  // of a lock on every row.
  const usesPurchases = context?.modules.some((module) => module.id === 'purchases') === true
  const seesAnyCost =
    context?.visibleCategories.some(
      (category) => category === 'cost' || category === 'supplier_price',
    ) === true
  const withCosts = usesPurchases && seesAnyCost
  const costs = useMaterialCosts(list.data?.pages ?? [], withCosts)
  const archive = useMutation(trpc.material.archive.mutationOptions())
  const unarchive = useMutation(trpc.material.unarchive.mutationOptions())
  const [editing, setEditing] = useState<Editing | null>(null)
  const [archiving, setArchiving] = useState<MaterialDto | null>(null)
  const [archiveError, setArchiveError] = useState<I18nKey | null>(null)
  if (!context) return null
  const profile = context.terminologyProfile
  const canManage = can(context, 'materials.items.manage')
  // An item sold as it is moves with its product (D-117): both lists follow.
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.material.list.pathKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.product.list.pathKey() }),
    ])
  // A shop adds goods to sell: the product form, bought ready to sell (D-117).
  const addsToSell =
    profile === 'retail' && hasModule(context, 'products') && can(context, 'products.items.manage')
  const add = () => setEditing({ key: `new-${Date.now()}`, toSell: addsToSell })
  const addUsed = () => setEditing({ key: `new-${Date.now()}`, used: true })

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

  async function bringBack(material: MaterialDto) {
    try {
      await unarchive.mutateAsync({ id: material.id })
      toast.success(t('catalog.list.unarchived', { name: isolate(material.name) }))
    } catch (error) {
      toast.error(t(apiErrorKey(error)))
    } finally {
      await refresh()
    }
  }

  const title = term('common.nav.materials', profile)
  return (
    <PageContainer>
      <ListHeader
        title={title}
        intro={term('catalog.materials.intro', profile)}
        addLabel={canManage && !firstTime ? term('catalog.materials.add', profile) : null}
        onAdd={add}
        more={
          canManage && !firstTime && addsToSell ? (
            <Button
              size="lg"
              variant="outline"
              onClick={addUsed}
              title={t('catalog.materials.addUsedHint')}
            >
              {t('catalog.materials.addUsed')}
            </Button>
          ) : null
        }
      />
      {usesPurchases && !seesAnyCost && !firstTime ? (
        <p data-costs-hidden className="-mt-3 mb-4 text-sm text-muted-foreground">
          {t('catalog.materials.costsHidden')}
        </p>
      ) : null}
      {firstTime ? null : <ListToolbar search={search} status={status} onChange={set} />}
      <ListBody
        query={list}
        search={search}
        status={status}
        label={title}
        firstTime={
          <ListEmpty
            icon={PackageIcon}
            title={term('catalog.materials.empty.title', profile)}
            body={
              canManage
                ? term('catalog.materials.empty.body', profile)
                : t('catalog.materials.empty.viewer')
            }
          >
            {canManage ? (
              <div className="flex flex-wrap justify-center gap-2">
                <Button size="lg" onClick={add}>
                  {term('catalog.materials.add', profile)}
                </Button>
                {addsToSell ? (
                  <Button size="lg" variant="outline" onClick={addUsed}>
                    {t('catalog.materials.addUsed')}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </ListEmpty>
        }
        renderRow={(material: MaterialDto) => (
          <ListRow
            icon={material.resaleProductId ? PackageCheckIcon : PackageIcon}
            name={material.name}
            archived={material.archivedAt !== null}
            badges={
              material.resaleProductId ? <Badge>{t('catalog.materials.soldAs')}</Badge> : null
            }
            details={<MaterialDetails material={material} cost={costs.get(material.id)} />}
            onEdit={canManage ? () => setEditing({ material, key: material.id }) : undefined}
            onArchive={() => {
              setArchiveError(null)
              setArchiving(material)
            }}
            onUnarchive={() => void bringBack(material)}
          />
        )}
      />
      {editing?.toSell ? (
        <ProductSheet
          key={editing.key}
          profile={profile}
          resale="only"
          onClose={() => setEditing(null)}
        />
      ) : editing ? (
        <MaterialSheet
          key={editing.key}
          material={editing.material}
          profile={profile}
          newTitle={editing.used ? t('catalog.materials.newSupply') : undefined}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <ArchiveDialog
        name={archiving?.name ?? null}
        body={archiving?.resaleProductId ? t('catalog.list.archiveBodyPair') : undefined}
        busy={archive.isPending}
        error={archiveError}
        onConfirm={() => void confirmArchive()}
        onClose={() => setArchiving(null)}
      />
    </PageContainer>
  )
}

/** The Materials page: the list inside the module's gate (turned off, or not open to the member). */
export function MaterialsPage() {
  return (
    <ModuleGate moduleId="materials" entryId="materials">
      <MaterialsList />
    </ModuleGate>
  )
}
