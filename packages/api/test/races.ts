import type { Db } from '@bizcost/db'
import type postgres from 'postgres'
import { expect } from 'vitest'
import {
  connectAdmin,
  connectApi,
  handlerFor,
  mutate,
  SECRET_KEY,
  type Admin,
  type CallResult,
} from './helpers'
import type { Handler, Person } from './purchasing'

// Calls that really run at the same time (the concurrency suites, D-110, D-228, D-265): several API
// instances, each with its own database connection like separate serverless functions (one instance
// runs its calls one after another, so calls spread over instances are what overlap). `interleaved`
// forces an order: an admin connection holds a row one call needs, the calls start one after the
// other on their own instances, each once the ones before it wait on a lock (pg_locks), then the
// holder commits and they all finish.

/** Whose call: a business and the person calling in it. */
export interface Caller {
  readonly id: string
  readonly owner: Person
}

export type Holder = (sql: postgres.TransactionSql) => Promise<unknown>
export type Run = (instance: number) => Promise<CallResult<unknown>>

export class Races {
  readonly dbs: Db[]
  readonly handlers: Handler[]

  constructor(
    private readonly admin: Admin,
    readonly instances: number,
  ) {
    this.dbs = Array.from({ length: instances }, () => connectApi())
    this.handlers = this.dbs.map((db) =>
      handlerFor(db, undefined, { supabaseSecretKey: SECRET_KEY }),
    )
  }

  /** A call as `person` (the business's owner unless said) on instance `i` (its own connection). */
  call<T = unknown>(
    scope: Caller,
    i: number,
    path: string,
    input: object,
    person: Person = scope.owner,
  ): Promise<CallResult<T>> {
    return mutate<T>(this.handlers[i % this.instances]!, path, {
      token: person.token,
      businessId: scope.id,
      input,
    })
  }

  /** The database backend of instance `i`'s connection (its pool has one). */
  async backendOf(i: number): Promise<number> {
    const [row] = await this.dbs[i % this.instances]!.$client<
      { pid: number }[]
    >`select pg_backend_pid() as pid`
    return row!.pid
  }

  /** Waits until `count` of these backends wait on a lock (30 s at most). */
  async untilWaiting(pids: readonly number[], count: number, what: string): Promise<void> {
    for (let tries = 0; tries < 600; tries++) {
      const [row] = await this.admin<{ n: number }[]>`
        select count(distinct pid)::int as n from pg_locks
         where not granted and pid = any(${`{${pids.join(',')}}`}::int[])`
      if (row!.n >= count) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`${what}: ${count} calls were expected to wait on a lock`)
  }

  /**
   * `hold` takes its locks in an admin transaction; each of `runs` starts on its own instance once
   * the ones before it wait; when all wait, the holder commits. Their results, none refused.
   */
  async interleaved(
    what: string,
    hold: Holder,
    runs: readonly Run[],
  ): Promise<CallResult<unknown>[]> {
    const holder = connectAdmin()
    try {
      let release!: () => void
      const released = new Promise<void>((resolve) => (release = resolve))
      let holding!: () => void
      const held = new Promise<void>((resolve) => (holding = resolve))
      const transaction = holder.begin(async (sql) => {
        await hold(sql)
        holding()
        await released
      })
      await held
      const running: Promise<CallResult<unknown>>[] = []
      try {
        const pids = await Promise.all(runs.map((_, i) => this.backendOf(i)))
        for (const [i, run] of runs.entries()) {
          running.push(run(i))
          await this.untilWaiting(pids.slice(0, i + 1), i + 1, what)
        }
      } finally {
        // Also when a call never waited: the holder commits, so nothing is left hanging.
        release()
        await transaction
      }
      const results = await Promise.all(running)
      expect(
        results.filter((r) => r.error).map((r) => `${r.error?.data.appCode} ${r.error?.message}`),
        what,
      ).toEqual([])
      return results
    } finally {
      await holder.end()
    }
  }

  async close(): Promise<void> {
    for (const db of this.dbs) await db.$client.end()
  }
}

/**
 * The deadlocks Postgres has detected in this database so far (pg_stat_database): a race that ends
 * with the same count had none. A deadlock comes back to the caller as CONFLICT, like a stale
 * version, so the count tells them apart.
 */
export async function deadlocks(admin: Admin): Promise<number> {
  const [row] = await admin<{ n: number }[]>`
    select deadlocks::int as n from pg_stat_database where datname = current_database()`
  return row!.n
}

/** What each call came back with: `ok`, or the refusal's app code. */
export function outcomesOf(results: readonly CallResult<unknown>[]): string[] {
  return results.map((r) => (r.error ? (r.error.data.appCode ?? 'unknown') : 'ok'))
}
