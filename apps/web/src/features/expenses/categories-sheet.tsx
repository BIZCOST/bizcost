'use client'

import { apiErrorCode, apiErrorKey, apiErrorNames, useTRPC } from '@bizcost/app-core'
import {
  COST_CATEGORY_NAME_MAX_LENGTH,
  hasVisibleCharacter,
  type CostCategoryDto,
} from '@bizcost/contracts'
import { nameKey, newId } from '@bizcost/domain'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArchiveIcon, ArchiveRestoreIcon, PencilIcon, PlusIcon } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { TextField } from '@/components/form/text-field'
import { useUnsavedChanges } from '@/components/form/unsaved-changes'
import { isolate } from '@/components/form/use-message'
import { LoadError } from '@/components/states/query-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { formName } from '@/features/catalog/material-draft'
import { useCostCategories } from './data'

// The categories expenses and running costs share (M2 Step 5; D-116, D-167), opened from Expenses and
// from Running Costs by a member who may add them: one list, the owner's starter list first. A
// category is added, edited (its name, and whether its bills come the month after: a new expense in
// it is then for the month before its bill's date, D-194) or archived (never deleted: what already
// has it keeps it) and brought back. A name the business already has is refused with the category
// that has it. A name typed and not saved is asked about before the sheet closes (D-161).

/** The problem with a typed name (translated), or null. */
function useNameProblem() {
  const { t } = useTranslation()
  return (typed: string): string | null => {
    if (!hasVisibleCharacter(typed)) return t('catalog.form.nameRequired')
    if (typed.length > COST_CATEGORY_NAME_MAX_LENGTH) {
      return t('catalog.form.nameTooLong', { count: COST_CATEGORY_NAME_MAX_LENGTH })
    }
    return null
  }
}

/** What is being changed while a category is edited here. */
interface CategoryEdit {
  readonly name: string
  readonly billedNextMonth: boolean
}

