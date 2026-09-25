import type { MeDto, MembershipDto } from '@bizcost/contracts'
import { describe, expect, it } from 'vitest'
import { activeMemberships, landingBusinessId } from './memberships'

const A = '0199a000-0000-7000-8000-00000000000a'
const B = '0199a000-0000-7000-8000-00000000000b'
const C = '0199a000-0000-7000-8000-00000000000c'

function membership(businessId: string, status: MembershipDto['status'] = 'active') {
  return { businessId, legalName: businessId.slice(-1), roleTemplateKey: 'owner', status }
}

function me(lastBusinessId: string | null, memberships: MembershipDto[]): MeDto {
  return {
    profile: { id: C, displayName: 'Sara', locale: 'en', lastBusinessId },
    memberships,
  }
}

describe('landingBusinessId', () => {
  it('is null without an active business', () => {
    expect(landingBusinessId(me(null, []))).toBeNull()
    expect(landingBusinessId(me(A, [membership(A, 'suspended')]))).toBeNull()
  })

  it('goes to the business opened last while it is still active', () => {
    expect(landingBusinessId(me(B, [membership(A), membership(B)]))).toBe(B)
  })

  it('falls back to the first active business', () => {
    expect(landingBusinessId(me(null, [membership(A), membership(B)]))).toBe(A)
    expect(landingBusinessId(me(C, [membership(A), membership(B)]))).toBe(A)
    expect(landingBusinessId(me(A, [membership(A, 'suspended'), membership(B)]))).toBe(B)
  })
})

describe('activeMemberships', () => {
  it('keeps active memberships in order', () => {
    const list = [membership(B), membership(A, 'suspended'), membership(C)]
    expect(activeMemberships(me(null, list)).map((m) => m.businessId)).toEqual([B, C])
  })
})
