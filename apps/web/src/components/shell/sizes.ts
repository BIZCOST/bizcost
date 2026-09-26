// Sizes of the business shell (D-089), shared by the shell and by the placeholder shown while a
// business loads (a server component: this module must stay free of client code).

/** The sidebar: a 4.5rem rail from 768px, 16rem with names from 1024px (hidden on phones). */
export const SIDEBAR_WIDTH = 'md:w-[4.5rem] lg:w-64'

/** Room under a page for the phone's tab bar and the home indicator (no tab bar from 768px). */
export const TAB_BAR_PADDING = 'pb-[calc(4.25rem+env(safe-area-inset-bottom))] md:pb-0'

/** One width and padding for every business page. */
export const PAGE_CONTAINER = 'mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8'
