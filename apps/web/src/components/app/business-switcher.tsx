'use client'

import { useMe } from '@bizcost/app-core'
import { isRoleTemplateKey } from '@bizcost/modules'
import { ChevronsUpDownIcon, PlusIcon, StoreIcon } from 'lucide-react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useTranslation } from 'react-i18next'
import { isolate } from '@/components/form/use-message'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { activeMemberships } from '@/features/business/memberships'

function roleKey(template: string | null) {
  return isRoleTemplateKey(template) ? (`roles.${template}` as const) : 'roles.custom'
}

/**
 * The business switcher in the header of a business page (`/b/[businessId]`): the user's businesses
 * from `me`; choosing one opens it, and "Create another business" starts Smart Setup.
 */
export function BusinessSwitcher() {
  const { t } = useTranslation()
  const router = useRouter()
  const { businessId } = useParams<{ businessId?: string }>()
  const { data: me } = useMe()
  if (!businessId || !me) return null
  const businesses = activeMemberships(me)
  const current = businesses.find((m) => m.businessId === businessId)
  if (!current) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className="h-11 max-w-full min-w-0 justify-start gap-2 rounded-xl bg-card ps-1.5 pe-2.5 lg:pointer-fine:h-10"
          aria-label={`${t('business.switch')}: ${isolate(current.legalName)}`}
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent text-primary">
            <StoreIcon aria-hidden className="size-4" />
          </span>
          <span dir="auto" className="min-w-0 truncate font-semibold">
            {current.legalName}
          </span>
          <ChevronsUpDownIcon aria-hidden className="size-4 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 max-w-[calc(100vw-2rem)]">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {t('home.businessesTitle')}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={current.businessId}
          onValueChange={(id) => {
            if (id !== current.businessId) router.push(`/b/${id}`)
          }}
        >
          {businesses.map((membership) => (
            <DropdownMenuRadioItem
              key={membership.businessId}
              value={membership.businessId}
              className="gap-3 py-2"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-primary">
                <StoreIcon aria-hidden className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span dir="auto" className="block truncate text-start font-medium">
                  {membership.legalName}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {t(roleKey(membership.roleTemplateKey))}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild className="gap-3 py-2">
          <Link href="/setup">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-dashed text-muted-foreground">
              <PlusIcon aria-hidden className="size-4" />
            </span>
            {t('business.create')}
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
