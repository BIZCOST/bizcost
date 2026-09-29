'use client'

import { useMe } from '@bizcost/app-core'
import { businessDisplayName } from '@bizcost/domain'
import { isRoleTemplateKey } from '@bizcost/modules'
import { ChevronsUpDownIcon, PlusIcon } from 'lucide-react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useTranslation } from 'react-i18next'
import { PersonName } from '@/components/app/avatar'
import { BusinessLogo } from '@/components/app/business-logo'
import { useConfirmLeave } from '@/components/form/unsaved-changes'
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
import { useLocale } from '@/lib/i18n/client'
import { cn } from '@/lib/utils'

function roleKey(template: string | null) {
  return isRoleTemplateKey(template) ? (`roles.${template}` as const) : 'roles.custom'
}

/**
 * The business switcher of a business page (`/b/[businessId]`): in the top bar on phones and tablets,
 * at the top of the sidebar from 1024px (`wide`). The user's businesses from `me`; choosing one
 * opens it, and "Create another business" starts Smart Setup. Each business shows its name for the
 * page's language (its Arabic name in Arabic, D-097) and its logo, or the store mark without one. A
 * name keeps its own direction but sits at the page's start (PersonName); the trigger truncates it
 * (the full name is its tooltip and accessible name), the menu shows it on up to two lines.
 */
export function BusinessSwitcher({
  wide = false,
  className,
}: {
  /** Fills the sidebar's width, with the role under the name. */
  wide?: boolean
  className?: string
}) {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const router = useRouter()
  const confirmLeave = useConfirmLeave()
  const { businessId } = useParams<{ businessId?: string }>()
  const { data: me } = useMe()
  if (!businessId || !me) return null
  const businesses = activeMemberships(me)
  const current = businesses.find((m) => m.businessId === businessId)
  if (!current) return null
  const name = businessDisplayName(current, locale)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className={cn(
            'max-w-full min-w-0 shrink justify-start gap-2 rounded-xl bg-card',
            wide
              ? 'h-14 w-full gap-3 ps-2 pe-3 lg:pointer-fine:h-14'
              : 'h-11 ps-1.5 pe-2.5 lg:pointer-fine:h-10',
            className,
          )}
          title={name}
          aria-label={`${t('business.switch')}: ${isolate(name)}`}
        >
          <BusinessLogo url={current.logoUrl} name={name} className={wide ? 'size-9' : 'size-7'} />
          {wide ? (
            <span className="min-w-0 flex-1 text-start">
              <PersonName className="font-semibold">{name}</PersonName>
              <span className="block truncate text-xs font-normal text-muted-foreground">
                {t(roleKey(current.roleTemplateKey))}
              </span>
            </span>
          ) : (
            <PersonName className="min-w-0 font-semibold">{name}</PersonName>
          )}
          <ChevronsUpDownIcon aria-hidden className="size-4 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        collisionPadding={12}
        className="w-80 max-w-[calc(100vw-2rem)]"
      >
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {t('home.businessesTitle')}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={current.businessId}
          onValueChange={(id) => {
            // Changes not saved on this page are asked about first.
            if (id !== current.businessId) {
              void confirmLeave().then((leave) => leave && router.push(`/b/${id}`))
            }
          }}
        >
          {businesses.map((membership) => {
            const shown = businessDisplayName(membership, locale)
            return (
              <DropdownMenuRadioItem
                key={membership.businessId}
                value={membership.businessId}
                className="gap-3 py-2"
              >
                <BusinessLogo url={membership.logoUrl} name={shown} className="size-8" />
                <span className="min-w-0 flex-1 text-start">
                  <span className="line-clamp-2 font-medium break-words">
                    <span dir="auto">{shown}</span>
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {t(roleKey(membership.roleTemplateKey))}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            )
          })}
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
