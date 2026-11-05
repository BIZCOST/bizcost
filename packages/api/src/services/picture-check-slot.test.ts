import { describe, expect, it } from 'vitest'
import { AppError } from '../errors'
import { PICTURE_CHECKS_PER_PERSON, withPictureCheckSlot } from './picture-check-slot'

/** A check that stays open until it is told to end. */
function heldCheck() {
  let finish: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    finish = resolve
  })
  return { held, finish }
}

const code = (error: unknown) => (error instanceof AppError ? error.appCode : String(error))

describe('withPictureCheckSlot (D-362)', () => {
  it('lets one person run so many at once, refuses the next at once, and frees them after', async () => {
    const { held, finish } = heldCheck()
    const open = Array.from({ length: PICTURE_CHECKS_PER_PERSON }, () =>
      withPictureCheckSlot('person-a', () => held),
    )
    await expect(
      withPictureCheckSlot('person-a', () => Promise.resolve('never')).catch(code),
    ).resolves.toBe('rate_limited')
    finish()
    await Promise.all(open)
    await expect(withPictureCheckSlot('person-a', () => Promise.resolve('ok'))).resolves.toBe('ok')
  })

  it('never takes anything from someone else', async () => {
    const { held, finish } = heldCheck()
    const open = Array.from({ length: PICTURE_CHECKS_PER_PERSON }, () =>
      withPictureCheckSlot('person-b', () => held),
    )
    await expect(withPictureCheckSlot('person-c', () => Promise.resolve('ok'))).resolves.toBe('ok')
    finish()
    await Promise.all(open)
  })

  it('frees its place when the check fails', async () => {
    for (let i = 0; i < PICTURE_CHECKS_PER_PERSON + 2; i += 1) {
      await expect(
        withPictureCheckSlot('person-d', () => Promise.reject(new Error('refused'))),
      ).rejects.toThrow('refused')
    }
    await expect(withPictureCheckSlot('person-d', () => Promise.resolve('ok'))).resolves.toBe('ok')
  })
})
