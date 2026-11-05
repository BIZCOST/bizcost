import { ATTACHMENT_MAX_BYTES, feedbackPagePath } from '@bizcost/contracts'
import { describe, expect, it } from 'vitest'
import { pagePathOf, pictureFits } from './feedback-rules'

describe('the page sent with a feedback', () => {
  it('is the path, as the API takes it', () => {
    for (const path of ['/', '/account', '/b/0199a3c2-5b1e-7c3a-9f00-1a2b3c4d5e6f/sales/%D8%A7']) {
      expect(pagePathOf(path)).toBe(path)
      expect(feedbackPagePath.safeParse(path).success, path).toBe(true)
    }
  })

  it('goes as the root when the API would refuse it: a message is never lost to its page', () => {
    for (const path of ['//evil.example', '/a b', `/${'x'.repeat(300)}`, 'relative', '/ق']) {
      expect(pagePathOf(path), path).toBe('/')
      expect(feedbackPagePath.safeParse(path).success, path).toBe(false)
    }
  })

  it('what follows a path never reaches the API', () => {
    expect(feedbackPagePath.safeParse('/b/x?token=secret').success).toBe(false)
    expect(feedbackPagePath.safeParse('/b/x#part').success).toBe(false)
  })
})

describe('a picture', () => {
  it('is a PNG, JPEG or WebP up to the size of a line’s picture', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
      expect(pictureFits({ type, size: 1 }), type).toBe(true)
      expect(pictureFits({ type, size: ATTACHMENT_MAX_BYTES }), type).toBe(true)
      expect(pictureFits({ type, size: ATTACHMENT_MAX_BYTES + 1 }), type).toBe(false)
      expect(pictureFits({ type, size: 0 }), type).toBe(false)
    }
    for (const type of ['image/svg+xml', 'application/pdf', 'text/html', '']) {
      expect(pictureFits({ type, size: 10 }), type).toBe(false)
    }
  })
})
