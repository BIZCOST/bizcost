'use client'

import { FilePenLineIcon } from 'lucide-react'
import { usePathname, useRouter } from 'next/navigation'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { leavingTo } from './unsaved'

// Changes not saved are never lost without asking (the owner's request of 2026-09-29): every form
// with changes registers a guard (useUnsavedChanges). Leaving it asks "You have unsaved changes"
// with Save (saves, then leaves; a failed save stays and the form says why), Don't save (leaves) and
// Keep editing:
//   - closing a sheet or a dialog (×, Escape, a tap beside it, Cancel): the form asks through
//     `requestLeave`;
//   - a link of the app (the sidebar, the tab bar, a link in the page): a click is caught before the
//     link navigates (a capture listener on window: the Next.js link sees the click prevented);
//   - navigation in code (the business switcher, sign out): `useConfirmLeave`;
//   - the browser's Back button: while a form has changes, a copy of the page's history entry is on
//     top (a "sentinel"), so Back stays on the page and asks; leaving goes back for real. Over an
//     open sheet or dialog, Back is about it alone (as a phone's Back is): one with changes asks
//     and, once left, closes; one without closes at once; the page stays either way. A later
//     page is opened from the sentinel itself (never after going back to the page's own entry: a
//     Next.js navigation started while it restores that entry is lost), and Back skips the entries
//     the guard left behind: a sentinel, and the page's own entry once its sentinel was replaced by
//     another page (a new purchase that opens as its draft);
//   - closing the tab or reloading: the browser's own question (beforeunload).
// Nothing asks when nothing changed, or once the changes are saved. Leaving a page where several
// forms have changes (two settings sections) asks once for all of them: Save saves each, the newest
// first, and stays at the first that could not be saved.

interface Guard {
  readonly id: string
  readonly dirty: () => boolean
  readonly save: () => Promise<boolean>
  /** A sheet's or dialog's: closes it (what Back does over it). */
  readonly close?: () => void
}

interface Registry {
  register: (guard: Guard) => () => void
  /** A guard's changes appeared or went. */
  changed: () => void
  /**
   * Asks once about the changes of every guard (or only of guard `only`): true when the person chose
   * to leave (after saving, or without).
   */
  confirmLeave: (only?: string) => Promise<boolean>
  /** Before an in-app navigation that leaves the page (it opens from the Back sentinel). */
  beforeNavigate: () => Promise<void>
}

const UnsavedContext = createContext<Registry | null>(null)

/** Marks the history entry the guard adds on top of a page with changes. */
const SENTINEL = '__bizcostUnsaved'
/** Marks the page's own entry under a sentinel (skipped by Back once another page replaced it). */
const UNDER = '__bizcostUnder'

