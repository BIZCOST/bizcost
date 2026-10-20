'use client'

import type { BusinessContextDto } from '@bizcost/contracts'
import { useTranslation } from 'react-i18next'
import { TextField } from '@/components/form/text-field'
import { NativeSelect } from '@/components/ui/native-select'
import { useDocumentLocations } from '@/features/sales/data'

/**
 * The branch a quotation, or an invoice made from scratch, is for (Q12; Release B's capability
 * audit), asked as the order and sale editors ask it: only with branches on and more than one branch
 * the member works in (the list `sale.daySheet` gives a member who enters sales, so a member limited
 * to some branches gets only theirs; read on one of the business's channels when it has several,
 * useDocumentLocations). Left as it shows, the draft keeps no branch of its own and goes to the
 * member's first branch or the default one, as the API places it. An invoice made from a quotation, an
 * order or a sale keeps its source's branch (D-314), so it is never asked there.
 */
export function BranchField({
  context,
  today,
  value,
  onChange,
}: {
  context: BusinessContextDto
  today: string
  value: string | null
  onChange: (locationId: string | null) => void
}) {
  const { t } = useTranslation()
  const locations = useDocumentLocations(context, today)
  if (!locations || locations.length <= 1) return null
  return (
    <TextField
      label={t('sales.editor.location')}
      render={(a11y) => (
        <NativeSelect
          {...a11y}
          data-document-branch
          value={value ?? locations.find((location) => location.isDefault)?.id ?? locations[0]!.id}
          onChange={(event) => onChange(event.target.value || null)}
        >
          {locations.map((location) => (
            <option key={location.id} value={location.id}>
              {location.name}
            </option>
          ))}
        </NativeSelect>
      )}
    />
  )
}
