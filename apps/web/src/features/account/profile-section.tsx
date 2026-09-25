'use client'

import { apiErrorKey, profileFormSchema, useMe, useTRPC, type ProfileForm } from '@bizcost/app-core'
import type { I18nKey } from '@bizcost/i18n'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { TextField } from '@/components/form/text-field'
import { useMessage } from '@/components/form/use-message'
import { Button } from '@/components/ui/button'
import { Section } from './section'

export function ProfileSection() {
  const { t } = useTranslation()
  const message = useMessage()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data: me } = useMe()
  const update = useMutation(trpc.account.updateProfile.mutationOptions())
  const form = useForm<ProfileForm>({
    resolver: zodResolver(profileFormSchema),
    defaultValues: { displayName: me?.profile.displayName ?? '' },
  })

  const submit = form.handleSubmit(async ({ displayName }) => {
    try {
      const profile = await update.mutateAsync({ displayName })
      queryClient.setQueryData(trpc.me.queryKey(), (old) => (old ? { ...old, profile } : old))
      form.reset({ displayName: profile.displayName })
      toast.success(t('account.profile.saved'))
    } catch (error) {
      toast.error(t(apiErrorKey(error) as I18nKey))
    }
  })

  return (
    <Section
      anchor="profile"
      title={t('account.profile.title')}
      description={t('account.profile.description')}
    >
      <form method="post" onSubmit={submit} noValidate className="space-y-4">
        <TextField
          label={t('account.profile.displayName')}
          autoComplete="name"
          dir="auto"
          error={message(form.formState.errors.displayName?.message)}
          {...form.register('displayName')}
        />
        <div className="flex justify-end">
          <Button type="submit" disabled={!form.formState.isDirty || form.formState.isSubmitting}>
            {form.formState.isSubmitting ? t('status.saving') : t('actions.save')}
          </Button>
        </div>
      </form>
    </Section>
  )
}
