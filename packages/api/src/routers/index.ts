import { router } from '../trpc'
import { accountRouter } from './account'
import { businessRouter } from './business'
import { health } from './health'
import { invitationRouter } from './invitation'
import { locationRouter } from './location'
import { me } from './me'
import { memberRouter } from './member'
import { roleRouter } from './role'

/** The API of Steps 2–6. Routers of each module arrive with the module (no placeholders). */
export const appRouter = router({
  health,
  me,
  account: accountRouter,
  business: businessRouter,
  location: locationRouter,
  member: memberRouter,
  invitation: invitationRouter,
  role: roleRouter,
})

export type AppRouter = typeof appRouter
