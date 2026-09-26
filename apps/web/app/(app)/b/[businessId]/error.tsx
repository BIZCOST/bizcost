'use client'

import { PageContainer } from '@/components/shell/page-container'
import { ErrorState } from '@/components/states/error-state'

// An unexpected error on a business page: said inside the shell, so the sections stay at hand.
export default function BusinessError({ reset }: { reset: () => void }) {
  return (
    <PageContainer>
      <ErrorState onRetry={reset} card />
    </PageContainer>
  )
}
