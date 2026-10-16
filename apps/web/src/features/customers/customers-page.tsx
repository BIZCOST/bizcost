'use client'

import { useTRPC } from '@bizcost/app-core'
import type { CustomerDto } from '@bizcost/contracts'
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { Building2Icon, LandmarkIcon, UserRoundIcon, UsersRoundIcon } from 'lucide-react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { Fragment, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ModuleGate } from '@/components/shell/module-gate'
import { PageContainer } from '@/components/shell/page-container'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  isNothingInUse,
  ListBody,
  ListEmpty,
  ListHeader,
  ListToolbar,
  useFirstTime,
  useListParams,
} from '@/features/catalog/catalog-list'
import { hasModule } from '@/features/purchasing/data'
import { useTerminology } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import { CustomerSheet } from './customer-sheet'
import { mayAddCustomers } from './data'

// Customers (M3 Step 5; Q2, D-263): the business's customers, a list of their own (apart from
// suppliers), by name; names may repeat, so each shows its phone. The search finds part of a name or
// of a phone number (from 3 digits); archived customers show on request. Each opens its page (orders,
// sales, payments and what they still owe). customers.items.view sees it; .manage adds customers.

/** A person, a business or a government body: its icon. */
export const KIND_ICONS = {
  individual: UserRoundIcon,
  business: Building2Icon,
  government: LandmarkIcon,
} as const

/** A customer's contact details in the list, each in its own direction. */
export function CustomerDetails({ customer }: { customer: CustomerDto }) {
  const { t } = useTranslation()
  const parts: ReactNode[] = []
  if (customer.kind !== 'individual') parts.push(t(`orders.customers.kinds.${customer.kind}`))
  if (customer.phone) parts.push(<bdi dir="ltr">{customer.phone}</bdi>)
  if (customer.email) parts.push(<bdi dir="ltr">{customer.email}</bdi>)
  if (parts.length === 0) return t('orders.customers.noDetails')
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

function CustomerRow({ customer, href }: { customer: CustomerDto; href: string }) {
  const { t } = useTranslation()
  const archived = customer.archivedAt !== null
  const Icon = KIND_ICONS[customer.kind]
  return (
    <Link
      href={href}
      data-customer-row
      className="flex items-start gap-3 px-4 py-3.5 transition-colors outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-inset sm:px-5"
    >
      <span
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-xl',
          archived ? 'bg-muted text-muted-foreground' : 'bg-accent text-primary',
        )}
      >
        <Icon aria-hidden className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span dir="auto" className="min-w-0 font-medium break-words">
            {customer.name}
          </span>
          {archived ? <Badge>{t('catalog.list.archivedBadge')}</Badge> : null}
        </span>
        <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">
          <CustomerDetails customer={customer} />
        </span>
      </span>
    </Link>
  )
}

function CustomersList({ startNew }: { startNew: boolean }) {
  const { t } = useTranslation()
  const router = useRouter()
  const term = useTerminology()
  const trpc = useTRPC()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const { search, status, set } = useListParams()
  const list = useInfiniteQuery(
    trpc.customer.list.infiniteQueryOptions(
      { search: search || undefined, status },
      { getNextPageParam: (page) => page.nextCursor, placeholderData: keepPreviousData },
    ),
  )
  const nothingInUse = isNothingInUse(list, search, status)
  const everything = useQuery({
    ...trpc.customer.list.queryOptions({ status: 'all', limit: 1 }),
    enabled: nothingInUse,
  })
  const firstTime = useFirstTime(
    list,
    nothingInUse,
    everything.isFetching ? undefined : everything.data,
  )
  // The "+" action's address (customers/new) opens the list with a new customer's form.
  const [adding, setAdding] = useState<string | null>(() => (startNew ? 'new-from-address' : null))
  if (!context) return null
  const canAdd = mayAddCustomers(context)
  const profile = context.terminologyProfile
  const base = `/b/${businessId}/customers`
  const add = () => setAdding(`new-${Date.now()}`)
  const title = t('common.nav.customers')
  return (
    <PageContainer>
      <ListHeader
        title={title}
        intro={term('orders.customers.intro', profile)}
        addLabel={canAdd && !firstTime ? t('orders.customers.add') : null}
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
            icon={UsersRoundIcon}
            title={t('orders.customers.empty.title')}
            body={
              canAdd
                ? hasModule(context, 'orders')
                  ? term('orders.customers.empty.body', profile)
                  : t('orders.customers.empty.bodySales')
                : t('orders.customers.empty.viewer')
            }
          >
            {canAdd ? (
              <Button size="lg" onClick={add}>
                {t('orders.customers.add')}
              </Button>
            ) : null}
          </ListEmpty>
        }
        renderRow={(customer: CustomerDto) => (
          <CustomerRow customer={customer} href={`${base}/${customer.id}`} />
        )}
      />
      {adding && canAdd ? (
        <CustomerSheet
          key={adding}
          onClose={() => {
            setAdding(null)
            // Opened from customers/new: the list's own address once the form is closed.
            if (startNew) router.replace(base)
          }}
        />
      ) : null}
    </PageContainer>
  )
}

/**
 * The Customers page: the list inside the module's gate (turned off, or not open to the member).
 * `startNew`: opened at customers/new (the "+" action "New customer"), with a new customer's form
 * open; for a member who may not add customers it is the list.
 */
export function CustomersPage({ startNew = false }: { startNew?: boolean }) {
  return (
    <ModuleGate moduleId="customers" entryId="customers">
      <CustomersList startNew={startNew} />
    </ModuleGate>
  )
}
