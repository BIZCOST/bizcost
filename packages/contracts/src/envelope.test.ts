import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { isWithMeta, redactionMetaDto, withMeta, type WithMeta } from './envelope'

describe('withMeta / isWithMeta', () => {
  it('recognizes envelopes built by withMeta only', () => {
    const data = z.object({ name: z.string() })
    expect(isWithMeta(withMeta(data))).toBe(true)
    expect(isWithMeta(data)).toBe(false)
    expect(isWithMeta(z.object({ data, meta: redactionMetaDto }))).toBe(false)
  })

  it('infers { data, meta: { redacted } }', () => {
    const envelope = withMeta(z.object({ name: z.string() }))
    const value: WithMeta<{ name: string }> = envelope.parse({
      data: { name: 'x' },
      meta: { redacted: ['a.b'] },
    })
    expect(value.meta.redacted).toEqual(['a.b'])
  })
})
