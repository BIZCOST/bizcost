import { useEffect, useState, useSyncExternalStore, type DependencyList } from 'react'
import { secondsUntil } from './auth/code'
import type { Flow } from './flow'

/** The state type of a flow. */
export type FlowState<F> = F extends Flow<infer S> ? S : never

/** The current state of a flow; re-renders on every change. */
export function useFlowState<S>(flow: Flow<S>): S {
  return useSyncExternalStore(flow.subscribe, flow.getState, flow.getState)
}

function sameDeps(a: DependencyList, b: DependencyList): boolean {
  return a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
}

/**
 * Creates a flow and keeps it until one of `deps` (the inputs of `create`, e.g. the email) changes;
 * returns its state and the flow:
 * `const [state, flow] = useFlow(() => createCodeVerification({ auth, email, purpose }), [email])`.
 * The flow is started (`Flow.start`) while the component is mounted, and stopped when it unmounts or
 * is replaced.
 */
export function useFlow<F extends Flow<unknown>>(
  create: () => F,
  deps: DependencyList,
): [FlowState<F>, F] {
  const [current, setCurrent] = useState(() => ({ deps, flow: create() }))
  let flow = current.flow
  if (!sameDeps(current.deps, deps)) {
    // New inputs: start a new flow (React's "adjust state while rendering" pattern).
    flow = create()
    setCurrent({ deps, flow })
  }
  useEffect(() => flow.start?.(), [flow])
  return [useFlowState(flow) as FlowState<F>, flow]
}

/** Seconds left until `until` (epoch ms), updated every second; 0 once it has passed. */
export function useCountdown(until: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    if (until <= Date.now()) return
    const id = setInterval(() => {
      const current = Date.now()
      setNow(current)
      if (current >= until) clearInterval(id)
    }, 1000)
    return () => clearInterval(id)
  }, [until])
  return secondsUntil(until, now)
}
