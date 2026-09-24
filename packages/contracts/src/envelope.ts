import { z } from 'zod'

// Outputs that contain sensitive fields are wrapped as { data, meta }: meta.redacted lists the dotted
// paths the server removed, so the UI shows a lock instead of a misleading 0.

export const redactionMetaDto = z.object({ redacted: z.array(z.string()) })
export type RedactionMeta = z.infer<typeof redactionMetaDto>

const envelopes = z.registry<{ readonly envelope: true }>()

export function withMeta<T extends z.ZodType>(data: T) {
  const envelope = z.object({ data, meta: redactionMetaDto })
  envelopes.add(envelope, { envelope: true })
  return envelope
}

/** True for a schema built by withMeta(). */
export function isWithMeta(schema: z.core.$ZodType): boolean {
  return envelopes.has(schema)
}

export interface WithMeta<T> {
  data: T
  meta: RedactionMeta
}
