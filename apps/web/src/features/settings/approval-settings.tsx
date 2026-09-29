'use client'

import { apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { RoleDto } from '@bizcost/contracts'
import type { I18nKey } from '@bizcost/i18n'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { LoadError, SectionSkeleton } from '@/components/states/query-state'
import { Switch } from '@/components/ui/switch'
import { Section } from '@/features/account/section'
import { useBusinessContext } from '@/lib/trpc/client'
import { can, isSectionVisible } from './sections'
import { SectionPage } from './settings-shell'

// Settings → Expense approval (M2 Step 5; PRODUCT.md §4 rule 13, D-164): whether an expense entered by
// someone who may not approve expenses is sent for approval before it can be finalized. Off by
// default; only for a business with a team, and only members with expenses.approval.manage (Owner,
// Admin) see it. The switch saves at once (nothing is left unsaved), and every change is audited.

/**
 * Whether a role enters expenses that go for approval: it may enter them, and may not review them
 * (approve, with supplier prices visible: D-175). With none, turning approval on changes nothing.
 */
export function sendsForApproval(role: Pick<RoleDto, 'isOwner' | 'permissionKeys'>): boolean {
  if (role.isOwner) return false
  const keys = new Set(role.permissionKeys)
  return (
    keys.has('expenses.documents.manage') &&
    !(keys.has('expenses.documents.approve') && keys.has('data.supplier_price.view'))
  )
}

export function ApprovalSettings({ businessId }: { businessId: string }) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data: context } = useBusinessContext()
  const visible = context ? isSectionVisible(context, 'approval') : false
  const settings = useQuery({ ...trpc.expense.settings.queryOptions(), enabled: visible })
  // Who would send expenses for approval (the roles; per-member changes are not counted).
  const roles = useQuery({
    ...trpc.role.list.queryOptions(),
    enabled:
      visible &&
      context !== undefined &&
      (can(context, 'settings.members.view') || can(context, 'settings.roles.manage')),
  })
  const nobodySends = roles.data !== undefined && !roles.data.some(sendsForApproval)
  const update = useMutation(trpc.expense.updateSettings.mutationOptions())
  const [error, setError] = useState<I18nKey | null>(null)

  async function change(approval: boolean) {
    setError(null)
    try {
      const saved = await update.mutateAsync({ approval })
      queryClient.setQueryData(trpc.expense.settings.queryKey(), saved)
      // Expenses say whether they need approval (and which actions they offer).
      await queryClient.invalidateQueries({ queryKey: trpc.expense.pathKey() })
      toast.success(t(saved.approval ? 'settings.approval.on' : 'settings.approval.off'))
    } catch (caught) {
      setError(apiErrorKey(caught))
    }
  }

  return (
    <SectionPage businessId={businessId} section="approval">
      <Section
        title={t('settings.approval.sectionTitle')}
        description={t('settings.approval.explain')}
      >
        {settings.isPending ? (
          <SectionSkeleton cards={1} />
        ) : settings.isError ? (
          <LoadError error={settings.error} onRetry={() => void settings.refetch()} />
        ) : (
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-4 rounded-xl bg-muted/60 px-4 py-3">
              <div className="min-w-0">
                <p id="expense-approval" className="text-sm font-medium">
                  {t('settings.approval.switch')}
                </p>
                <p id="expense-approval-hint" className="mt-0.5 text-sm text-muted-foreground">
                  {settings.data.hasTeam
                    ? t('settings.approval.switchHint')
                    : t('settings.approval.noTeam')}
                </p>
              </div>
              <Switch
                checked={settings.data.approval}
                disabled={update.isPending || !settings.data.hasTeam}
                onCheckedChange={(checked) => void change(checked)}
                aria-labelledby="expense-approval"
                aria-describedby="expense-approval-hint"
                className="mt-1"
              />
            </div>
            {settings.data.approval && settings.data.hasTeam && nobodySends ? (
              <FormAlert tone="info">
                <span data-nobody-sends>{t('settings.approval.nobodySends')}</span>
              </FormAlert>
            ) : null}
            {error ? <FormAlert tone="error">{t(error)}</FormAlert> : null}
          </div>
        )}
      </Section>
    </SectionPage>
  )
}
