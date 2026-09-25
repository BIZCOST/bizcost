import { dir, createI18n, type Locale } from '@bizcost/i18n'
import type { EmailMessage } from './sender'

// The invitation email (Settings → Team). Bilingual through the `emails` namespace, with inline styles
// and the brand of supabase/templates (D-068): the logo bars, one white card, the brand blue. Names
// come from users, so every value is HTML-escaped and isolated (<bdi>) inside the HTML part; the plain
// text part wraps them in Unicode isolates so an English name reads right in an Arabic sentence.

export interface InvitationEmailInput {
  readonly locale: Locale
  readonly to: string
  readonly businessName: string
  /** The inviter's name in the business; null leaves the sentence without it. */
  readonly inviterName: string | null
  /** The role's name in the email's language (a template's translated name, else the role name). */
  readonly roleLabel: string
  /** {APP_URL}/invite/{token} */
  readonly link: string
}

const FONT = "'IBM Plex Sans Arabic','IBM Plex Sans','Segoe UI',Tahoma,Arial,sans-serif"
const BRAND = '#0B4F8F'
const INK = '#101828'
const MUTED = '#5B6676'
const LINE = '#E1E6ED'
const PAGE = '#F5F7FA'

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** First-strong isolate (FSI … PDI): a name keeps its own direction inside the sentence. */
const isolate = (value: string) => `⁨${value}⁩`
/** Left-to-right isolate (LRI … PDI): emails and links. */
const ltr = (value: string) => `⁦${value}⁩`
const bdi = (value: string) => `<bdi>${escapeHtml(value)}</bdi>`
const bdiLtr = (value: string) =>
  `<bdi dir="ltr" style="white-space:nowrap;">${escapeHtml(value)}</bdi>`

const BAR = (height: number, last = false) =>
  `<td valign="bottom" style="padding:0 ${last ? 0 : 4}px 5px 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="8" height="${height}" bgcolor="${BRAND}" style="width:8px;height:${height}px;background-color:${BRAND};border-radius:2px 2px 0 0;font-size:0;line-height:0;">&nbsp;</td></tr></table></td>`

export function invitationEmail(input: InvitationEmailInput): EmailMessage {
  const i18n = createI18n({ locale: input.locale, namespaces: ['emails'] })
  const t = i18n.t.bind(i18n)
  const direction = dir(input.locale)
  const align = direction === 'rtl' ? 'right' : 'left'
  const hasInviter = input.inviterName !== null && input.inviterName.trim() !== ''
  const inviter = input.inviterName ?? ''

  const subject = hasInviter
    ? t('emails.invitation.subject', { inviter, business: input.businessName })
    : t('emails.invitation.subjectNoInviter', { business: input.businessName })

  const html = {
    title: t('emails.invitation.title', { business: bdi(input.businessName) }),
    body: hasInviter
      ? t('emails.invitation.body', {
          inviter: bdi(inviter),
          business: bdi(input.businessName),
          role: bdi(input.roleLabel),
        })
      : t('emails.invitation.bodyNoInviter', {
          business: bdi(input.businessName),
          role: bdi(input.roleLabel),
        }),
    expiry: t('emails.invitation.expiry', { email: bdiLtr(input.to) }),
  }
  const link = escapeHtml(input.link)

  const htmlBody = `<!DOCTYPE html>
<html lang="${input.locale}" dir="${direction}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light only">
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background-color:${PAGE};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAGE}" style="background-color:${PAGE};">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;">
            <tr>
              <td align="center" dir="ltr" style="padding:0 0 20px 0;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    ${BAR(11)}${BAR(19)}${BAR(28, true)}
                    <td valign="bottom" style="padding:0 0 0 6px;font-family:${FONT};font-size:28px;line-height:34px;font-weight:700;color:${INK};">BizCost</td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td dir="${direction}" align="${align}" bgcolor="#FFFFFF" style="padding:32px 24px;background-color:#FFFFFF;border:1px solid ${LINE};border-radius:12px;font-family:${FONT};color:${INK};">
                <h1 style="margin:0 0 12px 0;font-size:22px;line-height:32px;font-weight:700;color:${INK};">${html.title}</h1>
                <p style="margin:0 0 24px 0;font-size:16px;line-height:26px;">${html.body}</p>
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td align="center" bgcolor="${BRAND}" style="background-color:${BRAND};border-radius:10px;">
                      <a href="${link}" style="display:inline-block;padding:14px 24px;font-family:${FONT};font-size:16px;line-height:20px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:10px;">${escapeHtml(t('emails.invitation.button'))}</a>
                    </td>
                  </tr>
                </table>
                <p style="margin:24px 0 4px 0;font-size:14px;line-height:22px;color:${MUTED};">${escapeHtml(t('emails.invitation.linkHint'))}</p>
                <p dir="ltr" style="margin:0;font-size:13px;line-height:20px;color:${BRAND};word-break:break-all;text-align:left;"><a href="${link}" style="color:${BRAND};">${link}</a></p>
                <p style="margin:24px 0 0 0;font-size:14px;line-height:22px;color:${MUTED};">${html.expiry}</p>
                <p style="margin:8px 0 0 0;font-size:14px;line-height:22px;color:${MUTED};">${escapeHtml(t('emails.invitation.ignore'))}</p>
              </td>
            </tr>
            <tr>
              <td dir="${direction}" align="center" style="padding:20px 8px 0 8px;font-family:${FONT};font-size:12px;line-height:18px;color:${MUTED};">${escapeHtml(t('emails.footer'))}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`

  const text = [
    t('emails.invitation.title', { business: isolate(input.businessName) }),
    '',
    hasInviter
      ? t('emails.invitation.body', {
          inviter: isolate(inviter),
          business: isolate(input.businessName),
          role: isolate(input.roleLabel),
        })
      : t('emails.invitation.bodyNoInviter', {
          business: isolate(input.businessName),
          role: isolate(input.roleLabel),
        }),
    '',
    `${t('emails.invitation.button')}:`,
    ltr(input.link),
    '',
    t('emails.invitation.expiry', { email: ltr(input.to) }),
    t('emails.invitation.ignore'),
    '',
    '—',
    t('emails.footer'),
  ].join('\n')

  return { to: input.to, subject, html: htmlBody, text }
}
