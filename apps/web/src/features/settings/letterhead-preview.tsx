'use client'

import { MailIcon, MapPinIcon, PhoneIcon } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

// The business's own letterhead, as its quotations and invoices print it (M3 Step 7; the owner's
// requests of 2026-10-16: «قريب هذا», «بحسب اسم ومعلومات كل شركة»): an A4 page drawn to scale from the
// business's names, logo, accent colour, TRN and licence, contact lines, signature and stamp, in the
// direction of its language. Settings → Documents shows it as the colour or the watermark change, so
// the owner sees his letterhead before any document is made. The PDF itself is drawn on the server
// (packages/api templates/document.typ); this preview follows its proportions (1cqw = 2.1 mm).

export interface LetterheadPreviewData {
  readonly locale: 'en' | 'ar'
  /** #RRGGBB */
  readonly accent: string
  readonly logoUrl: string | null
  readonly watermark: boolean
  readonly nameEn: string | null
  readonly nameAr: string | null
  readonly trn: string | null
  readonly tradeLicence: string | null
  readonly phones: readonly string[]
  readonly email: string | null
  /** The address line exactly as the documents print it (document.settings), with its direction. */
  readonly address: { readonly text: string; readonly dir: 'ltr' | 'rtl' } | null
  readonly signatory: string | null
  readonly signatureUrl: string | null
  readonly stampUrl: string | null
}

/** Millimetres of the A4 page as a share of the preview's width. */
const mm = (value: number) => `${Math.round((value / 2.1) * 1000) / 1000}cqw`

function Bars({
  accent,
  top,
  end = false,
  rtl,
}: {
  accent: string
  top: boolean
  end?: boolean
  rtl: boolean
}) {
  // The bold bar cut on the diagonal and the thin one under it, from one corner: drawn for the left
  // corner, mirrored for a corner on the right (the end in a left-to-right page, the start in Arabic).
  const flip = end !== rtl ? 'scale-x-[-1]' : ''
  const bold: CSSProperties = top
    ? { top: 0, width: mm(60), height: mm(9), clipPath: 'polygon(0 0, 100% 0, 85% 100%, 0 100%)' }
    : {
        bottom: 0,
        width: mm(66),
        height: mm(9),
        clipPath: 'polygon(0 100%, 100% 100%, 86.4% 0, 0 0)',
      }
  const thin: CSSProperties = top
    ? {
        top: mm(11),
        width: mm(49),
        height: mm(2),
        clipPath: 'polygon(0 0, 100% 0, 95.9% 100%, 0 100%)',
      }
    : {
        bottom: mm(11),
        width: mm(55),
        height: mm(2),
        clipPath: 'polygon(0 100%, 100% 100%, 96.4% 0, 0 0)',
      }
  return (
    <div aria-hidden className={cn('absolute inset-x-0', top ? 'top-0' : 'bottom-0')}>
      <div
        className={cn('absolute start-0 origin-center', flip, end && 'start-auto end-0')}
        style={{ ...bold, background: accent }}
      />
      <div
        className={cn('absolute start-0 origin-center', flip, end && 'start-auto end-0')}
        style={{ ...thin, background: accent }}
      />
    </div>
  )
}

function Contact({
  icon,
  accent,
  children,
}: {
  icon: ReactNode
  accent: string
  children: ReactNode
}) {
  return (
    <div className="flex items-center" style={{ gap: mm(2.2) }}>
      <span className="flex shrink-0 items-center [&_svg]:size-[1.15em]" style={{ color: accent }}>
        {icon}
      </span>
      <span className="min-w-0 truncate">{children}</span>
    </div>
  )
}

