'use client'

import { apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { SupplierDto } from '@bizcost/contracts'
import type { I18nKey } from '@bizcost/i18n'
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { TruckIcon } from 'lucide-react'
import { Fragment, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { isolate } from '@/components/form/use-message'
import { ModuleGate } from '@/components/shell/module-gate'
import { PageContainer } from '@/components/shell/page-container'
import { Button } from '@/components/ui/button'
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
} from '@/features/catalog/catalog-list'
import { NBSP } from '@/features/catalog/units'
import { can } from '@/features/settings/sections'
import { useBusinessContext } from '@/lib/trpc/client'
import { SupplierSheet } from './supplier-sheet'

// Suppliers (M2 Step 3; D-112, D-133): who the business buys from, a list of its own (customers come
// with Phase 3). The list frame of the catalog (search and status in the address, archive, never
// delete). Everyone with suppliers.items.view sees it; suppliers.items.manage adds, edits and
// archives.

/** A supplier's contact details in the list, each in its own direction. */
function SupplierDetails({ supplier }: { supplier: SupplierDto }) {
  const { t } = useTranslation()
  const parts: ReactNode[] = []
  if (supplier.phone) parts.push(<bdi dir="ltr">{supplier.phone}</bdi>)
  if (supplier.email) parts.push(<bdi dir="ltr">{supplier.email}</bdi>)
  if (supplier.trn) {
    parts.push(
      <>
        {t('purchasing.suppliers.trnShort').replaceAll(' ', NBSP)}
        {NBSP}
        <bdi dir="ltr">{supplier.trn}</bdi>
      </>,
    )
  }
  if (parts.length === 0) return t('purchasing.suppliers.noDetails')
  return (
    <span className="break-words">
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? ' · ' : null}
          {part}
        </Fragment>
      ))}
    </span>
  )
}

type Editing = { supplier?: SupplierDto; key: string }

function SuppliersList() {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data: context } = useBusinessContext()
  const { search, status, set } = useListParams()
  const list = useInfiniteQuery(
    trpc.supplier.list.infiniteQueryOptions(
      { search: search || undefined, status },
      { getNextPageParam: (page) => page.nextCursor, placeholderData: keepPreviousData },
    ),
  )
  const nothingInUse = isNothingInUse(list, search, status)
  const everything = useQuery({
    ...trpc.supplier.list.queryOptions({ status: 'all', limit: 1 }),
    enabled: nothingInUse,
  })
  const firstTime = useFirstTime(
    list,
    nothingInUse,
    everything.isFetching ? undefined : everything.data,
  )
  const archive = useMutation(trpc.supplier.archive.mutationOptions())
  const unarchive = useMutation(trpc.supplier.unarchive.mutationOptions())
  const [editing, setEditing] = useState<Editing | null>(null)
  const [archiving, setArchiving] = useState<SupplierDto | null>(null)
  const [archiveError, setArchiveError] = useState<I18nKey | null>(null)
  if (!context) return null
  const canManage = can(context, 'suppliers.items.manage')
  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.supplier.list.pathKey() })
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

  async function bringBack(supplier: SupplierDto) {
    try {
      await unarchive.mutateAsync({ id: supplier.id })
      toast.success(t('catalog.list.unarchived', { name: isolate(supplier.name) }))
    } catch (error) {
      toast.error(t(apiErrorKey(error)))
    } finally {
      await refresh()
    }
  }

  const title = t('common.nav.suppliers')
  return (
    <PageContainer>
      <ListHeader
        title={title}
        intro={t('purchasing.suppliers.intro')}
        addLabel={canManage && !firstTime ? t('purchasing.suppliers.add') : null}
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
            icon={TruckIcon}
            title={t('purchasing.suppliers.empty.title')}
            body={
              canManage
                ? t('purchasing.suppliers.empty.body')
                : t('purchasing.suppliers.empty.viewer')
            }
          >
            {canManage ? (
              <Button size="lg" onClick={add}>
                {t('purchasing.suppliers.add')}
              </Button>
            ) : null}
          </ListEmpty>
        }
        renderRow={(supplier: SupplierDto) => (
          <ListRow
            icon={TruckIcon}
            name={supplier.name}
            archived={supplier.archivedAt !== null}
            details={<SupplierDetails supplier={supplier} />}
            onEdit={canManage ? () => setEditing({ supplier, key: supplier.id }) : undefined}
            onArchive={() => {
              setArchiveError(null)
              setArchiving(supplier)
            }}
            onUnarchive={() => void bringBack(supplier)}
          />
        )}
      />
      {editing ? (
        <SupplierSheet
          key={editing.key}
          supplier={editing.supplier}
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

/** The Suppliers page: the list inside the module's gate (turned off, or not open to the member). */
export function SuppliersPage() {
  return (
    <ModuleGate moduleId="suppliers" entryId="suppliers">
      <SuppliersList />
    </ModuleGate>
  )
}
