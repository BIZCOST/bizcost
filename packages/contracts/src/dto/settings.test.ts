import { newId } from '@bizcost/domain'
import { describe, expect, it } from 'vitest'
import { LOGO_CONTENT_TYPES } from '../business'
import {
  customizeInput,
  logoUploadUrlInput,
  setLogoInput,
  updateBusinessProfileInput,
} from './business-settings'
import {
  createInvitationInput,
  createLocationInput,
  invitationPreviewDto,
  invitationTokenInput,
  memberDto,
  updateRolePermissionsInput,
} from './team'

describe('updateBusinessProfileInput', () => {
  const input = {
    version: 3,
    legalName: ' Nour ',
    legalNameAr: ' ورشة ',
    vatRegistered: true,
    trn: '100 234',
  }

  it('trims names and leaves the TRN for the server (parseTrn)', () => {
    expect(updateBusinessProfileInput.parse(input)).toEqual({
      version: 3,
      legalName: 'Nour',
      legalNameAr: 'ورشة',
      vatRegistered: true,
      trn: '100 234',
    })
    expect(
      updateBusinessProfileInput.parse({ ...input, legalNameAr: null, trn: null }),
    ).toMatchObject({
      legalNameAr: null,
      trn: null,
    })
  })

  it('refuses control characters, long names and a missing version', () => {
    const bad = (patch: object) =>
      !updateBusinessProfileInput.safeParse({ ...input, ...patch }).success
    expect(bad({ legalName: 'A\tB' })).toBe(true)
    expect(bad({ legalNameAr: 'A\u0000' })).toBe(true)
    expect(bad({ legalNameAr: 'x'.repeat(101) })).toBe(true)
    expect(bad({ legalName: '' })).toBe(true)
    expect(bad({ version: 0 })).toBe(true)
    expect(bad({ trn: 'x'.repeat(41) })).toBe(true)
  })
})

describe('logo inputs', () => {
  it('allow PNG, JPEG and WebP only (never SVG)', () => {
    expect(LOGO_CONTENT_TYPES).toEqual(['image/png', 'image/jpeg', 'image/webp'])
    expect(logoUploadUrlInput.safeParse({ contentType: 'image/svg+xml' }).success).toBe(false)
    expect(logoUploadUrlInput.safeParse({ contentType: 'image/png' }).success).toBe(true)
    expect(setLogoInput.safeParse({ path: 'x'.repeat(201) }).success).toBe(false)
  })
})

describe('customizeInput', () => {
  it('is one module or capability switch', () => {
    expect(
      customizeInput.parse({ item: { kind: 'module', id: 'orders' }, enabled: false }),
    ).toEqual({
      item: { kind: 'module', id: 'orders' },
      enabled: false,
    })
    expect(
      customizeInput.safeParse({ item: { kind: 'module', key: 'orders' }, enabled: true }).success,
    ).toBe(false)
    expect(
      customizeInput.safeParse({ item: { kind: 'other', id: 'x' }, enabled: true }).success,
    ).toBe(false)
  })
})

describe('team inputs', () => {
  it('trims and lowercases invitation emails and refuses others', () => {
    const base = { id: newId(), roleId: newId(), locale: 'ar' }
    expect(createInvitationInput.parse({ ...base, email: ' Sara@Example.COM ' }).email).toBe(
      'sara@example.com',
    )
    for (const email of [
      'sara',
      'sara@',
      '@example.com',
      'a b@example.com',
      `${'x'.repeat(250)}@e.co`,
    ]) {
      expect(createInvitationInput.safeParse({ ...base, email }).success, email).toBe(false)
    }
    expect(
      createInvitationInput.safeParse({ ...base, email: 'a@b.co', locale: 'fr' }).success,
    ).toBe(false)
  })

  it('checks names, tokens and permission lists by shape only', () => {
    expect(createLocationInput.parse({ id: newId(), name: ' Marina ' }).name).toBe('Marina')
    expect(createLocationInput.safeParse({ id: newId(), name: 'A\nB' }).success).toBe(false)
    expect(invitationTokenInput.safeParse({ token: 'x'.repeat(201) }).success).toBe(false)
    expect(
      updateRolePermissionsInput.safeParse({
        id: newId(),
        version: 1,
        permissionKeys: Array.from({ length: 201 }, (_, i) => `k${i}`),
      }).success,
    ).toBe(false)
  })

  it('describe members and previews on the wire', () => {
    const member = {
      id: newId(),
      displayName: 'Sara',
      email: null,
      kind: 'pin_only',
      status: 'active',
      roleId: newId(),
      roleName: 'Employee',
      roleTemplateKey: 'employee',
      isOwner: false,
      isYou: false,
      joinedAt: '2026-09-25T10:00:00.000Z',
    }
    expect(memberDto.parse(member)).toEqual(member)
    expect(memberDto.safeParse({ ...member, joinedAt: 'yesterday' }).success).toBe(false)
    const preview = {
      businessName: 'Nour',
      inviterName: null,
      roleName: 'Employee',
      roleTemplateKey: 'employee',
      maskedEmail: 's•••@example.com',
      expiresAt: '2026-10-02T10:00:00.000Z',
      expired: false,
      emailMatches: null,
    }
    expect(invitationPreviewDto.parse({ ...preview, email: 'sara@example.com' })).toEqual(preview)
  })
})
