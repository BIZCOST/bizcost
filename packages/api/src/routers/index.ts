import { router } from '../trpc'
import { accountRouter } from './account'
import { businessRouter } from './business'
import { health } from './health'
import { me } from './me'

/** The API of Steps 2–3. Routers of each module arrive with the module (no placeholders). */
export const appRouter = router({
  health,
  me,
  account: accountRouter,
  business: businessRouter,
})

export type AppRouter = typeof appRouter
