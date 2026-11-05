import {
  ATTACHMENT_MAX_BYTES,
  FEEDBACK_IMAGE_TYPES,
  FEEDBACK_PAGE_PATH_MAX_LENGTH,
} from '@bizcost/contracts'

// What "Send feedback" checks before it sends anything. The server checks the same and more.

/** The characters the API takes in a page's path. */
const PATH = /^\/(?!\/)[A-Za-z0-9._~%/-]*$/

/**
 * What is sent as the page: `location.pathname` alone. A path the API would refuse (too long, or with
 * something unusual in it) must not lose someone's message, so it goes as the app's root.
 */
export function pagePathOf(pathname: string): string {
  return PATH.test(pathname) && pathname.length <= FEEDBACK_PAGE_PATH_MAX_LENGTH ? pathname : '/'
}

/** A picture the API may take: its type and size (the API then reads the file itself). */
export function pictureFits(file: Pick<File, 'type' | 'size'>): boolean {
  return (
    (FEEDBACK_IMAGE_TYPES as readonly string[]).includes(file.type) &&
    file.size > 0 &&
    file.size <= ATTACHMENT_MAX_BYTES
  )
}
