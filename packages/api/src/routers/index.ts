import { router } from '../trpc'
import { businessRouter } from './business'
import { health } from './health'
import { me } from './me'

/** The API of Step 2. Routers of each module arrive with the module (no placeholders). */
export const appRouter = router({
  health,
  me,
  business: businessRouter,
})

export type AppRouter = typeof appRouter
