'use client'

import { apiErrorCode, apiErrorKey, apiErrorNames, useTRPC } from '@bizcost/app-core'
import {
  COST_CATEGORY_NAME_MAX_LENGTH,
  hasVisibleCharacter,
  type CostCategoryDto,
} from '@bizcost/contracts'
import { nameKey, newId } from '@bizcost/domain'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Required } from '@/components/form/required'
import { TextField } from '@/components/form/text-field'
import { isolate } from '@/components/form/use-message'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { formName } from '@/features/catalog/material-draft'
import { pickableCategories } from './categories'

// The category of an expense or a running cost (M2 Step 5; D-116, D-167): one list shared by both, in
// the order people look for them. A member who may add categories picks "New category…" and types
// its name in place, without leaving the form; a name the business already has picks that category
// (an archived one is said instead: it is brought back from Categories).

const NEW_CATEGORY = '__new-category__'

export function CategoryField({
  value,
  onChange,
  categories,
  canAdd,
  error,
  onAdded,
}: {
  value: string
  onChange: (categoryId: string) => void
  /** Every category, in order (useCategoryOptions). */
  categories: readonly CostCategoryDto[]
  /** The member may add categories (canManageCategories). */
  canAdd: boolean
  /** Translated. */
  error?: string
  /** A category added here (the form's list keeps it until it reads it). */
  onAdded: (category: CostCategoryDto) => void
}) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const create = useMutation(trpc.costCategory.create.mutationOptions())
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [newCategoryId, setNewCategoryId] = useState(() => newId())
  const input = useRef<HTMLInputElement>(null)
  const options = pickableCategories(categories, value)

  function close() {
    setAdding(false)
    setName('')
    setAddError(null)
  }

  async function add() {
    const typed = formName(name)
    if (!hasVisibleCharacter(typed)) {
      setAddError(t('catalog.form.nameRequired'))
      input.current?.focus()
      return
    }
    if (typed.length > COST_CATEGORY_NAME_MAX_LENGTH) {
      setAddError(t('catalog.form.nameTooLong', { count: COST_CATEGORY_NAME_MAX_LENGTH }))
      input.current?.focus()
      return
    }
    // Already in the list: pick it (an archived one is said).
    const existing = categories.find((category) => nameKey(category.name) === nameKey(typed))
    if (existing) {
      if (existing.archivedAt === null) {
        onChange(existing.id)
        close()
      } else setAddError(t('expenses.categories.taken', { name: isolate(existing.name) }))
      return
    }
    setAddError(null)
    try {
      const created = await create.mutateAsync({ id: newCategoryId, name: typed })
      setNewCategoryId(newId())
      onAdded(created)
      onChange(created.id)
      toast.success(t('expenses.editor.categoryAdded', { name: isolate(created.name) }))
      close()
      await queryClient.invalidateQueries({ queryKey: trpc.costCategory.list.pathKey() })
    } catch (caught) {
      if (apiErrorCode(caught) === 'name_taken') {
        const [taken] = apiErrorNames(caught)
        setAddError(
          taken ? t('expenses.categories.taken', { name: isolate(taken) }) : t('errors.name_taken'),
        )
      } else setAddError(t(apiErrorKey(caught)))
      input.current?.focus()
    }
  }

  if (adding) {
    return (
      <TextField
        label={<Required>{t('expenses.editor.newCategoryName')}</Required>}
        error={addError ?? undefined}
        render={(a11y) => (
          <div className="flex gap-2">
            <Input
              {...a11y}
              ref={input}
              autoFocus
              autoComplete="off"
              className="min-w-0 flex-1 [unicode-bidi:plaintext]"
              value={name}
              onChange={(event) => {
                setName(event.target.value)
                setAddError(null)
              }}
              onKeyDown={(event) => {
                // Enter adds the category (it never submits the form around it).
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void add()
                }
              }}
            />
            <Button type="button" disabled={create.isPending} onClick={() => void add()}>
              {t('expenses.editor.addCategory')}
            </Button>
            <Button type="button" variant="ghost" disabled={create.isPending} onClick={close}>
              {t('expenses.editor.cancelCategory')}
            </Button>
          </div>
        )}
      />
    )
  }

  return (
    <TextField
      label={<Required>{t('expenses.editor.category')}</Required>}
      error={error}
      render={(a11y) => (
        <NativeSelect
          {...a11y}
          aria-required
          value={value}
          onChange={(event) => {
            if (event.target.value === NEW_CATEGORY) setAdding(true)
            else onChange(event.target.value)
          }}
        >
          <option value="" disabled>
            {t('expenses.editor.categoryPick')}
          </option>
          {options.map((category) => (
            <option key={category.id} value={category.id}>
              {category.archivedAt === null
                ? category.name
                : t('expenses.editor.categoryArchived', { name: category.name })}
            </option>
          ))}
          {canAdd ? <option value={NEW_CATEGORY}>{t('expenses.editor.newCategory')}</option> : null}
        </NativeSelect>
      )}
    />
  )
}
