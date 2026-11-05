import { AppError } from '../errors'

// One person's share of a picture's check (D-362). A check downloads up to 10 MB and queues for the PDF
// compiler, whose queue is one per instance and shared with every business's PDFs. Without this, one
// person sending many pictures at once could hold that memory and fill that queue, and everyone else on
// the instance would be told to wait. The app sends one at a time, so a person never meets the limit by
// using it. Per instance, like the queue it protects.

/** More than the app ever sends at once, and few enough of the queue's 24 places (PDF_MAX_QUEUED). */
export const PICTURE_CHECKS_PER_PERSON = 4

const running = new Map<string, number>()

/** Runs one check, or answers RATE_LIMITED at once while this person has too many going. */
export async function withPictureCheckSlot<T>(userId: string, check: () => Promise<T>): Promise<T> {
  const before = running.get(userId) ?? 0
  if (before >= PICTURE_CHECKS_PER_PERSON) {
    throw new AppError('rate_limited', { message: 'too many pictures being checked at once' })
  }
  running.set(userId, before + 1)
  try {
    return await check()
  } finally {
    const left = (running.get(userId) ?? 1) - 1
    if (left > 0) running.set(userId, left)
    else running.delete(userId)
  }
}