/** One category: its name and, for a manager, edit and archive (or bring back). */
function CategoryRow({
  category,
  editing,
  onEdit,
  onEditDone,
}: {
  category: CostCategoryDto
  /** What is being changed while it is edited here. */
  editing: CategoryEdit | null
  onEdit: (edit: CategoryEdit | null) => void
  onEditDone: () => void
}) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const problem = useNameProblem()
  const update = useMutation(trpc.costCategory.update.mutationOptions())
  const archive = useMutation(trpc.costCategory.archive.mutationOptions())
  const unarchive = useMutation(trpc.costCategory.unarchive.mutationOptions())
  const [error, setError] = useState<string | null>(null)
  const busy = update.isPending || archive.isPending || unarchive.isPending
  const archived = category.archivedAt !== null
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.costCategory.list.pathKey() }),
      // The month's costs on Product costs are by category (its name, billed the month after).
      queryClient.invalidateQueries({ queryKey: trpc.productCost.pathKey() }),
    ])

  async function rename(event: FormEvent) {
    event.preventDefault()
    event.stopPropagation()
    if (editing === null) return
    const typed = formName(editing.name)
    const wrong = problem(typed)
    if (wrong) return setError(wrong)
    if (typed === category.name && editing.billedNextMonth === category.billedNextMonth) {
      return onEditDone()
    }
    try {
      await update.mutateAsync({
        id: category.id,
        version: category.version,
        name: typed,
        billedNextMonth: editing.billedNextMonth,
      })
      toast.success(t('expenses.categories.saved'))
      setError(null)
      onEditDone()
    } catch (caught) {
      const [taken] = apiErrorNames(caught)
      setError(
        apiErrorCode(caught) === 'name_taken'
          ? taken
            ? t('expenses.categories.taken', { name: isolate(taken) })
            : t('errors.name_taken')
          : apiErrorCode(caught) === 'conflict'
            ? t('catalog.form.conflict')
            : t(apiErrorKey(caught)),
      )
    } finally {
      await refresh()
    }
  }

  async function toggleArchived() {
    try {
      if (archived) {
        await unarchive.mutateAsync({ id: category.id })
        toast.success(t('expenses.categories.unarchived', { name: isolate(category.name) }))
      } else {
        await archive.mutateAsync({ id: category.id })
        toast.success(t('expenses.categories.archived', { name: isolate(category.name) }))
      }
    } catch (caught) {
      toast.error(t(apiErrorKey(caught)))
    } finally {
      await refresh()
    }
  }

  if (editing !== null) {
    return (
      <li className="py-2.5">
        <form noValidate onSubmit={(event) => void rename(event)} className="space-y-2">
          <TextField
            label={t('expenses.categories.newName', { name: isolate(category.name) })}
            autoFocus
            autoComplete="off"
            className="[unicode-bidi:plaintext]"
            value={editing.name}
            onChange={(event) => onEdit({ ...editing, name: event.target.value })}
            error={error ?? undefined}
          />
          <div className="flex items-start justify-between gap-4 rounded-xl border bg-background/60 p-3">
            <div className="min-w-0">
              <p id={`${category.id}-billed`} className="text-sm font-medium">
                {t('expenses.categories.billedNextMonth')}
              </p>
              <p id={`${category.id}-billed-hint`} className="mt-0.5 text-sm text-muted-foreground">
                {t('expenses.categories.billedNextMonthHint')}
              </p>
            </div>
            <Switch
              checked={editing.billedNextMonth}
              onCheckedChange={(billedNextMonth) => onEdit({ ...editing, billedNextMonth })}
              aria-labelledby={`${category.id}-billed`}
              aria-describedby={`${category.id}-billed-hint`}
              className="mt-0.5"
            />
          </div>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              {busy ? t('status.saving') : t('expenses.categories.save')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setError(null)
                onEditDone()
              }}
            >
              {t('expenses.categories.cancel')}
            </Button>
          </div>
        </form>
      </li>
    )
  }

  return (
    <li data-category={category.name} className="flex items-center gap-2 py-1.5">
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <bdi className={archived ? 'text-muted-foreground' : 'font-medium'} dir="auto">
          {category.name}
        </bdi>
        {archived ? <Badge>{t('expenses.categories.archivedBadge')}</Badge> : null}
        {category.billedNextMonth && !archived ? (
          <Badge tone="primary" data-billed-next-month>
            {t('expenses.categories.billedNextMonthBadge')}
          </Badge>
        ) : null}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={busy}
        aria-label={t('expenses.categories.edit', { name: isolate(category.name) })}
        onClick={() => onEdit({ name: category.name, billedNextMonth: category.billedNextMonth })}
        className="text-muted-foreground"
      >
        <PencilIcon aria-hidden />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={busy}
        aria-label={t(archived ? 'expenses.categories.unarchive' : 'expenses.categories.archive', {
          name: isolate(category.name),
        })}
        onClick={() => void toggleArchived()}
        className="text-muted-foreground"
      >
        {archived ? <ArchiveRestoreIcon aria-hidden /> : <ArchiveIcon aria-hidden />}
      </Button>
    </li>
  )
}

