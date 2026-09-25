// A flow is a pure reducer plus a small controller that runs the async steps and dispatches events.
// Screens read its state through `useFlowState` (React) or `subscribe` (anything else).

export interface Flow<S> {
  getState(): S
  /** Calls `listener` after every state change; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void
  /**
   * Lets the flow do timed work of its own (the one automatic resend of a code screen, D-073) until
   * the returned function is called. `useFlow` starts it while the screen is shown, so leaving the
   * page cancels that work. Flows without such work leave it out.
   */
  start?(): () => void
}

export interface FlowStore<S, E> extends Flow<S> {
  /** Applies the reducer; returns false when the event changed nothing (e.g. a double submit). */
  dispatch(event: E): boolean
}

export function createFlowStore<S, E>(
  reducer: (state: S, event: E) => S,
  initial: S,
): FlowStore<S, E> {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispatch(event) {
      const next = reducer(state, event)
      if (next === state) return false
      state = next
      for (const listener of [...listeners]) listener()
      return true
    },
  }
}