export function LetterheadPreview({ data }: { data: LetterheadPreviewData }) {
  const { t } = useTranslation()
  const rtl = data.locale === 'ar'
  const names = [
    data.nameEn ? { text: data.nameEn, lang: 'en' } : null,
    data.nameAr ? { text: data.nameAr, lang: 'ar' } : null,
  ].filter((name): name is { text: string; lang: string } => name !== null)
  const address = data.address
  const ids = [
    data.trn ? { label: t('settings.documents.preview.trn'), value: data.trn } : null,
    data.tradeLicence
      ? { label: t('settings.documents.preview.tradeLicence'), value: data.tradeLicence }
      : null,
  ].filter((id): id is { label: string; value: string } => id !== null)
  const line = (width: string, strong = false) => (
    <div
      className={cn('rounded-full', strong ? 'bg-foreground/15' : 'bg-foreground/[0.07]')}
      style={{ width, height: mm(2.2) }}
    />
  )
  return (
    <div
      data-letterhead-preview
      data-accent={data.accent}
      dir={rtl ? 'rtl' : 'ltr'}
      lang={data.locale}
      className="@container mx-auto w-full max-w-md self-start overflow-hidden rounded-lg bg-white text-[#1e1e1e] shadow-md ring-1 ring-foreground/10"
    >
      <div className="relative w-full" style={{ aspectRatio: '210 / 297', fontSize: mm(3.2) }}>
        <Bars accent={data.accent} top rtl={rtl} />
        <Bars accent={data.accent} top end rtl={rtl} />
        <div
          aria-hidden
          className="absolute"
          style={{
            top: mm(4.1),
            insetInlineStart: mm(64),
            width: mm(82),
            height: mm(0.35),
            background: data.accent,
          }}
        />
        {/* The watermark: the logo, large and light, behind the content. */}
        {data.watermark && data.logoUrl ? (
          <img
            src={data.logoUrl}
            alt=""
            aria-hidden
            data-letterhead-watermark
            className="pointer-events-none absolute object-contain opacity-[0.06]"
            style={{ width: mm(128), height: mm(128), top: mm(92), insetInlineStart: mm(41) }}
          />
        ) : null}
        <div
          className="absolute inset-x-0 flex flex-col items-center text-center"
          style={{ top: data.logoUrl ? mm(8.5) : mm(14.5), paddingInline: mm(22) }}
        >
          {data.logoUrl ? (
            <img
              src={data.logoUrl}
              alt={t('settings.documents.preview.logo')}
              data-letterhead-logo
              className="object-contain"
              style={{ height: mm(17), maxWidth: mm(70), marginBottom: mm(1.6) }}
            />
          ) : null}
          {names.map((name, index) => (
            <div key={name.lang} className="w-full">
              {!data.logoUrl && index === 1 ? (
                <div
                  className="mx-auto"
                  style={{
                    width: mm(24),
                    height: mm(0.45),
                    margin: `${mm(1.4)} auto`,
                    background: data.accent,
                  }}
                />
              ) : null}
              <p
                lang={name.lang}
                dir={name.lang === 'ar' ? 'rtl' : 'ltr'}
                data-letterhead-name={name.lang}
                className="font-bold leading-tight [overflow-wrap:anywhere]"
                style={{ fontSize: data.logoUrl ? mm(4.3) : mm(6) }}
              >
                {name.text}
              </p>
            </div>
          ))}
          {ids.length > 0 ? (
            <p className="text-[#6c6c6c]" style={{ fontSize: mm(2.5), marginTop: mm(1.5) }}>
              {ids.map((id, index) => (
                <span key={id.label}>
                  {index > 0 ? (
                    <span style={{ color: data.accent, marginInline: mm(2.4) }}>|</span>
                  ) : null}
                  {id.label}{' '}
                  <bdi dir="ltr" className="font-bold text-[#1e1e1e]">
                    {id.value}
                  </bdi>
                </span>
              ))}
            </p>
          ) : null}
        </div>

        {/* The document's content, sketched. */}
        <div
          aria-hidden
          className="absolute flex flex-col"
          style={{ top: mm(data.logoUrl ? 58 : 50), insetInline: mm(14), gap: mm(3.2) }}
        >
          <div className="flex items-center" style={{ gap: mm(4) }}>
            <div
              className="flex-1"
              style={{ height: mm(0.25), background: data.accent, opacity: 0.5 }}
            />
            <span className="font-bold" style={{ color: data.accent, fontSize: mm(5.4) }}>
              {t('settings.documents.preview.title')}
            </span>
            <div
              className="flex-1"
              style={{ height: mm(0.25), background: data.accent, opacity: 0.5 }}
            />
          </div>
          <div
            className="rounded"
            style={{
              background: `${data.accent}12`,
              padding: mm(3),
              display: 'grid',
              gap: mm(1.8),
            }}
          >
            {line('40%', true)}
            {line('62%')}
            {line('48%')}
          </div>
          <div className="rounded-sm" style={{ height: mm(7), background: data.accent }} />
          {[0, 1, 2, 3].map((row) => (
            <div
              key={row}
              className="flex items-center border-b border-black/5"
              style={{ gap: mm(3), paddingBlock: mm(2.4) }}
            >
              <div
                className="rounded"
                style={{ width: mm(18), height: mm(13), background: '#00000010' }}
              />
              <div className="flex flex-1 flex-col" style={{ gap: mm(1.6) }}>
                {line('55%', true)}
                {line('75%')}
              </div>
              {line('12%', true)}
            </div>
          ))}
        </div>

        {/* The signature and the stamp, as the documents print them. */}
        {data.signatory || data.signatureUrl || data.stampUrl ? (
          <div
            className="absolute"
            style={{ bottom: mm(40), insetInlineStart: mm(14), width: mm(80) }}
          >
            <div className="relative" style={{ height: mm(18) }}>
              {data.stampUrl ? (
                <img
                  src={data.stampUrl}
                  alt={t('settings.documents.preview.stamp')}
                  data-letterhead-stamp
                  className="absolute object-contain"
                  style={{
                    height: mm(20),
                    width: mm(20),
                    insetInlineStart: mm(36),
                    top: 0,
                    transform: 'rotate(-8deg)',
                  }}
                />
              ) : null}
              {data.signatureUrl ? (
                <img
                  src={data.signatureUrl}
                  alt={t('settings.documents.preview.signature')}
                  data-letterhead-signature
                  className="absolute bottom-0 object-contain"
                  style={{ height: mm(14), width: mm(42), insetInlineStart: 0 }}
                />
              ) : null}
            </div>
            <div style={{ height: mm(0.25), background: '#aaa' }} />
            {data.signatory ? (
              <p dir="auto" className="text-start font-bold" style={{ marginTop: mm(1) }}>
                {data.signatory}
              </p>
            ) : null}
          </div>
        ) : null}

        {/* The footer: the contact lines in a bracket on the start side, the page on the end side. */}
        {data.phones.length > 0 || data.email || address ? (
          <div
            className="absolute flex flex-col"
            style={{
              bottom: mm(10.5),
              insetInlineStart: mm(14),
              maxWidth: mm(118),
              fontSize: mm(2.7),
              gap: mm(1.4),
              paddingBlock: mm(2.5),
              paddingInlineStart: mm(3.6),
              borderInlineStart: `${mm(0.4)} solid ${data.accent}`,
              borderBlock: `${mm(0.4)} solid ${data.accent}`,
              borderStartStartRadius: mm(2.6),
              borderEndStartRadius: mm(2.6),
              paddingInlineEnd: mm(2),
            }}
            data-letterhead-contacts
          >
            {data.phones.length > 0 ? (
              <Contact icon={<PhoneIcon />} accent={data.accent}>
                <bdi dir="ltr">{data.phones.join('  |  ')}</bdi>
              </Contact>
            ) : null}
            {data.email ? (
              <Contact icon={<MailIcon />} accent={data.accent}>
                <bdi dir="ltr">{data.email}</bdi>
              </Contact>
            ) : null}
            {address ? (
              <Contact icon={<MapPinIcon />} accent={data.accent}>
                <bdi dir={address.dir}>{address.text}</bdi>
              </Contact>
            ) : null}
          </div>
        ) : null}
        <p
          aria-hidden
          className="absolute text-[#6c6c6c]"
          style={{ bottom: mm(19), insetInlineEnd: mm(14), fontSize: mm(2.5) }}
        >
          {t('settings.documents.preview.page')}
        </p>
        <Bars accent={data.accent} top={false} end rtl={rtl} />
        <div
          aria-hidden
          className="absolute"
          style={{
            bottom: mm(4.4),
            insetInlineStart: 0,
            width: mm(140),
            height: mm(0.35),
            background: data.accent,
          }}
        />
      </div>
    </div>
  )
}
