'use client'

import { apiErrorKey, syncAuthLocale, useTRPC } from '@bizcost/app-core'
import type { I18nKey, Locale } from '@bizcost/i18n'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { toastAfterLanguageSwitch } from '@/lib/i18n/client'
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
    // Said in the new language, once the page has switched to it (the page holds one language).
    toastAfterLanguageSwitch('common.language.saved')
    return true
  }
}
