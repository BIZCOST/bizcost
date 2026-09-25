'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import {
  INVITATION_DAILY_LIMIT,
  invitationEmailInput,
  type BusinessContextDto,
  type InvitationDto,
  type RoleDto,
} from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import type { I18nKey, Locale } from '@bizcost/i18n'
import { formatDate } from '@bizcost/i18n'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MailIcon, RotateCwIcon, SendIcon, XIcon } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { EmailText } from '@/components/form/email-text'
import { FormAlert } from '@/components/form/form-alert'
import { TextField } from '@/components/form/text-field'
import { isolate } from '@/components/form/use-message'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useLocale } from '@/lib/i18n/client'
import { LanguageChoice } from './language-settings'
import { LoadError } from './query-state'
import { canGrantRole } from './role-labels'
import { RolePicker, useRoleName } from './role-picker'
import { can } from './sections'

// Settings → Team, invitations (ROADMAP.md Step 6): invite by email with a role and the email's
// language, then send again or cancel while it waits. The API emails the link, limits sending (20 a
// day per business, 3 resends each, 4 emails a day per address) and never invites to the Owner role.

/** Where an invitation error is shown: under the email, or above the form. */
function inviteError(error: unknown): { field: boolean; key: I18nKey } {
  const code = apiErrorCode(error)
  if (code === 'already_member') return { field: true, key: 'settings.invite.alreadyMember' }
  if (code === 'already_invited') return { field: true, key: 'settings.invite.alreadyInvited' }
  if (code === 'rate_limited') return { field: false, key: 'settings.invite.dailyLimit' }
  return { field: false, key: apiErrorKey(error) }
}

/** The role new people get by default: Employee (the least access), else the first one allowed. */
function defaultRoleId(
  roles: readonly RoleDto[],
  access: Pick<BusinessContextDto, 'permissions'>,
): string | null {
  const allowed = roles.filter((role) => canGrantRole(access, role))
  return (allowed.find((role) => role.templateKey === 'employee') ?? allowed[0])?.id ?? null
}

