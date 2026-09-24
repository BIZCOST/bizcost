import { healthDto } from '@bizcost/contracts'
import { publicProcedure } from '../trpc'

/**
 * `health` (public): liveness plus the Vercel function region, checked by the post-deploy smoke test
 * (functions must run in bom1, next to the database).
 */
export const health = publicProcedure.output(healthDto).query(({ ctx }) => ({
  ok: true,
  region: process.env.VERCEL_REGION ?? 'local',
  version: ctx.config.version,
}))
