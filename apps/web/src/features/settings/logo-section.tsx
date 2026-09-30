'use client'

import { apiErrorKey, useMe, useTRPC } from '@bizcost/app-core'
import {
  LOGO_CONTENT_TYPES,
  LOGO_MAX_BYTES,
  type BusinessProfileDto,
  type LogoContentType,
} from '@bizcost/contracts'
import type { I18nKey } from '@bizcost/i18n'
import { isRoleTemplateKey } from '@bizcost/modules'
import { useMutation } from '@tanstack/react-query'
import { CropIcon, ImageUpIcon, Loader2Icon, StoreIcon, Trash2Icon } from 'lucide-react'
import { useParams } from 'next/navigation'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useSignedUrlFailure } from '@/components/app/business-logo'
import { FormAlert } from '@/components/form/form-alert'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Section } from '@/features/account/section'
import { useBusinessName } from '@/features/business/use-business-name'
import { LOGO_SOURCE_MAX_BYTES } from './logo-crop'
import { LogoCropDialog } from './logo-cropper'
import { useProfileSaved } from './profile-data'

// The business logo (ROADMAP.md Step 6): a PNG, JPEG or WebP, first placed in its square ("Adjust
// your logo", the owner's request of 2026-09-30: zoom and move, with how it looks beside the name),
// then drawn by the browser as a square picture of 512 × 512 and uploaded straight to the private
// bucket with a signed URL the API issues (business.logoUploadUrl), then checked and saved by the API
// (business.setLogo; its checks and limits unchanged). The saved logo can be adjusted again. The
// picture shows at once; the saved logo comes back as a short-lived signed URL with the profile. A
// saved logo that fails to load (its URL expired while the page stayed open) refetches the profile,
// which brings a new URL (useSignedUrlFailure).

function isLogoType(type: string): type is LogoContentType {
  return (LOGO_CONTENT_TYPES as readonly string[]).includes(type)
}

/** What the file checks and the upload answer mean for the user. */
function uploadErrorKey(status: number): I18nKey {
  if (status === 413) return 'settings.business.logo.tooBig'
  if (status === 400 || status === 415) return 'settings.business.logo.wrongType'
  return 'errors.internal'
}

