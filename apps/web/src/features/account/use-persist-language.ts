'use client'

import { apiErrorKey, syncAuthLocale, useTRPC } from '@bizcost/app-core'
import { createI18n, type I18nKey, type Locale } from '@bizcost/i18n'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { authClient } from '@/lib/supabase/browser'

/**
 * Saves a signed-in user's language: profiles.locale through the API, then user_metadata.locale (the
 * language of the auth emails). Returns false when the profile could not be saved.
 */
export function usePersistLanguage() {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const update = useMutation(trpc.account.updateProfile.mutationOptions())
  return async (locale: Locale): Promise<boolean> => {
    try {
      const profile = await update.mutateAsync({ locale })
      queryClient.setQueryData(trpc.me.queryKey(), (me) => (me ? { ...me, profile } : me))
    } catch (error) {
      toast.error(t(apiErrorKey(error) as I18nKey))
      return false
    }
    // Emails keep the old language if this fails; the next change retries it.
    await syncAuthLocale(authClient(), locale)
    toast.success(createI18n({ locale }).t('account.language.saved'))
    return true
  }
}
