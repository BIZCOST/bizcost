'use client'

import { apiErrorCode, apiErrorKey, createIdentityCheck, useFlow, useTRPC } from '@bizcost/app-core'
import type { BusinessContextDto, MemberDto, RoleDto } from '@bizcost/contracts'
import type { I18nKey } from '@bizcost/i18n'
import { useMutation } from '@tanstack/react-query'
import { CrownIcon, LogOutIcon, UserRoundXIcon } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CodeInput } from '@/components/form/code-input'
import { EmailText } from '@/components/form/email-text'
import { FormAlert } from '@/components/form/form-alert'
import { ResendCode } from '@/components/form/resend-code'
import { isolate, useMessage } from '@/components/form/use-message'
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
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { useSessionEmail } from '@/lib/session'
import { authClient } from '@/lib/supabase/browser'
import { RolePicker } from './role-picker'

// The member actions of Settings → Team (ROADMAP.md Step 6): change role, remove, leave (any member but
// the owner, also from the settings home), and transfer ownership, which needs a recent sign-in like deleting the account (D-063): when the API
// answers `reauth_required`, a "confirm it's you" code is emailed and checked by Supabase Auth, then the
// transfer is sent again.

export function ChangeRoleDialog({
  member,
  roles,
  access,
  onClose,
  onChanged,
}: {
  member: MemberDto
  roles: readonly RoleDto[]
  access: BusinessContextDto
  onClose: () => void
  onChanged: (member: MemberDto) => void
}) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const ids = useId()
  const change = useMutation(trpc.member.changeRole.mutationOptions())
  const [roleId, setRoleId] = useState<string>(member.roleId)
  const busy = change.isPending

  async function save() {
    if (roleId === member.roleId) return onClose()
    try {
      onChanged(await change.mutateAsync({ memberId: member.id, roleId }))
    } catch {
      // Shown below.
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        closeLabel={t('actions.close')}
        // Start on the member's current role (the menu that opened this may hold the focus first).
        onOpenAutoFocus={(event) => {
          const current = (event.currentTarget as HTMLElement).querySelector<HTMLInputElement>(
            'input[type=radio]:checked',
          )
          if (!current) return
          event.preventDefault()
          current.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('settings.members.changeRoleTitle')}</DialogTitle>
          <DialogDescription>
            {t('settings.members.changeRoleBody', { name: isolate(member.displayName) })}
          </DialogDescription>
        </DialogHeader>
        <form
          method="post"
          noValidate
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          {change.isError ? (
            <FormAlert tone="error">{t(apiErrorKey(change.error))}</FormAlert>
          ) : null}
          <RolePicker
            name={`${ids}-role`}
            legend={t('settings.members.role')}
            roles={roles}
            access={access}
            value={roleId}
            onChange={setRoleId}
            disabled={busy}
          />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              {t('actions.cancel')}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? t('status.saving') : t('settings.members.saveRole')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function RemoveMemberDialog({
  member,
  businessName,
  onClose,
  onRemoved,
}: {
  member: MemberDto
  businessName: string
  onClose: () => void
  onRemoved: () => void
}) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const remove = useMutation(trpc.member.remove.mutationOptions())
  const busy = remove.isPending || remove.isSuccess

  async function confirm() {
    try {
      await remove.mutateAsync({ memberId: member.id })
      onRemoved()
    } catch {
      // Shown below.
    }
  }

  return (
    <AlertDialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-destructive/10 text-destructive">
            <UserRoundXIcon />
          </AlertDialogMedia>
          <AlertDialogTitle>
            {t('settings.members.removeTitle', { name: isolate(member.displayName) })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t('settings.members.removeBody', { businessName: isolate(businessName) })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {remove.isError ? <FormAlert tone="error">{t(apiErrorKey(remove.error))}</FormAlert> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t('actions.cancel')}</AlertDialogCancel>
          <Button
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={busy}
            onClick={() => void confirm()}
          >
            {busy ? t('status.removing') : t('settings.members.remove')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * Leaving the business (member.leave, any member but the owner). Afterwards the app goes home with a
 * full load: the business is no longer in `me`.
 */
export function LeaveBusinessDialog({
  businessName,
  onClose,
}: {
  businessName: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const leave = useMutation(trpc.member.leave.mutationOptions())
  const busy = leave.isPending || leave.isSuccess

  async function confirm() {
    try {
      await leave.mutateAsync()
      window.location.assign('/')
    } catch {
      // Shown below.
    }
  }

  return (
    <AlertDialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-destructive/10 text-destructive">
            <LogOutIcon className="rtl:rotate-180" />
          </AlertDialogMedia>
          <AlertDialogTitle>
            {t('settings.members.leaveTitle', { businessName: isolate(businessName) })}
          </AlertDialogTitle>
          <AlertDialogDescription>{t('settings.members.leaveBody')}</AlertDialogDescription>
        </AlertDialogHeader>
        {leave.isError ? <FormAlert tone="error">{t(apiErrorKey(leave.error))}</FormAlert> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t('actions.cancel')}</AlertDialogCancel>
          <Button
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={busy}
            onClick={() => void confirm()}
          >
            {busy ? t('status.leaving') : t('settings.members.leave')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function TransferOwnershipDialog({
  member,
  businessName,
  onClose,
  onTransferred,
}: {
  member: MemberDto
  businessName: string
  onClose: () => void
  onTransferred: () => void
}) {
  const { t } = useTranslation()
  const message = useMessage()
  const trpc = useTRPC()
  const email = useSessionEmail() ?? ''
  const codeId = useId()
  const [code, setCode] = useState('')
  const transfer = useMutation(trpc.member.transferOwnership.mutationOptions())
  const [check, identity] = useFlow(
    () => createIdentityCheck({ auth: authClient(), email }),
    [email],
  )
  const askingCode = check.step === 'code'
  const busy = transfer.isPending || transfer.isSuccess || check.status !== 'idle'

  async function send() {
    try {
      await transfer.mutateAsync({ memberId: member.id })
    } catch (error) {
      // Not signed in recently: email a code, and transfer once it is confirmed.
      if (apiErrorCode(error) === 'reauth_required') {
        transfer.reset()
        await identity.sendCode()
      }
      return // other errors are shown below
    }
    onTransferred()
  }

  async function confirmAndSend() {
    if (await identity.confirm(code)) await send()
  }

  const codeError: string | undefined =
    check.error === 'auth.errors.codeInvalid' || check.error === 'auth.validation.codeIncomplete'
      ? message(check.error)
      : undefined

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (open || busy) return
        identity.reset()
        onClose()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-accent text-primary">
            <CrownIcon />
          </AlertDialogMedia>
          <AlertDialogTitle>
            {t('settings.members.transferTitle', { name: isolate(member.displayName) })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t('settings.members.transferBody', {
              name: isolate(member.displayName),
              businessName: isolate(businessName),
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {transfer.isError ? (
          <FormAlert tone="error">{t(apiErrorKey(transfer.error) as I18nKey)}</FormAlert>
        ) : null}
        {check.error && !codeError ? (
          <FormAlert tone="error">{message(check.error)}</FormAlert>
        ) : null}
        {askingCode ? (
          <form
            id={`${codeId}-form`}
            method="post"
            noValidate
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              void confirmAndSend()
            }}
          >
            <FormAlert tone={check.notice === 'resent' ? 'success' : 'info'}>
              {check.notice === 'resent' ? (
                t('auth.verify.resent')
              ) : (
                <EmailText i18nKey="settings.members.transferCodeSent" email={email} />
              )}
            </FormAlert>
            <Field data-invalid={Boolean(codeError) || undefined}>
              <FieldLabel htmlFor={codeId}>{t('auth.fields.code')}</FieldLabel>
              <CodeInput
                id={codeId}
                value={code}
                onChange={setCode}
                disabled={busy}
                autoFocus
                aria-invalid={Boolean(codeError)}
                aria-describedby={codeError ? `${codeId}-error` : undefined}
              />
              {codeError ? <FieldError id={`${codeId}-error`}>{codeError}</FieldError> : null}
            </Field>
            <ResendCode
              availableAt={check.resendAvailableAt}
              busy={busy}
              onResend={() => void identity.sendCode()}
            />
          </form>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t('actions.cancel')}</AlertDialogCancel>
          <Button
            type={askingCode ? 'submit' : 'button'}
            form={askingCode ? `${codeId}-form` : undefined}
            onClick={askingCode ? undefined : () => void send()}
            disabled={busy}
          >
            {check.status === 'sending'
              ? t('status.sending')
              : check.status === 'verifying'
                ? t('status.checking')
                : busy
                  ? t('status.saving')
                  : t('settings.members.transferConfirm')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
