import { dir, createI18n, type Locale } from '@bizcost/i18n'
import { escapeHtml } from './invitation'
import type { EmailMessage } from './sender'

// The owner's copy of a "Send feedback" (D-356). What people wrote and their names come from users, so
// every value is escaped and isolated. No user text in the subject. The picture stays behind the beta
// page: its signed link would expire in an inbox.

export interface FeedbackEmailInput {
  readonly locale: Locale
  readonly to: string
  readonly message: string
  readonly pagePath: string
  readonly businessName: string | null
  readonly memberName: string | null
  readonly email: string | null
  readonly hasImage: boolean
  /** {APP_URL}/platform */
  readonly link: string
}

const FONT = "'IBM Plex Sans Arabic','IBM Plex Sans','Segoe UI',Tahoma,Arial,sans-serif"

/** First-strong isolate (FSI … PDI): a name keeps its own direction inside the sentence. */
const isolate = (value: string) => `⁨${value}⁩`

export function feedbackEmail(input: FeedbackEmailInput): EmailMessage {
  const i18n = createI18n({ locale: input.locale, namespaces: ['emails'] })
  const t = i18n.t.bind(i18n)
  const direction = dir(input.locale)
  const align = direction === 'rtl' ? 'right' : 'left'
  const who = [input.memberName, input.email].filter(Boolean).join(' · ')
  const business = input.businessName ?? t('emails.feedback.noBusiness')
  const rows = [
    [t('emails.feedback.business'), business],
    [t('emails.feedback.member'), who],
    [t('emails.feedback.page'), input.pagePath],
  ] as const
  const htmlRows = rows
    .map(
      ([label, value]) =>
        `<p style="margin:0 0 4px 0;font-size:14px;line-height:22px;"><strong>${escapeHtml(label)}:</strong> <bdi>${escapeHtml(value)}</bdi></p>`,
    )
    .join('')
  const message = escapeHtml(input.message).replace(/\r?\n/g, '<br>')
  const link = escapeHtml(input.link)
  const html = `<!DOCTYPE html>
<html lang="${input.locale}" dir="${direction}">
  <head><meta charset="utf-8"><title>${escapeHtml(t('emails.feedback.subject'))}</title></head>
  <body style="margin:0;padding:24px;background-color:#F5F7FA;">
    <div dir="${direction}" style="max-width:560px;margin:0 auto;padding:24px;background-color:#FFFFFF;border:1px solid #E1E6ED;border-radius:12px;font-family:${FONT};color:#101828;text-align:${align};">
      <h1 style="margin:0 0 16px 0;font-size:20px;line-height:28px;">${escapeHtml(t('emails.feedback.title'))}</h1>
      ${htmlRows}
      <div dir="auto" style="margin:16px 0;padding:12px;background-color:#F5F7FA;border-radius:8px;font-size:15px;line-height:24px;">${message}</div>
      ${input.hasImage ? `<p style="margin:0 0 12px 0;font-size:14px;color:#5B6676;">${escapeHtml(t('emails.feedback.picture'))}</p>` : ''}
      <p style="margin:0;font-size:14px;"><a href="${link}" style="color:#0B4F8F;">${escapeHtml(t('emails.feedback.open'))}</a></p>
    </div>
  </body>
</html>
`
  const text = [
    t('emails.feedback.title'),
    '',
    ...rows.map(([label, value]) => `${label}: ${isolate(value)}`),
    '',
    input.message,
    '',
    ...(input.hasImage ? [t('emails.feedback.picture'), ''] : []),
    `${t('emails.feedback.open')}: ${input.link}`,
  ].join('\n')
  return {
    to: input.to,
    subject: t('emails.feedback.subject'),
    html,
    text,
    ...(input.email ? { replyTo: input.email } : {}),
  }
}