export function CategoriesSheet({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const problem = useNameProblem()
  const { categories, ready, error, refetch } = useCostCategories()
  const create = useMutation(trpc.costCategory.create.mutationOptions())
  const [name, setName] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [newCategoryId, setNewCategoryId] = useState(() => newId())
  const [editing, setEditing] = useState<({ id: string } & CategoryEdit) | null>(null)
  const active = categories.filter((category) => category.archivedAt === null)
  const archived = categories.filter((category) => category.archivedAt !== null)

  /** Adds the typed category; true once added (or when nothing was typed). */
  async function add(): Promise<boolean> {
    const typed = formName(name)
    const wrong = problem(typed)
    if (wrong) {
      setAddError(wrong)
      return false
    }
    const existing = categories.find((category) => nameKey(category.name) === nameKey(typed))
    if (existing) {
      setAddError(t('expenses.categories.taken', { name: isolate(existing.name) }))
      return false
    }
    setAddError(null)
    try {
      const created = await create.mutateAsync({ id: newCategoryId, name: typed })
      setNewCategoryId(newId())
      setName('')
      toast.success(t('expenses.categories.added', { name: isolate(created.name) }))
      await queryClient.invalidateQueries({ queryKey: trpc.costCategory.list.pathKey() })
      return true
    } catch (caught) {
      const [taken] = apiErrorNames(caught)
      setAddError(
        apiErrorCode(caught) === 'name_taken'
          ? taken
            ? t('expenses.categories.taken', { name: isolate(taken) })
            : t('errors.name_taken')
          : t(apiErrorKey(caught)),
      )
      return false
    }
  }

  const editingCategory = editing ? categories.find((c) => c.id === editing.id) : undefined
  const dirty =
    formName(name) !== '' ||
    (editing !== null &&
      editingCategory !== undefined &&
      (formName(editing.name) !== editingCategory.name ||
        editing.billedNextMonth !== editingCategory.billedNextMonth))
  const guard = useUnsavedChanges({
    dirty,
    // Leaving with a name typed: Save adds it (a rename in progress is saved with its own button).
    save: () => (formName(name) !== '' ? add() : Promise.resolve(false)),
    close: onClose,
  })

  function submit(event: FormEvent) {
    event.preventDefault()
    event.stopPropagation()
    void add()
  }

  const row = (category: CostCategoryDto) => (
    <CategoryRow
      key={category.id}
      category={category}
      editing={editing?.id === category.id ? editing : null}
      onEdit={(value) => setEditing(value === null ? null : { id: category.id, ...value })}
      onEditDone={() => setEditing(null)}
    />
  )

  return (
    <Sheet open onOpenChange={(open) => !open && guard.requestLeave(onClose)}>
      <SheetContent closeLabel={t('actions.close')}>
        <SheetHeader>
          <SheetTitle>{t('expenses.categories.title')}</SheetTitle>
          <SheetDescription className="max-sm:not-sr-only">
            {t('expenses.categories.description')}
          </SheetDescription>
        </SheetHeader>
        <SheetBody className="space-y-5">
          <form noValidate onSubmit={submit} className="space-y-2">
            <TextField
              label={t('expenses.categories.add')}
              error={addError ?? undefined}
              render={(a11y) => (
                <div className="flex gap-2">
                  <Input
                    {...a11y}
                    autoComplete="off"
                    placeholder={t('expenses.categories.addPlaceholder')}
                    className="min-w-0 flex-1 [unicode-bidi:plaintext]"
                    value={name}
                    onChange={(event) => {
                      setName(event.target.value)
                      setAddError(null)
                    }}
                  />
                  <Button type="submit" disabled={create.isPending}>
                    <PlusIcon aria-hidden />
                    {t('expenses.categories.addAction')}
                  </Button>
                </div>
              )}
            />
          </form>
          {error && categories.length === 0 ? (
            <LoadError error={error} onRetry={() => void refetch()} />
          ) : !ready && categories.length === 0 ? (
            <div className="space-y-2">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          ) : categories.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('expenses.categories.none')}</p>
          ) : (
            <>
              <ul aria-label={t('expenses.categories.title')} className="divide-y">
                {active.map(row)}
              </ul>
              {archived.length > 0 ? (
                <div className="space-y-2">
                  <FormAlert tone="info">{t('expenses.categories.archivedHint')}</FormAlert>
                  <ul aria-label={t('expenses.categories.archivedBadge')} className="divide-y">
                    {archived.map(row)}
                  </ul>
                </div>
              ) : null}
            </>
          )}
        </SheetBody>
        <SheetFooter className="grid-cols-1">
          <Button type="button" variant="outline" onClick={() => guard.requestLeave(onClose)}>
            {t('actions.close')}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