interface Asking {
  /** The newest first. */
  readonly guards: readonly Guard[]
  readonly answer: (leave: boolean) => void
}

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const router = useRouter()
  const pathname = usePathname()
  const guards = useRef<Guard[]>([])
  // Guards the person already chose to leave (until they unmount).
  const released = useRef(new Set<string>())
  // The Back sentinel: whether the current entry is one we added (and for which address), and a
  // skip of an entry left behind in progress.
  const sentinel = useRef({ on: false, href: '', skipping: false })
  const [asking, setAsking] = useState<Asking | null>(null)
  const [saving, setSaving] = useState(false)

  const dirtyGuards = useCallback(
    () => guards.current.filter((guard) => !released.current.has(guard.id) && guard.dirty()),
    [],
  )

  const arm = useCallback(() => {
    if (dirtyGuards().length === 0) return
    const current = sentinel.current
    if (current.on && current.href === window.location.href) return
    // The page's own entry is marked (Next.js keeps a state that has its own marks as it is), then
    // the sentinel pushed without an address: Next.js copies its state into it and keeps the page.
    const state = (window.history.state ?? {}) as Record<string, unknown>
    if (state[UNDER] !== true) window.history.replaceState({ ...state, [UNDER]: true }, '')
    window.history.pushState({ [SENTINEL]: true }, '')
    current.on = true
    current.href = window.location.href
  }, [dirtyGuards])

  const confirmLeave = useCallback(
    async (only?: string) => {
      const pending = dirtyGuards()
        .filter((guard) => only === undefined || guard.id === only)
        .reverse()
      if (pending.length === 0) return true
      const leave = await new Promise<boolean>((answer) => setAsking({ guards: pending, answer }))
      if (!leave) return false
      for (const guard of pending) released.current.add(guard.id)
      return true
    },
    [dirtyGuards],
  )

  const beforeNavigate = useCallback(() => {
    // The next page opens from the sentinel (pushed after it, or in its place); Back skips it.
    sentinel.current.on = false
    return Promise.resolve()
  }, [])

  const registry = useMemo<Registry>(
    () => ({
      register(guard) {
        guards.current = [...guards.current, guard]
        return () => {
          guards.current = guards.current.filter((g) => g !== guard)
          released.current.delete(guard.id)
        }
      },
      changed: arm,
      confirmLeave,
      beforeNavigate,
    }),
    [arm, confirmLeave, beforeNavigate],
  )

  // Links of the app: caught before they navigate.
  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (event.defaultPrevented || !(event.target instanceof Element)) return
      const anchor = event.target.closest('a[href]')
      if (!(anchor instanceof HTMLAnchorElement)) return
      const to = leavingTo(
        {
          href: anchor.href,
          target: anchor.target,
          download: anchor.hasAttribute('download'),
          modified:
            event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey,
        },
        window.location.href,
      )
      if (to === null || dirtyGuards().length === 0) return
      event.preventDefault()
      void (async () => {
        // A save that just finished may still be reaching its form (data a query sends it a
        // moment later): looked at again once that is in, so a saved form is not asked about.
        await new Promise((resolve) => setTimeout(resolve))
        if (!(await confirmLeave())) return
        await beforeNavigate()
        router.push(to)
      })()
    }
    window.addEventListener('click', onClick, true)
    return () => window.removeEventListener('click', onClick, true)
  }, [router, dirtyGuards, confirmLeave, beforeNavigate])

  // The Back button (see above). Next.js restores the page's own entry first (the same page).
  useEffect(() => {
    function onPopState(event: PopStateEvent) {
      const current = sentinel.current
      const state = event.state as Record<string, unknown> | null
      const onSentinel = state?.[SENTINEL] === true
      const leftSentinel = current.on && !onSentinel && window.location.href === current.href
      current.on = onSentinel
      if (onSentinel) current.href = window.location.href
      if (current.skipping) {
        current.skipping = false
        return
      }
      if (onSentinel) {
        // A sentinel left behind, reached from a later page: skip it (to the page's own entry).
        if (dirtyGuards().length === 0) {
          current.skipping = true
          window.history.back()
        }
        return
      }
      if (leftSentinel) {
        if (dirtyGuards().length === 0) {
          // Saved since: go back as the person asked.
          window.history.back()
          return
        }
        // An open sheet or dialog (the newest guard that closes: one says how only while open):
        // Back is about it alone. It closes (once left, when it has changes), and the page stays,
        // its sentinel put back while the page still has changes.
        const top = guards.current
          .filter((guard) => guard.close !== undefined && !released.current.has(guard.id))
          .at(-1)
        const close = top?.close
        if (top && close) {
          if (!top.dirty()) {
            close()
            arm()
            return
          }
          void confirmLeave(top.id).then((leave) => {
            if (leave) close()
            arm()
          })
          return
        }
        void confirmLeave().then((leave) => {
          if (leave) window.history.back()
          else arm()
        })
        return
      }
      // A page's own entry whose sentinel another page took the place of: skip it.
      if (state?.[UNDER] === true) {
        current.skipping = true
        window.history.back()
      }
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [arm, confirmLeave, dirtyGuards])

  // Another page: a sentinel of the page before is not this page's.
  useEffect(() => {
    const current = sentinel.current
    if (current.on && current.href !== window.location.href) current.on = false
  }, [pathname])

  // Closing the tab or reloading: the browser asks.
  useEffect(() => {
    function onBeforeUnload(event: BeforeUnloadEvent) {
      if (dirtyGuards().length === 0) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirtyGuards])

  function answer(leave: boolean) {
    if (!asking) return
    setAsking(null)
    asking.answer(leave)
  }

  async function saveAndLeave() {
    if (!asking || saving) return
    setSaving(true)
    let saved = true
    for (const guard of asking.guards) {
      try {
        saved = await guard.save()
      } catch {
        saved = false
      }
      // A failed save stays: the form says what went wrong (those saved before it are saved).
      if (!saved) break
    }
    setSaving(false)
    answer(saved)
  }

  return (
    <UnsavedContext.Provider value={registry}>
      {children}
      <AlertDialog
        open={asking !== null}
        onOpenChange={(open) => !open && !saving && answer(false)}
      >
        <AlertDialogContent
          data-unsaved-dialog
          className="data-[size=default]:max-w-sm data-[size=default]:sm:max-w-md"
        >
          <AlertDialogHeader>
            <AlertDialogMedia>
              <FilePenLineIcon />
            </AlertDialogMedia>
            <AlertDialogTitle>{t('unsaved.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('unsaved.body')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" disabled={saving} onClick={() => answer(false)}>
              {t('unsaved.keepEditing')}
            </Button>
            <Button variant="destructive" disabled={saving} onClick={() => answer(true)}>
              {t('unsaved.discard')}
            </Button>
            <Button disabled={saving} onClick={() => void saveAndLeave()}>
              {saving ? t('status.saving') : t('unsaved.save')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </UnsavedContext.Provider>
  )
}

/**
 * Registers a form's changes with the guard while it is shown. `dirty`: its state differs from what
 * it started with (or last saved). `save`: saves it without leaving; true once saved, false when it
 * could not be (the form shows why). `close`: a sheet's or dialog's, how it closes (the browser's
 * Back closes it, asking first when it has changes). Returns `requestLeave`, for the form's own ways
 * out (a sheet's ×, Escape, a tap beside it, Cancel): it runs `leave` at once when nothing changed,
 * else once the person chose to leave.
 */
export function useUnsavedChanges({
  dirty,
  save,
  close,
}: {
  dirty: boolean
  save: () => Promise<boolean>
  close?: () => void
}): { requestLeave: (leave: () => void) => void } {
  const registry = useContext(UnsavedContext)
  const id = useId()
  const latest = useRef({ dirty, save, close })
  // Before the browser paints: a form shown saved is never asked about.
  useLayoutEffect(() => {
    latest.current = { dirty, save, close }
  })
  const closes = close !== undefined
  useEffect(
    () =>
      registry?.register({
        id,
        dirty: () => latest.current.dirty,
        save: () => latest.current.save(),
        close: closes ? () => latest.current.close?.() : undefined,
      }),
    [registry, id, closes],
  )
  useEffect(() => {
    if (dirty) registry?.changed()
  }, [registry, dirty])
  const requestLeave = useCallback(
    (leave: () => void) => {
      if (!registry || !latest.current.dirty) {
        leave()
        return
      }
      void registry.confirmLeave(id).then((ok) => ok && leave())
    },
    [registry, id],
  )
  return { requestLeave }
}

/**
 * Before a form navigates in code once its changes are saved (a new purchase opening as its draft):
 * drops the Back sentinel, so the new address takes the page's own history entry.
 */
export function useBeforeNavigate(): () => Promise<void> {
  const registry = useContext(UnsavedContext)
  return useCallback(() => registry?.beforeNavigate() ?? Promise.resolve(), [registry])
}

/**
 * For navigation in code (the business switcher, sign out): resolves true when the page may be left
 * (nothing unsaved, or the person chose), after dropping the Back sentinel.
 */
export function useConfirmLeave(): () => Promise<boolean> {
  const registry = useContext(UnsavedContext)
  return useCallback(async () => {
    if (!registry) return true
    if (!(await registry.confirmLeave())) return false
    await registry.beforeNavigate()
    return true
  }, [registry])
}
