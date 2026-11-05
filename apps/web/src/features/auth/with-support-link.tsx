import { SUPPORT_EMAIL } from '@bizcost/contracts'

/**
 * A message with the support address in it, with that address as a link: for someone refused at sign-up
 * it is the only next step, and on a phone copying it by hand is hard (D-355).
 */
export function WithSupportLink({ text }: { text: string }) {
  const at = text.indexOf(SUPPORT_EMAIL)
  if (at < 0) return text
  return (
    <>
      {text.slice(0, at)}
      <a
        dir="ltr"
        href={`mailto:${SUPPORT_EMAIL}`}
        className="tap-area font-medium underline underline-offset-2"
      >
        {SUPPORT_EMAIL}
      </a>
      {text.slice(at + SUPPORT_EMAIL.length)}
    </>
  )
}
