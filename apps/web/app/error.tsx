'use client'

import { LanguageMenu } from '@/components/language-menu'
import { ErrorState } from '@/components/states/error-state'

// Unexpected rendering errors outside a business page (the business pages have their own boundary,
// inside the shell). Never shows the error's text (it may hold server details).
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <div className="flex min-h-[60dvh] flex-col">
      <div className="flex justify-end px-4 pt-4 sm:px-8 sm:pt-6">
        <LanguageMenu />
      </div>
      <main className="flex flex-1 flex-col items-center justify-center">
        <ErrorState onRetry={reset} card={false} />
      </main>
    </div>
  )
}
