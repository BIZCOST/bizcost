'use client'

import { useMe, useTRPC } from '@bizcost/app-core'
import type { MemberDto } from '@bizcost/contracts'
import { OWNER_TEMPLATE_KEY } from '@bizcost/domain'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CrownIcon,
  EllipsisVerticalIcon,
  LogOutIcon,
  ShieldCheckIcon,
  UserPlusIcon,
  UserRoundXIcon,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Avatar, PersonName } from '@/components/app/avatar'
import { isolate } from '@/components/form/use-message'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useBusinessContext } from '@/lib/trpc/client'
import { InvitationsCard, InviteDialog } from './invitations'
import {
  ChangeRoleDialog,
  LeaveBusinessDialog,
  RemoveMemberDialog,
  TransferOwnershipDialog,
} from './member-dialogs'
import { LoadError, SectionSkeleton } from './query-state'
import { canGrantRole } from './role-labels'
import { useRoleName } from './role-picker'
import { can, isSectionVisible } from './sections'
import { SectionPage } from './settings-shell'

// Settings → Team (ROADMAP.md Step 6): the members and the invitations not accepted yet. Only for a
// business with a team (capability has_team). Seeing the team needs settings.members.view; inviting,
// changing roles and removing need settings.members.manage; only the owner transfers ownership; anyone
// but the owner may leave. The API applies every rule again, including "no one hands out more access
// than they have".

type Action =
  | { kind: 'role'; member: MemberDto }
  | { kind: 'remove'; member: MemberDto }
  | { kind: 'leave'; member: MemberDto }
  | { kind: 'transfer'; member: MemberDto }

