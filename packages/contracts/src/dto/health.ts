import { z } from 'zod'

/** `health` (public). `region` is the Vercel function region ('local' outside Vercel). */
export const healthDto = z.object({
  ok: z.boolean(),
  region: z.string(),
  version: z.string(),
})
export type HealthDto = z.infer<typeof healthDto>
