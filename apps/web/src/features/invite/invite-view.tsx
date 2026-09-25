'use client'

import { apiErrorCode, apiErrorKey, signOut, useTRPC } from '@bizcost/app-core'
import { formatDate } from '@bizcost/i18n'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  CalendarClockIcon,
  MailIcon,
  ShieldCheckIcon,
  StoreIcon,
  UserRoundIcon,
} from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AuthCard } from '@/components/auth/auth-shell'
import { EmailText } from '@/components/form/email-text'
import { FormAlert } from '@/components/form/form-alert'
import { isolate } from '@/components/form/use-message'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { roleNameKey } from '@/features/settings/role-labels'
import { useLocale } from '@/lib/i18n/client'
import { authClient } from '@/lib/supabase/browser'
import { rememberInvitation } from './return-path'

// The invitation link (ROADMAP.md Step 6): `/invite/<token>`, open signed in or not. It shows only
// what invitation.preview returns (business, inviter, role, the invited email masked, expiry). Signed
// out, the visitor creates an account or signs in with the invited email and comes back here (the way
// back, the business name and the masked email are kept in this tab, never in a URL, and shown on the
// sign in and sign up pages); signed in with that email, they join; signed in with another one, they
// are told to switch accounts. Any problem with the link reads the same.

function Detail({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof MailIcon
  label: string
  children: ReactNode
}) {
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd className="text-sm font-medium">{children}</dd>
      </div>
    </div>
  )
}

export function InviteView({ token, email }: { token: string; email: string | null }) {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const router = useRouter()
  const trpc = useTRPC()
  // Each preview counts against the link's hourly limit: read it once per visit.
  const preview = useQuery({
    ...trpc.invitation.preview.queryOptions({ token }),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
  const accept = useMutation(trpc.invitation.accept.mutationOptions())
  const [joining, setJoining] = useState(false)
  const [signingOut, setSigningOut] = useState(false)

  if (preview.isPending) {
    return (
      <AuthCard title={t('auth.invite.loading')}>
        <p role="status" className="sr-only">
          {t('status.loading')}
        </p>
        <div className="space-y-3">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      </AuthCard>
    )
  }

  if (preview.isError) {
    const code = apiErrorCode(preview.error)
    return (
      <AuthCard
        title={t('auth.invite.invalidTitle')}
        description={
          code === 'invitation_invalid'
            ? t('auth.invite.invalidBody')
            : t(apiErrorKey(preview.error))
        }
      >
        <Button asChild size="lg" variant="outline" className="w-full">
          <Link href="/">{t('auth.invite.goHome')}</Link>
        </Button>
      </AuthCard>
    )
  }

  const invitation = preview.data
  const business = isolate(invitation.businessName)
  const roleKey = roleNameKey(invitation.roleTemplateKey)
  const role = roleKey ? t(roleKey) : (invitation.roleName ?? '')
  const signedIn = email !== null && invitation.emailMatches !== null

  if (invitation.expired) {
    return (
      <AuthCard
        title={t('auth.invite.expiredTitle')}
        description={
          invitation.inviterName
            ? t('auth.invite.expiredBodyFrom', {
                name: isolate(invitation.inviterName),
                businessName: business,
              })
            : t('auth.invite.expiredBody', { businessName: business })
        }
      >
        <Button asChild size="lg" variant="outline" className="w-full">
          <Link href="/">{t('auth.invite.goHome')}</Link>
        </Button>
      </AuthCard>
    )
  }

  async function join() {
    setJoining(true)
    try {
      const { businessId } = await accept.mutateAsync({ token })
      // A full load: the new business comes with a fresh `me`.
      window.location.assign(`/b/${businessId}`)
    } catch (error) {
      // Already a member (e.g. the reply to an earlier Join was lost): home opens the business.
      if (apiErrorCode(error) === 'already_member') {
        window.location.assign('/')
        return
      }
      setJoining(false)
    }
  }

  async function switchAccount() {
    setSigningOut(true)
    await signOut(authClient(), 'local')
    // Back here, signed out: sign in with the invited email.
    window.location.assign(`/invite/${token}`)
  }

  function continueTo(path: '/signup' | '/login') {
    rememberInvitation(token, {
      businessName: invitation.businessName,
      maskedEmail: invitation.maskedEmail,
    })
    router.push(path)
  }

  return (
    <AuthCard
      title={t('auth.invite.title', { businessName: business })}
      description={
        invitation.inviterName
          ? t('auth.invite.bodyFrom', { name: isolate(invitation.inviterName), role })
          : t('auth.invite.body', { role })
      }
    >
      <div className="space-y-5">
        <div className="flex items-center gap-3 rounded-xl bg-accent/60 px-4 py-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-card text-primary shadow-sm">
            <StoreIcon aria-hidden className="size-5" />
          </span>
          <span dir="auto" className="min-w-0 truncate text-start font-semibold">
            {invitation.businessName}
          </span>
        </div>
        <dl className="divide-y rounded-xl border">
          <Detail icon={MailIcon} label={t('auth.invite.for')}>
            <bdi dir="ltr" className="break-all">
              {invitation.maskedEmail}
            </bdi>
          </Detail>
          <Detail icon={ShieldCheckIcon} label={t('auth.invite.role')}>
            <span dir="auto">{role}</span>
          </Detail>
          <Detail icon={CalendarClockIcon} label={t('auth.invite.expires')}>
            {formatDate(locale, invitation.expiresAt, { dateStyle: 'long' })}
          </Detail>
        </dl>

        {accept.isError ? (
          <FormAlert tone="error">
            {apiErrorCode(accept.error) === 'invitation_invalid'
              ? t('errors.invitation_invalid')
              : t(apiErrorKey(accept.error))}
          </FormAlert>
        ) : null}

        {signedIn && invitation.emailMatches ? (
          <Button
            size="lg"
            className="h-auto min-h-11 w-full py-2.5 text-balance whitespace-normal"
            disabled={joining}
            onClick={() => void join()}
          >
            {joining ? t('auth.invite.joining') : t('auth.invite.join')}
          </Button>
        ) : signedIn ? (
          <div className="space-y-4">
            <FormAlert tone="error">
              <p>
                <EmailText i18nKey="auth.invite.otherEmail" email={invitation.maskedEmail} />
              </p>
              <p className="mt-1 flex items-center gap-1.5 text-foreground">
                <UserRoundIcon aria-hidden className="size-3.5 shrink-0" />
                <bdi dir="ltr" className="break-all">
                  {email}
                </bdi>
              </p>
            </FormAlert>
            <Button
              size="lg"
              className="w-full"
              disabled={signingOut}
              onClick={() => void switchAccount()}
            >
              {signingOut ? t('status.signingOut') : t('auth.invite.switchAccount')}
            </Button>
            <Button asChild size="lg" variant="outline" className="w-full">
              <Link href="/">{t('auth.invite.goHome')}</Link>
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm leading-relaxed text-muted-foreground">
              <EmailText i18nKey="auth.invite.useEmail" email={invitation.maskedEmail} />
            </p>
            <Button size="lg" className="w-full" onClick={() => continueTo('/signup')}>
              {t('auth.invite.createAccount')}
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="w-full"
              onClick={() => continueTo('/login')}
            >
              {t('auth.invite.signIn')}
            </Button>
          </div>
        )}
      </div>
    </AuthCard>
  )
}