function MemberRow({
  member,
  actions,
  onAction,
}: {
  member: MemberDto
  actions: readonly Action['kind'][]
  onAction: (action: Action) => void
}) {
  const { t } = useTranslation()
  const roleName = useRoleName()
  const role = roleName({ templateKey: member.roleTemplateKey, name: member.roleName })
  return (
    <li
      className="flex items-center gap-3 px-4 py-3.5 sm:px-5"
      data-member={member.email ?? member.displayName}
    >
      <Avatar name={member.displayName} className="size-10 text-sm" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <PersonName className="min-w-0 font-medium">{member.displayName}</PersonName>
          {member.isYou ? <Badge>{t('settings.members.you')}</Badge> : null}
          {member.status === 'suspended' ? (
            <Badge tone="warning">{t('settings.members.suspended')}</Badge>
          ) : null}
        </div>
        {member.email ? (
          <p dir="ltr" className="truncate text-sm text-muted-foreground rtl:text-end">
            {member.email}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">{t('settings.members.noLogin')}</p>
        )}
        <p className="mt-1 sm:hidden">
          <RoleBadge member={member} name={role} />
        </p>
      </div>
      <div className="hidden shrink-0 sm:block">
        <RoleBadge member={member} name={role} />
      </div>
      {actions.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('settings.members.actions', { name: isolate(member.displayName) })}
            >
              <EllipsisVerticalIcon aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            {actions.includes('role') ? (
              <DropdownMenuItem
                className="py-2"
                onSelect={() => onAction({ kind: 'role', member })}
              >
                <ShieldCheckIcon aria-hidden />
                {t('settings.members.changeRole')}
              </DropdownMenuItem>
            ) : null}
            {actions.includes('transfer') ? (
              <DropdownMenuItem
                className="py-2"
                onSelect={() => onAction({ kind: 'transfer', member })}
              >
                <CrownIcon aria-hidden />
                {t('settings.members.makeOwner')}
              </DropdownMenuItem>
            ) : null}
            {actions.includes('remove') || actions.includes('leave') ? (
              <>
                {actions.length > 1 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem
                  variant="destructive"
                  className="py-2"
                  onSelect={() =>
                    onAction({ kind: actions.includes('leave') ? 'leave' : 'remove', member })
                  }
                >
                  {actions.includes('leave') ? (
                    <LogOutIcon aria-hidden className="rtl:rotate-180" />
                  ) : (
                    <UserRoundXIcon aria-hidden />
                  )}
                  {actions.includes('leave')
                    ? t('settings.members.leave')
                    : t('settings.members.remove')}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        // Keeps the rows aligned when a row has no actions.
        <span aria-hidden className="hidden size-11 shrink-0 sm:block lg:pointer-fine:size-9" />
      )}
    </li>
  )
}

function RoleBadge({ member, name }: { member: MemberDto; name: string }) {
  return member.isOwner ? (
    <Badge tone="primary">
      <CrownIcon aria-hidden />
      <span dir="auto">{name}</span>
    </Badge>
  ) : (
    <Badge>
      <span dir="auto">{name}</span>
    </Badge>
  )
}

export function MembersSettings({ businessId }: { businessId: string }) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data: me } = useMe()
  const { data: context } = useBusinessContext()
  // Only once the section is open to this member (a typed link to it otherwise shows "not open to you").
  const visible = context ? isSectionVisible(context, 'members') : false
  const members = useQuery({ ...trpc.member.list.queryOptions(), enabled: visible })
  const roles = useQuery({ ...trpc.role.list.queryOptions(), enabled: visible })
  const [inviting, setInviting] = useState(false)
  const [action, setAction] = useState<Action | null>(null)
  const businessName = me?.memberships.find((m) => m.businessId === businessId)?.legalName ?? ''
  if (!context) return null
  const canManage = can(context, 'settings.members.manage')
  const isOwner = context.roleTemplateKey === OWNER_TEMPLATE_KEY

  function actionsFor(member: MemberDto): Action['kind'][] {
    if (member.isOwner || !context) return []
    // Anyone but the owner may leave.
    if (member.isYou) return ['leave']
    if (!canManage) return []
    const out: Action['kind'][] = []
    const roleAllowed = roles.data?.find((r) => r.id === member.roleId)
    // Nobody changes their own role; a role with more access than the caller's is left alone.
    const manageable = !roleAllowed || canGrantRole(context, roleAllowed)
    if (manageable) out.push('role')
    if (isOwner && member.kind === 'account' && member.status === 'active') out.push('transfer')
    if (manageable) out.push('remove')
    return out
  }

  const refreshTeam = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.member.list.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.role.list.queryKey() }),
    ])

  return (
    <SectionPage
      businessId={businessId}
      section="members"
      actions={
        canManage ? (
          <Button onClick={() => setInviting(true)} disabled={!roles.data}>
            <UserPlusIcon aria-hidden />
            {t('settings.members.invite')}
          </Button>
        ) : null
      }
    >
      {members.isPending ? (
        <SectionSkeleton cards={1} />
      ) : members.isError ? (
        <LoadError error={members.error} onRetry={() => void members.refetch()} />
      ) : (
        <section
          aria-labelledby="members-title"
          className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/[0.06]"
        >
          <div className="flex items-baseline justify-between gap-3 border-b px-4 py-4 sm:px-5">
            <h2 id="members-title" className="text-base font-semibold">
              {t('settings.members.listTitle')}
            </h2>
            <span className="text-sm text-muted-foreground tabular-nums">
              {t('settings.members.count', { count: members.data.length })}
            </span>
          </div>
          <ul aria-labelledby="members-title" className="divide-y">
            {members.data.map((member) => (
              <MemberRow
                key={member.id}
                member={member}
                actions={actionsFor(member)}
                onAction={setAction}
              />
            ))}
          </ul>
        </section>
      )}

      <InvitationsCard canManage={canManage} />

      {canManage ? (
        <p className="flex items-start gap-2.5 text-sm leading-relaxed text-muted-foreground">
          <ShieldCheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
          {t('setup.review.teamNote')}
        </p>
      ) : null}

      {inviting && roles.data ? (
        <InviteDialog open onOpenChange={setInviting} roles={roles.data} access={context} />
      ) : null}
      {action?.kind === 'role' && roles.data ? (
        <ChangeRoleDialog
          member={action.member}
          roles={roles.data}
          access={context}
          onClose={() => setAction(null)}
          onChanged={(member) => {
            setAction(null)
            void refreshTeam()
            toast.success(t('settings.members.roleChanged', { name: isolate(member.displayName) }))
          }}
        />
      ) : null}
      {action?.kind === 'remove' ? (
        <RemoveMemberDialog
          member={action.member}
          businessName={businessName}
          onClose={() => setAction(null)}
          onRemoved={() => {
            setAction(null)
            void refreshTeam()
            toast.success(
              t('settings.members.removed', { name: isolate(action.member.displayName) }),
            )
          }}
        />
      ) : null}
      {action?.kind === 'leave' ? (
        <LeaveBusinessDialog businessName={businessName} onClose={() => setAction(null)} />
      ) : null}
      {action?.kind === 'transfer' ? (
        <TransferOwnershipDialog
          member={action.member}
          businessName={businessName}
          onClose={() => setAction(null)}
          onTransferred={() => {
            setAction(null)
            // The caller is now an Admin: their own access changed too.
            void refreshTeam()
            void queryClient.invalidateQueries({ queryKey: trpc.business.context.queryKey() })
            void queryClient.invalidateQueries({ queryKey: trpc.me.queryKey() })
            toast.success(
              t('settings.members.transferred', { name: isolate(action.member.displayName) }),
            )
          }}
        />
      ) : null}
    </SectionPage>
  )
}
