'use client'

import { apiErrorKey, useTRPC } from '@bizcost/app-core'
import {
  LOGO_CONTENT_TYPES,
  LOGO_MAX_BYTES,
  type BusinessProfileDto,
  type LogoContentType,
} from '@bizcost/contracts'
import type { I18nKey } from '@bizcost/i18n'
import { useMutation } from '@tanstack/react-query'
import { ImageUpIcon, Loader2Icon, StoreIcon, Trash2Icon } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
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
import { useProfileSaved } from './profile-data'

// The business logo (ROADMAP.md Step 6): a PNG, JPEG or WebP of up to 2 MB, uploaded straight to the
// private bucket with a signed URL the API issues (business.logoUploadUrl), then checked and saved by
// the API (business.setLogo). The picture shows at once from the chosen file; the saved logo comes back
// as a short-lived signed URL with the profile.

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
  canEdit,
}: {
  profile: BusinessProfileDto
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

  // The chosen file's picture is shown until the saved logo replaces it; its URL is freed after.
  useEffect(() => {
    if (!preview) return
    return () => URL.revokeObjectURL(preview)
  }, [preview])

  async function upload(file: File) {
    setError(null)
    if (!isLogoType(file.type)) return setError('settings.business.logo.wrongType')
    if (file.size > LOGO_MAX_BYTES) return setError('settings.business.logo.tooBig')
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
        return
      }
      saved(await setLogo.mutateAsync({ path: target.path }))
      toast.success(t('settings.business.logo.saved'))
    } catch (caught) {
      setError(caught instanceof TypeError ? 'errors.network' : apiErrorKey(caught))
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

  const shown = preview ?? profile.logoUrl

  return (
    <Section
      title={t('settings.business.logo.title')}
      description={t('settings.business.logo.description')}
    >
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
        <div className="relative flex size-24 shrink-0 items-center justify-center overflow-hidden rounded-2xl border bg-background">
          {shown ? (
            // A signed URL of the private bucket (or the chosen file): a plain image, not next/image.
            <img
              src={shown}
              alt={t('settings.business.logo.alt')}
              className="size-full object-contain p-2"
              data-testid="business-logo"
            />
          ) : (
            <span className="flex flex-col items-center gap-1 text-muted-foreground">
              <StoreIcon aria-hidden className="size-7" />
              <span className="text-xs">{t('settings.business.logo.none')}</span>
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
                  if (file) void upload(file)
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
      {error && !confirmOpen ? (
        <FormAlert tone="error" className="mt-4">
          {t(error)}
        </FormAlert>
      ) : null}
    </Section>
  )
}
