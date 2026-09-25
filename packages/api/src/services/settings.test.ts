import { AUTH_RECENT_SIGN_IN_SECONDS } from '@bizcost/contracts'
import { describe, expect, it } from 'vitest'
import type { BusinessAccess } from '../access'
import type { AuthUser } from '../auth'
import { escapeHtml, invitationEmail } from '../email/invitation'
import { emailSenderFor } from '../email/sender'
import { AppError } from '../errors'
import { sniffImageType } from './business-profile'
import { assertRecentSignIn } from './reauth'
import { canGrant, isOwner } from './team-rules'

// Pure parts of the settings services; the procedures are covered end to end by test/settings.*.

describe('sniffImageType', () => {
  it('knows PNG, JPEG and WebP by their first bytes, and nothing else', () => {
    const bytes = (...values: number[]) => new Uint8Array(values)
    expect(sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe(
      'image/png',
    )
    expect(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xdb))).toBe('image/jpeg')
    const webp = new TextEncoder().encode('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ')
    expect(sniffImageType(webp)).toBe('image/webp')
    for (const other of [
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
      '<html>',
      'GIF89a',
      'RIFFxxxxWAVE',
    ]) {
      expect(sniffImageType(new TextEncoder().encode(other)), other).toBeNull()
    }
    expect(sniffImageType(bytes())).toBeNull()
    expect(sniffImageType(bytes(0x89, 0x50))).toBeNull()
  })
})

describe('invitationEmail', () => {
  const input = {
    locale: 'en' as const,
    to: 'sara@example.com',
    businessName: 'Sara <Sweets> & "Co"',
    inviterName: 'Rashed',
    roleLabel: 'Employee',
    link: 'https://app.example.com/invite/abc_DEF-123',
  }

  it('escapes every value in the HTML and keeps the plain text readable', () => {
    const email = invitationEmail(input)
    expect(email.to).toBe('sara@example.com')
    expect(email.subject).toBe('Rashed invited you to join Sara <Sweets> & "Co" on BizCost')
    expect(email.html).toContain('<bdi>Sara &lt;Sweets&gt; &amp; &quot;Co&quot;</bdi>')
    expect(email.html).not.toContain('<Sweets>')
    expect(email.html).toContain('href="https://app.example.com/invite/abc_DEF-123"')
    expect(email.html).toContain('lang="en" dir="ltr"')
    expect(email.text).toContain('https://app.example.com/invite/abc_DEF-123')
    expect(email.text).toContain('Sara <Sweets> & "Co"')
  })

  it('writes Arabic right to left, and leaves the inviter out when unknown', () => {
    const email = invitationEmail({
      ...input,
      locale: 'ar',
      inviterName: null,
      roleLabel: 'الموظف',
    })
    expect(email.subject).toBe('دعوة للانضمام إلى Sara <Sweets> & "Co" على BizCost')
    expect(email.html).toContain('lang="ar" dir="rtl"')
    expect(email.html).toContain(
      '<bdi dir="ltr" style="white-space:nowrap;">sara@example.com</bdi>',
    )
    expect(email.text).not.toContain('Rashed')
  })

  it('escapeHtml covers the five HTML characters', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    )
  })
})

describe('emailSenderFor', () => {
  it('fails clearly (internal) without a transport, without sending anything', async () => {
    await expect(
      emailSenderFor(undefined).send({ to: 'a@b.test', subject: 's', html: 'h', text: 't' }),
    ).rejects.toMatchObject({ appCode: 'internal' })
  })

  it('reuses one sender per configuration', () => {
    const config = { transport: 'smtp' as const, host: '127.0.0.1', port: 54325, from: 'x <x@y.z>' }
    expect(emailSenderFor(config)).toBe(emailSenderFor(config))
  })
})

describe('assertRecentSignIn', () => {
  const user = (authenticatedAt: number | null): AuthUser => ({
    userId: '0199a3c2-5b1e-7c3a-9f00-1a2b3c4d5e6f',
    email: 'a@b.test',
    emailVerified: true,
    locale: 'en',
    authenticatedAt,
  })
  const now = 1_800_000_000

  it('accepts a sign-in within the window and refuses an older or unknown one', () => {
    expect(() => assertRecentSignIn(user(now - AUTH_RECENT_SIGN_IN_SECONDS), now)).not.toThrow()
    for (const at of [now - AUTH_RECENT_SIGN_IN_SECONDS - 1, null]) {
      try {
        assertRecentSignIn(user(at), now)
        expect.unreachable()
      } catch (error) {
        expect(error).toBeInstanceOf(AppError)
        expect((error as AppError).appCode).toBe('reauth_required')
      }
    }
  })
})

describe('canGrant / isOwner', () => {
  const access = (template: string | null, all: boolean, keys: string[]) =>
    ({
      roleTemplateKey: template,
      effective: { all, keys: new Set(keys) },
    }) as unknown as BusinessAccess

  it('lets an owner grant anything and anyone else only what they hold', () => {
    expect(canGrant(access('owner', true, []), ['settings.roles.manage'])).toBe(true)
    const manager = access('manager', false, ['settings.members.view', 'data.cost.view'])
    expect(canGrant(manager, ['data.cost.view'])).toBe(true)
    expect(canGrant(manager, [])).toBe(true)
    expect(canGrant(manager, ['data.cost.view', 'settings.members.manage'])).toBe(false)
    expect(isOwner(access('owner', true, []))).toBe(true)
    expect(isOwner(manager)).toBe(false)
  })
})
