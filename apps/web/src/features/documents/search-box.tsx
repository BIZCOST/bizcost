'use client'

import { SearchIcon, XIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'

// The search of a document list (purchases, expenses, sales), kept in the address by its page.

const SEARCH_DELAY_MS = 300

/** A search box that searches a moment after typing, and on Enter. */
export function SearchBox({
  value,
  placeholder,
  onChange,
}: {
  value: string
  /** What can be searched ("Search by reference or supplier"). */
  placeholder: string
  onChange: (search: string) => void
}) {
  const { t } = useTranslation()
  const [text, setText] = useState(value)
  const typed = useRef(value)
  const change = useRef(onChange)
  useEffect(() => {
    change.current = onChange
  })
  // The address changed without typing (back, a link): show its search.
  useEffect(() => {
    if (value !== typed.current.trim()) {
      typed.current = value
      setText(value)
    }
  }, [value])
  useEffect(() => {
    if (text.trim() === value) return
    const timer = setTimeout(() => change.current(text), SEARCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [text, value])
  return (
    <div role="search" className="relative min-w-0 flex-1">
      <SearchIcon
        aria-hidden
        className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        type="search"
        aria-label={t('catalog.list.searchLabel')}
        placeholder={placeholder}
        autoComplete="off"
        enterKeyHint="search"
        value={text}
        onChange={(event) => {
          typed.current = event.target.value
          setText(event.target.value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onChange(text)
        }}
        className="ps-9 pe-11 [unicode-bidi:plaintext] [&::-webkit-search-cancel-button]:hidden"
      />
      {text ? (
        <button
          type="button"
          aria-label={t('catalog.list.clearSearch')}
          onClick={() => {
            typed.current = ''
            setText('')
            onChange('')
          }}
          className="absolute end-0 top-0 flex size-11 items-center justify-center rounded-lg text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring"
        >
          <XIcon aria-hidden className="size-4" />
        </button>
      ) : null}
    </div>
  )
}