export function LogoSection({
  profile,
  profileAt,
  canEdit,
}: {
  profile: BusinessProfileDto
  /** When `profile` was fetched (dataUpdatedAt): a logo that failed is tried again after a refetch. */
  profileAt: number
  canEdit: boolean
}) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const saved = useProfileSaved()
  const inputId = useId()
  const input = useRef<HTMLInputElement>(null)
  const uploadUrl = useMutation(trpc.business.logoUploadUrl.mutationOptions())
  const setLogo = useMutation(trpc.business.setLogo.mutationOptions())
  const removeLogo = useMutation(trpc.business.removeLogo.mutationOptions())
  const [busy, setBusy] = useState<'uploading' | 'removing' | null>(null)
  const [error, setError] = useState<I18nKey | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  // The picture being placed in its square: a chosen file (its object URL, freed after) or the
  // saved logo.
  const [cropping, setCropping] = useState<{ src: string; file: boolean } | null>(null)
  const { businessId } = useParams<{ businessId: string }>()
  const businessName = useBusinessName(businessId)
  const { data: me } = useMe()
  const template = me?.memberships.find((m) => m.businessId === businessId)?.roleTemplateKey ?? null
  const role = t(isRoleTemplateKey(template) ? `roles.${template}` : 'roles.custom')
  const savedLogo = useSignedUrlFailure(
    profile.logoUrl,
    trpc.business.profile.queryKey(),
    profileAt,
  )

  // The chosen file's picture is shown until the saved logo replaces it; its URL is freed after.
  useEffect(() => {
    if (!preview) return
    return () => URL.revokeObjectURL(preview)
  }, [preview])

  useEffect(() => {
    if (!cropping?.file) return
    const src = cropping.src
    return () => URL.revokeObjectURL(src)
  }, [cropping])

  /** A chosen file: checked, then placed in its square. */
  function choose(file: File) {
    setError(null)
    if (!isLogoType(file.type)) return setError('settings.business.logo.wrongType')
    if (file.size > LOGO_SOURCE_MAX_BYTES) return setError('settings.business.logo.tooBig')
    setCropping({ src: URL.createObjectURL(file), file: true })
  }

  /** Uploads the square picture; true once saved (the section says what went wrong otherwise). */
  async function upload(file: Blob): Promise<boolean> {
    setError(null)
    if (!isLogoType(file.type)) {
      setError('settings.business.logo.wrongType')
      return false
    }
    if (file.size > LOGO_MAX_BYTES) {
      setError('settings.business.logo.tooBig')
      return false
    }
    setBusy('uploading')
    setPreview(URL.createObjectURL(file))
    try {
      const target = await uploadUrl.mutateAsync({ contentType: file.type })
      const response = await fetch(target.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': file.type, 'x-upsert': 'false' },
        body: file,
      })
      if (!response.ok) {
        setError(uploadErrorKey(response.status))
        setPreview(null)
        return false
      }
      saved(await setLogo.mutateAsync({ path: target.path }))
      toast.success(t('settings.business.logo.saved'))
      return true
    } catch (caught) {
      setError(caught instanceof TypeError ? 'errors.network' : apiErrorKey(caught))
      return false
    } finally {
      setPreview(null)
      setBusy(null)
    }
  }

  async function remove() {
    setError(null)
    setBusy('removing')
    try {
      saved(await removeLogo.mutateAsync())
      setConfirmOpen(false)
      toast.success(t('settings.business.logo.removed'))
    } catch (caught) {
      setError(apiErrorKey(caught))
    } finally {
      setBusy(null)
    }
  }

  // The saved logo's URL failed: the store mark (without "No logo") until the profile brings a new one.
  const broken = !preview && savedLogo.failed
  const shown = preview ?? (broken ? null : profile.logoUrl)

  return (
    <Section
      title={t('settings.business.logo.title')}
      description={t('settings.business.logo.description')}
    >
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
        <div className="relative flex size-24 shrink-0 items-center justify-center overflow-hidden rounded-2xl border bg-white">
          {shown ? (
            // A signed URL of the private bucket (or the chosen file): a plain image, not next/image.
            <img
              src={shown}
              alt={t('settings.business.logo.alt')}
              className="size-full object-contain p-1"
              data-testid="business-logo"
              onError={preview ? undefined : savedLogo.onError}
            />
          ) : (
            <span className="flex flex-col items-center gap-1 text-muted-foreground">
              <StoreIcon aria-hidden className="size-7" />
              {broken ? null : <span className="text-xs">{t('settings.business.logo.none')}</span>}
            </span>
          )}
          {busy === 'uploading' ? (
            <span className="absolute inset-0 flex items-center justify-center bg-card/70">
              <Loader2Icon aria-hidden className="size-6 animate-spin text-primary" />
            </span>
          ) : null}
        </div>
        {canEdit ? (
          <div className="min-w-0 space-y-3">
            <div className="flex flex-wrap gap-2">
              <input
                ref={input}
                id={inputId}
                type="file"
                accept={LOGO_CONTENT_TYPES.join(',')}
                className="sr-only"
                tabIndex={-1}
                aria-hidden
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (file) choose(file)
                }}
              />
              <Button
                type="button"
                variant="outline"
                disabled={busy !== null}
                onClick={() => input.current?.click()}
              >
                <ImageUpIcon aria-hidden />
                {busy === 'uploading'
                  ? t('settings.business.logo.uploading')
                  : profile.logoUrl
                    ? t('settings.business.logo.replace')
                    : t('settings.business.logo.upload')}
              </Button>
              {profile.logoUrl && !broken ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => {
                    setError(null)
                    setCropping({ src: profile.logoUrl!, file: false })
                  }}
                >
                  <CropIcon aria-hidden />
                  {t('settings.business.logo.adjust')}
                </Button>
              ) : null}
              {profile.logoUrl ? (
                <AlertDialog
                  open={confirmOpen}
                  onOpenChange={(next) => {
                    if (busy !== null) return
                    setError(null)
                    setConfirmOpen(next)
                  }}
                >
                  <AlertDialogTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      className="text-destructive hover:bg-destructive/5 hover:text-destructive"
                      disabled={busy !== null}
                    >
                      <Trash2Icon aria-hidden />
                      {t('settings.business.logo.remove')}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogMedia className="bg-destructive/10 text-destructive">
                        <Trash2Icon />
                      </AlertDialogMedia>
                      <AlertDialogTitle>{t('settings.business.logo.removeTitle')}</AlertDialogTitle>
                      <AlertDialogDescription>
                        {t('settings.business.logo.removeBody')}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    {/* A failed removal is shown here: the section behind is covered. */}
                    {error ? <FormAlert tone="error">{t(error)}</FormAlert> : null}
                    <AlertDialogFooter>
                      <AlertDialogCancel disabled={busy !== null}>
                        {t('actions.cancel')}
                      </AlertDialogCancel>
                      <Button
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        disabled={busy !== null}
                        onClick={() => void remove()}
                      >
                        {busy === 'removing'
                          ? t('status.deleting')
                          : t('settings.business.logo.remove')}
                      </Button>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : null}
            </div>
            <p className="text-sm text-muted-foreground">{t('settings.business.logo.rules')}</p>
          </div>
        ) : null}
      </div>
      {error && !confirmOpen && !cropping ? (
        <FormAlert tone="error" className="mt-4">
          {t(error)}
        </FormAlert>
      ) : null}
      {cropping ? (
        <LogoCropDialog
          src={cropping.src}
          businessName={businessName}
          role={role}
          error={error ? t(error) : null}
          onCancel={() => {
            setError(null)
            setCropping(null)
          }}
          onSave={async (picture) => {
            const done = await upload(picture)
            if (done) setCropping(null)
            return done
          }}
        />
      ) : null}
    </Section>
  )
}