export function InviteDialog({
  open,
  onOpenChange,
  roles,
  access,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  roles: readonly RoleDto[]
  access: BusinessContextDto
}) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { locale: pageLocale } = useLocale()
  const ids = useId()
  // The business's language when this member may read it; else the page's.
  const profile = useQuery({
    ...trpc.business.profile.queryOptions(),
    enabled: can(access, 'settings.business.view'),
  })
  const create = useMutation(trpc.invitation.create.mutationOptions())
  const [invitationId, setInvitationId] = useState(newId)
  const [email, setEmail] = useState('')
  const [roleId, setRoleId] = useState<string | null>(() => defaultRoleId(roles, access))
  const [locale, setLocale] = useState<Locale | null>(null)
  const [emailError, setEmailError] = useState<I18nKey | null>(null)
  const [formError, setFormError] = useState<I18nKey | null>(null)
  const emailInput = useRef<HTMLInputElement>(null)
  const formAlert = useRef<HTMLDivElement>(null)
  const emailLocale = locale ?? profile.data?.defaultLocale ?? pageLocale
  const busy = create.isPending

  // The dialog scrolls on phones: an error is brought into view (the email field gets the focus).
  function showEmailError(key: I18nKey) {
    setEmailError(key)
    emailInput.current?.focus()
  }
  function showFormError(key: I18nKey) {
    setFormError(key)
    requestAnimationFrame(() => formAlert.current?.scrollIntoView({ block: 'nearest' }))
  }

  async function submit() {
    setEmailError(null)
    setFormError(null)
    const parsed = invitationEmailInput.safeParse(email)
    if (!parsed.success) {
      showEmailError(
        email.trim() === '' ? 'settings.invite.emailRequired' : 'settings.invite.emailInvalid',
      )
      return
    }
    if (!roleId) {
      showFormError('settings.invite.roleRequired')
      return
    }
    try {
      await create.mutateAsync({
        id: invitationId,
        email: parsed.data,
        roleId,
        locale: emailLocale,
      })
      toast.success(<EmailText i18nKey="settings.invite.sent" email={parsed.data} />)
      await queryClient.invalidateQueries({ queryKey: trpc.invitation.list.queryKey() })
      onOpenChange(false)
    } catch (error) {
      // The server answered, so no invitation waits under this id (refused, or cancelled because
      // its email could not be sent): the next try is a new invitation. Without an answer the id is
      // kept, so a retry cannot invite twice.
      if (apiErrorCode(error) !== undefined) setInvitationId(newId())
      const shown = inviteError(error)
      if (shown.field) showEmailError(shown.key)
      else showFormError(shown.key)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent closeLabel={t('actions.close')}>
        <DialogHeader>
          <DialogTitle>{t('settings.invite.title')}</DialogTitle>
          <DialogDescription>{t('settings.invite.description')}</DialogDescription>
        </DialogHeader>
        <form
          method="post"
          noValidate
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <TextField
            ref={emailInput}
            label={t('settings.invite.email')}
            type="email"
            dir="ltr"
            inputMode="email"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={t('auth.fields.emailPlaceholder')}
            autoFocus
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={busy}
            error={emailError ? t(emailError) : undefined}
          />
          <RolePicker
            name={`${ids}-role`}
            legend={t('settings.invite.role')}
            roles={roles}
            access={access}
            value={roleId}
            onChange={setRoleId}
            disabled={busy}
          />
          <LanguageChoice
            name={`${ids}-locale`}
            legend={t('settings.invite.language')}
            showLegend
            value={emailLocale}
            onChange={setLocale}
            disabled={busy}
          />
          {formError ? (
            <div ref={formAlert}>
              <FormAlert tone="error">{t(formError, { count: INVITATION_DAILY_LIMIT })}</FormAlert>
            </div>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              {t('actions.cancel')}
            </Button>
            <Button type="submit" disabled={busy}>
              <SendIcon aria-hidden className="rtl:-scale-x-100" />
              {busy ? t('status.sending') : t('settings.invite.send')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function InvitationRow({
  invitation,
  canManage,
  onRevoke,
}: {
  invitation: InvitationDto
  canManage: boolean
  onRevoke: (invitation: InvitationDto) => void
}) {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const roleName = useRoleName()
  const resend = useMutation(trpc.invitation.resend.mutationOptions())
  const expired = invitation.status === 'expired'
  const date = (value: string) => formatDate(locale, value, { dateStyle: 'medium' })

  async function sendAgain() {
    try {
      const saved = await resend.mutateAsync({ id: invitation.id })
      toast.success(<EmailText i18nKey="settings.invitations.resent" email={saved.email} />)
    } catch (error) {
      toast.error(
        apiErrorCode(error) === 'rate_limited'
          ? t('settings.invitations.noResendsLeft')
          : t(apiErrorKey(error)),
      )
    } finally {
      await queryClient.invalidateQueries({ queryKey: trpc.invitation.list.queryKey() })
    }
  }

  return (
    <li
      className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:px-5"
      data-invitation={invitation.email}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <MailIcon aria-hidden className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span dir="ltr" className="min-w-0 truncate font-medium rtl:text-end">
              {invitation.email}
            </span>
            {expired ? (
              <Badge tone="warning">{t('settings.invitations.expired')}</Badge>
            ) : (
              <Badge tone="primary">{t('settings.invitations.pending')}</Badge>
            )}
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            <span dir="auto">
              {roleName({ templateKey: invitation.roleTemplateKey, name: invitation.roleName })}
            </span>
            <span aria-hidden> · </span>
            {expired
              ? t('settings.invitations.expiredOn', { date: date(invitation.expiresAt) })
              : t('settings.invitations.expiresOn', { date: date(invitation.expiresAt) })}
          </p>
          {invitation.invitedBy ? (
            <p className="text-sm text-muted-foreground">
              {t('settings.invitations.invitedBy', { name: isolate(invitation.invitedBy) })}
            </p>
          ) : null}
        </div>
      </div>
      {canManage ? (
        <div className="flex flex-wrap gap-2 ps-13 sm:ps-0">
          <Button
            variant="outline"
            size="sm"
            className="h-11 lg:pointer-fine:h-9"
            disabled={resend.isPending || invitation.resendsLeft === 0}
            title={
              invitation.resendsLeft === 0 ? t('settings.invitations.noResendsLeft') : undefined
            }
            onClick={() => void sendAgain()}
          >
            <RotateCwIcon aria-hidden />
            {resend.isPending ? t('status.sending') : t('settings.invitations.resend')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-11 text-destructive hover:bg-destructive/5 hover:text-destructive lg:pointer-fine:h-9"
            onClick={() => onRevoke(invitation)}
          >
            <XIcon aria-hidden />
            {t('settings.invitations.revoke')}
          </Button>
        </div>
      ) : null}
    </li>
  )
}

export function InvitationsCard({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const list = useQuery(trpc.invitation.list.queryOptions())
  const revoke = useMutation(trpc.invitation.revoke.mutationOptions())
  const [revoking, setRevoking] = useState<InvitationDto | null>(null)
  const [revokeError, setRevokeError] = useState<I18nKey | null>(null)

  async function confirmRevoke() {
    if (!revoking) return
    setRevokeError(null)
    try {
      await revoke.mutateAsync({ id: revoking.id })
      toast.success(<EmailText i18nKey="settings.invitations.revoked" email={revoking.email} />)
      setRevoking(null)
    } catch (error) {
      setRevokeError(apiErrorKey(error))
    } finally {
      await queryClient.invalidateQueries({ queryKey: trpc.invitation.list.queryKey() })
    }
  }

  return (
    <section
      aria-labelledby="invitations-title"
      className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/[0.06]"
    >
      <div className="border-b px-4 py-4 sm:px-5">
        <h2 id="invitations-title" className="text-base font-semibold">
          {t('settings.invitations.title')}
        </h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {t('settings.invitations.description')}
        </p>
      </div>
      {list.isPending ? (
        <p className="px-5 py-6 text-sm text-muted-foreground">{t('status.loading')}</p>
      ) : list.isError ? (
        <div className="p-4">
          <LoadError error={list.error} onRetry={() => void list.refetch()} />
        </div>
      ) : list.data.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted-foreground">{t('settings.invitations.empty')}</p>
      ) : (
        <ul aria-labelledby="invitations-title" className="divide-y">
          {list.data.map((invitation) => (
            <InvitationRow
              key={invitation.id}
              invitation={invitation}
              canManage={canManage}
              onRevoke={(value) => {
                setRevokeError(null)
                setRevoking(value)
              }}
            />
          ))}
        </ul>
      )}
      <AlertDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && !revoke.isPending && setRevoking(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10 text-destructive">
              <XIcon />
            </AlertDialogMedia>
            <AlertDialogTitle>{t('settings.invitations.revokeTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              <EmailText i18nKey="settings.invitations.revokeBody" email={revoking?.email ?? ''} />
            </AlertDialogDescription>
          </AlertDialogHeader>
          {revokeError ? <FormAlert tone="error">{t(revokeError)}</FormAlert> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoke.isPending}>{t('actions.keep')}</AlertDialogCancel>
            <Button
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={revoke.isPending}
              onClick={() => void confirmRevoke()}
            >
              {revoke.isPending ? t('status.cancelling') : t('settings.invitations.revoke')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
