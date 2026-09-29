import { FIELD_WRAPPER_TYPES, type AppErrorCode } from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { QUESTION_SET_VERSION } from '@bizcost/modules'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { appRouter } from '../../src'
import { query } from '../helpers'
import { randomToken, WORKSHOP } from '../settings'
import {
  callProcedure,
  createTenant,
  leaksOf,
  openApi,
  proceduresOf,
  tenantDigest,
  type Api,
  type Base,
  type Person,
  type ProcedureInfo,
  type Tenant,
} from './fixture'

// Cross-tenant attack matrix (ROADMAP.md Step 9; ARCHITECTURE.md §Testing & CI, Cross-tenant attacks).
// Two businesses, each with its owner, an Admin and an Employee. For EVERY procedure of appRouter,
// walked from the router:
//   - business procedures: each member of the attacking business calls it with x-business-id of the
//     victim (and the victim's ids in the input): FORBIDDEN, with nothing of the victim in the answer;
//   - business procedures whose input names rows: the attacker's owner calls it in their OWN business
//     with the victim's ids: refused (NOT_FOUND, CONFLICT, VALIDATION…), nothing of the victim;
//   - authed and public procedures: called by the attacker (also with the victim's x-business-id,
//     which they must ignore) and with the victim's ids where the input takes them: the expected
//     answer, and nothing of the victim;
// and both ways (A attacks B, B attacks A). Last, the victim's rows, audit log, profiles and Storage
// objects are exactly as before.
//
// PROBES classifies every procedure with the reason it is safe. A procedure added without a probe
// fails the first test, and a probe whose input references rows (ids, paths, tokens) must say how the
// victim's reference is refused.

interface Variant {
  input: unknown
  /** Business procedures: the answers accepted when the attacker sends it in their own business. */
  own?: readonly AppErrorCode[]
}

interface Probe {
  base: Base
  reason: string
  /** Valid inputs, naming the victim's rows where the input takes a reference. */
  variants?: (victim: Tenant, attacker: Tenant) => Variant[]
  /** Authed and public procedures: the attacker's answer ('ok': served, with nothing of the victim). */
  answer?: 'ok' | readonly AppErrorCode[]
  /** Input fields that look like references (by name or format) but name no row: path → why. */
  notReferences?: Record<string, string>
}

const NO_ROWS = 'names no rows: it acts on the x-business-id business, which businessScoped checks'

const PROBES: Record<string, Probe> = {
  health: { base: 'public', reason: 'liveness and region only', answer: 'ok' },
  me: {
    base: 'authed',
    reason: 'lists only the caller’s own active memberships (RLS own_memberships)',
    answer: 'ok',
  },
  'account.updateProfile': {
    base: 'authed',
    reason: 'changes only the caller’s own profile and memberships',
    variants: () => [{ input: { displayName: 'Attacker' } }],
    answer: 'ok',
  },
  'account.setLastBusiness': {
    base: 'authed',
    reason: 'only a business the caller is an active member of (D-077)',
    variants: (victim) => [{ input: { businessId: victim.id } }],
    answer: ['forbidden'],
  },
  'account.delete': {
    base: 'authed',
    reason:
      'acts on the caller’s own memberships only; here refused before any change (sole owner)',
    answer: ['sole_owner'],
  },
  'business.createFromSetup': {
    base: 'authed',
    reason: 'an id of a business the caller cannot see is CONFLICT (D-076), never a takeover',
    variants: (victim) => [
      {
        input: {
          businessId: victim.id,
          legalName: 'Takeover',
          locale: 'en',
          questionSetVersion: QUESTION_SET_VERSION,
          answers: WORKSHOP,
          adjustments: { modules: [], capabilities: [] },
        },
      },
    ],
    answer: ['conflict'],
  },
  'invitation.accept': {
    base: 'authed',
    reason: 'needs the invited, verified email; the link alone does not let another account in',
    variants: (victim) => [{ input: { token: victim.invitationToken } }],
    answer: ['invitation_invalid'],
  },
  'invitation.preview': {
    base: 'public',
    reason:
      'the link’s token is its secret: its holder sees the business name by design (D-082); ' +
      'any other token is invitation_invalid',
    variants: () => [{ input: { token: randomToken() } }],
    answer: ['invitation_invalid'],
  },

  'business.context': { base: 'business', reason: NO_ROWS },
  'business.profile': { base: 'business', reason: NO_ROWS },
  'business.updateProfile': {
    base: 'business',
    reason: NO_ROWS,
    variants: () => [
      {
        input: {
          version: 1,
          legalName: 'Pwned',
          legalNameAr: null,
          vatRegistered: false,
          trn: null,
        },
      },
    ],
  },
  'business.setDefaultLocale': {
    base: 'business',
    reason: NO_ROWS,
    variants: () => [{ input: { defaultLocale: 'ar' } }],
  },
  'business.logoUploadUrl': {
    base: 'business',
    reason: 'the path is made by the server under the x-business-id business',
    variants: () => [{ input: { contentType: 'image/png' } }],
  },
  'business.setLogo': {
    base: 'business',
    reason: 'only a logo path of the x-business-id business that it issued (D-085)',
    variants: (victim) => [
      { input: { path: victim.logoPath }, own: ['validation'] },
      { input: { path: victim.openUpload.path }, own: ['validation'] },
    ],
  },
  'business.removeLogo': { base: 'business', reason: NO_ROWS },
  'business.customization': { base: 'business', reason: NO_ROWS },
  'business.customize': {
    base: 'business',
    reason: NO_ROWS,
    variants: () => [{ input: { item: { kind: 'capability', key: 'has_team' }, enabled: false } }],
    notReferences: {
      'item.id':
        'a module key of the registry (e.g. "orders"), the same in every business, not a row; ' +
        'an unknown key is VALIDATION',
    },
  },
  'dashboard.checklist': { base: 'business', reason: NO_ROWS },
  'location.list': { base: 'business', reason: NO_ROWS },
  'location.create': {
    base: 'business',
    reason: 'an id already used anywhere is CONFLICT (insertIdempotent), the row is never read',
    variants: (victim) => [{ input: { id: victim.branch.id, name: 'Pwned' }, own: ['conflict'] }],
  },
  'location.rename': {
    base: 'business',
    reason: 'looked up in the x-business-id business (RLS and business_id filter)',
    variants: (victim) => [
      {
        input: { id: victim.branch.id, name: 'Pwned', version: victim.branch.version },
        own: ['not_found'],
      },
    ],
  },
  'location.setDefault': {
    base: 'business',
    reason: 'looked up in the x-business-id business',
    variants: (victim) => [{ input: { id: victim.branch.id }, own: ['not_found'] }],
  },
  'location.remove': {
    base: 'business',
    reason: 'looked up in the x-business-id business',
    variants: (victim) => [{ input: { id: victim.branch.id }, own: ['not_found'] }],
  },
  'member.list': { base: 'business', reason: NO_ROWS },
  'member.changeRole': {
    base: 'business',
    reason: 'member and role are both looked up in the x-business-id business',
    variants: (victim, attacker) => [
      {
        input: { memberId: victim.employeeMemberId, roleId: victim.roles.manager.id },
        own: ['not_found'],
      },
      // Own member, the victim's role: composite (business_id, role_id) keys, and the lookup.
      {
        input: { memberId: attacker.employeeMemberId, roleId: victim.roles.admin.id },
        own: ['not_found'],
      },
    ],
  },
  'member.remove': {
    base: 'business',
    reason: 'looked up in the x-business-id business',
    variants: (victim) => [{ input: { memberId: victim.employeeMemberId }, own: ['not_found'] }],
  },
  'member.leave': {
    base: 'business',
    reason: 'leaves the x-business-id business only, as its member',
  },
  'member.transferOwnership': {
    base: 'business',
    reason: 'the new owner is looked up in the x-business-id business',
    variants: (victim) => [{ input: { memberId: victim.adminMemberId }, own: ['not_found'] }],
  },
  'invitation.list': { base: 'business', reason: NO_ROWS },
  'invitation.create': {
    base: 'business',
    reason: 'the role is looked up in the x-business-id business; a used id is CONFLICT',
    variants: (victim, attacker) => [
      {
        input: {
          id: newId(),
          email: `x-${newId()}@test.bizcost.local`,
          roleId: victim.roles.employee.id,
          locale: 'en',
        },
        own: ['not_found'],
      },
      {
        input: {
          id: victim.invitation.id,
          email: `x-${newId()}@test.bizcost.local`,
          roleId: attacker.roles.employee.id,
          locale: 'en',
        },
        own: ['conflict'],
      },
    ],
  },
  'invitation.resend': {
    base: 'business',
    reason: 'looked up in the x-business-id business',
    variants: (victim) => [{ input: { id: victim.invitation.id }, own: ['not_found'] }],
  },
  'invitation.revoke': {
    base: 'business',
    reason: 'looked up in the x-business-id business',
    variants: (victim) => [{ input: { id: victim.invitation.id }, own: ['not_found'] }],
  },
  'role.list': { base: 'business', reason: NO_ROWS },
  'material.list': {
    base: 'business',
    reason: `${NO_ROWS}; the cursor only positions a page inside that business`,
    variants: () => [{ input: { search: 'milk', status: 'all' } }],
  },
  'material.get': {
    base: 'business',
    reason: 'looked up in the x-business-id business',
    variants: (victim) => [{ input: { id: victim.material.id }, own: ['not_found'] }],
  },
  'material.create': {
    base: 'business',
    reason:
      'an id already used anywhere is CONFLICT (the material through insertIdempotent, a unit ' +
      'through its primary key), and a pack may only name a pack of the same material',
    variants: (victim) => [
      {
        input: { id: victim.material.id, name: `Pwned ${newId()}`, unit: 'kg' },
        own: ['conflict'],
      },
      {
        input: {
          id: newId(),
          name: `Pwned ${newId()}`,
          unit: 'l',
          packs: [{ id: victim.material.packs[0]?.id, name: 'crate', qty: '1', ofUnit: 'l' }],
        },
        own: ['conflict'],
      },
      {
        input: {
          id: newId(),
          name: `Pwned ${newId()}`,
          unit: 'l',
          packs: [{ id: newId(), name: 'crate', qty: '1', ofPackId: victim.material.packs[0]?.id }],
        },
        own: ['validation'],
      },
    ],
  },
  'material.quickCreate': {
    base: 'business',
    reason:
      'the create of material.create: an id already used anywhere is CONFLICT (the material through ' +
      'insertIdempotent, a unit through its primary key), a pack names only a pack of the same material',
    variants: (victim) => [
      {
        input: { id: victim.material.id, name: `Pwned ${newId()}`, unit: 'kg' },
        own: ['conflict'],
      },
      {
        input: {
          id: newId(),
          name: `Pwned ${newId()}`,
          unit: 'l',
          packs: [{ id: newId(), name: 'crate', qty: '1', ofPackId: victim.material.packs[0]?.id }],
        },
        own: ['validation'],
      },
    ],
  },
  'material.update': {
    base: 'business',
    reason:
      'the material is looked up in the x-business-id business, a unit it keeps among its own ' +
      'units, and a new unit id used anywhere is CONFLICT',
    variants: (victim, attacker) => [
      {
        input: {
          id: victim.material.id,
          version: victim.material.version,
          name: 'Pwned',
          unit: 'l',
        },
        own: ['not_found'],
      },
      // Own material, the victim's pack: its id is taken (the transaction rolls back).
      {
        input: {
          id: attacker.material.id,
          version: attacker.material.version,
          name: attacker.material.name,
          unit: 'l',
          packs: [{ id: victim.material.packs[0]?.id, name: 'crate', qty: '1', ofUnit: 'l' }],
        },
        own: ['conflict'],
      },
    ],
  },
  'material.archive': {
    base: 'business',
    reason: 'looked up in the x-business-id business',
    variants: (victim) => [{ input: { id: victim.material.id }, own: ['not_found'] }],
  },
  'material.unarchive': {
    base: 'business',
    reason: 'looked up in the x-business-id business',
    variants: (victim) => [{ input: { id: victim.material.id }, own: ['not_found'] }],
  },
  'product.list': {
    base: 'business',
    reason: `${NO_ROWS}; the cursor only positions a page inside that business`,
    variants: () => [{ input: { search: 'latte', status: 'all' } }],
  },
  'product.get': {
    base: 'business',
    reason: 'looked up in the x-business-id business',
    variants: (victim) => [{ input: { id: victim.product.id }, own: ['not_found'] }],
  },
  'product.create': {
    base: 'business',
    reason:
      'an id already used anywhere is CONFLICT (insertIdempotent), the material of an item bought ' +
      'ready to sell and its pack ids too; its locations are looked up in the x-business-id business',
    variants: (victim) => [
      // Bought ready to sell as the victim's material, or with the victim's pack as its own.
      {
        input: {
          id: newId(),
          name: `Pwned ${newId()}`,
          type: 'product',
          unit: 'l',
          resale: { materialId: victim.material.id },
        },
        own: ['conflict'],
      },
      {
        input: {
          id: newId(),
          name: `Pwned ${newId()}`,
          type: 'product',
          unit: 'l',
          resale: {
            materialId: newId(),
            packs: [{ id: victim.material.packs[0]?.id, name: 'crate', qty: '1', ofUnit: 'l' }],
          },
        },
        own: ['conflict'],
      },
      {
        input: { id: victim.product.id, name: `Pwned ${newId()}`, type: 'product', unit: 'piece' },
        own: ['conflict'],
      },
      {
        input: {
          id: newId(),
          name: `Pwned ${newId()}`,
          type: 'product',
          unit: 'piece',
          locationIds: [victim.branch.id],
        },
        own: ['not_found'],
      },
    ],
  },
  'product.update': {
    base: 'business',
    reason: 'the record and its locations are looked up in the x-business-id business',
    variants: (victim, attacker) => [
      {
        input: {
          id: victim.product.id,
          version: victim.product.version,
          name: 'Pwned',
          type: 'product',
          unit: 'piece',
        },
        own: ['not_found'],
      },
      {
        input: {
          id: attacker.product.id,
          version: attacker.product.version,
          name: attacker.product.name,
          type: 'product',
          unit: 'piece',
          locationIds: [victim.branch.id],
        },
        own: ['not_found'],
      },
    ],
  },
  'product.archive': {
    base: 'business',
    reason: 'looked up in the x-business-id business',
    variants: (victim) => [{ input: { id: victim.product.id }, own: ['not_found'] }],
  },
  'product.unarchive': {
    base: 'business',
    reason: 'looked up in the x-business-id business',
    variants: (victim) => [{ input: { id: victim.product.id }, own: ['not_found'] }],
  },
  'role.updatePermissions': {
    base: 'business',
    reason: 'looked up in the x-business-id business',
    variants: (victim) => [
      {
        input: {
          id: victim.roles.employee.id,
          version: victim.roles.employee.version,
          permissionKeys: ['dashboard.home.view', 'settings.business.view'],
        },
        own: ['not_found'],
      },
    ],
  },
  // Suppliers and Purchases (M2 Step 3): every reference is looked up in the x-business-id business;
  // ids used anywhere are CONFLICT; composite foreign keys keep lines inside their document.
  'supplier.list': {
    base: 'business',
    reason: `${NO_ROWS}; the cursor only positions a page inside that business`,
    variants: () => [{ input: { search: 'dairy', status: 'all' } }],
  },
  'supplier.get': {
    base: 'business',
    reason: 'looked up in the x-business-id business',
    variants: (victim) => [{ input: { id: victim.supplier.id }, own: ['not_found'] }],
  },
  'supplier.create': {
    base: 'business',
    reason: 'an id already used anywhere is CONFLICT (insertIdempotent), the row is never read',
    variants: (victim) => [
      { input: { id: victim.supplier.id, name: `Pwned ${newId()}` }, own: ['conflict'] },
    ],
  },
  'supplier.update': {
    base: 'business',
    reason: 'looked up in the x-business-id business',
    variants: (victim) => [
      {
        input: { id: victim.supplier.id, version: victim.supplier.version, name: 'Pwned' },
        own: ['not_found'],
      },
    ],
  },
  'supplier.archive': {
    base: 'business',
    reason: 'looked up in the x-business-id business',
    variants: (victim) => [{ input: { id: victim.supplier.id }, own: ['not_found'] }],
  },
  'supplier.unarchive': {
    base: 'business',
    reason: 'looked up in the x-business-id business',
    variants: (victim) => [{ input: { id: victim.supplier.id }, own: ['not_found'] }],
  },
  'purchase.list': {
    base: 'business',
    reason: `${NO_ROWS}; a supplier filter is looked up in that business (NOT_FOUND)`,
    variants: (victim) => [
      { input: { status: 'all' } },
      { input: { supplierId: victim.supplier.id }, own: ['not_found'] },
    ],
  },
  'purchase.get': {
    base: 'business',
    reason: 'looked up in the x-business-id business',
    variants: (victim) => [{ input: { id: victim.purchase.id }, own: ['not_found'] }],
  },
  'purchase.create': {
    base: 'business',
    reason:
      'its supplier, location and materials are looked up in the x-business-id business, a pack ' +
      'must be one of its material, and an id used anywhere (the purchase or a line) is CONFLICT',
    variants: (victim, attacker) => {
      const own = {
        kind: 'material',
        id: newId(),
        materialId: attacker.material.id,
        qty: '1',
        unit: 'l',
        unitPrice: '1',
      }
      const draft = (extra: object) => ({
        id: newId(),
        businessDate: attacker.purchase.businessDate,
        documentType: 'no_invoice',
        paymentMethod: 'cash',
        lines: [{ ...own, id: newId() }],
        ...extra,
      })
      return [
        { input: { ...draft({}), id: victim.purchase.id }, own: ['conflict'] },
        { input: draft({ supplierId: victim.supplier.id }), own: ['not_found'] },
        { input: draft({ locationId: victim.defaultLocationId }), own: ['not_found'] },
        {
          input: draft({ lines: [{ ...own, materialId: victim.material.id }] }),
          own: ['not_found'],
        },
        {
          input: draft({
            lines: [{ ...own, unit: undefined, packId: victim.material.packs[0]?.id }],
          }),
          own: ['validation'],
        },
        {
          input: draft({ lines: [{ ...own, id: victim.purchase.lines[0]?.id }] }),
          own: ['conflict'],
        },
        {
          input: draft({ paymentMethod: 'paid_by_member', paidByMemberId: victim.adminMemberId }),
          own: ['not_found'],
        },
      ]
    },
  },
  'purchase.payers': { base: 'business', reason: `${NO_ROWS}: its own active members` },
  'purchase.update': {
    base: 'business',
    reason: 'the draft and every row it names are looked up in the x-business-id business',
    variants: (victim, attacker) => [
      {
        input: {
          id: victim.draftPurchase.id,
          version: victim.draftPurchase.version,
          businessDate: victim.draftPurchase.businessDate,
          documentType: 'no_invoice',
          paymentMethod: 'cash',
        },
        own: ['not_found'],
      },
      {
        input: {
          id: attacker.draftPurchase.id,
          version: attacker.draftPurchase.version,
          businessDate: attacker.draftPurchase.businessDate,
          documentType: 'no_invoice',
          paymentMethod: 'cash',
          supplierId: victim.supplier.id,
        },
        own: ['not_found'],
      },
    ],
  },
  'purchase.discard': {
    base: 'business',
    reason: 'looked up in the x-business-id business',
    variants: (victim) => [
      {
        input: { id: victim.draftPurchase.id, version: victim.draftPurchase.version },
        own: ['not_found'],
      },
    ],
  },
  'purchase.post': {
    base: 'business',
    reason: 'looked up (and locked) in the x-business-id business',
    variants: (victim) => [
      {
        input: { id: victim.draftPurchase.id, version: victim.draftPurchase.version },
        own: ['not_found'],
      },
    ],
  },
  'purchase.reverse': {
    base: 'business',
    reason: 'looked up (and locked) in the x-business-id business',
    variants: (victim) => [{ input: { id: victim.purchase.id }, own: ['not_found'] }],
  },
  'purchase.correct': {
    base: 'business',
    reason:
      'the purchase is looked up in the x-business-id business; a new id used anywhere is ' +
      'CONFLICT and the whole correction (its reversal too) is rolled back',
    variants: (victim, attacker) => [
      { input: { id: victim.purchase.id, newId: newId() }, own: ['not_found'] },
      { input: { id: attacker.purchase.id, newId: victim.draftPurchase.id }, own: ['conflict'] },
    ],
  },
  'purchaseReturn.list': {
    base: 'business',
    reason: `${NO_ROWS}; a purchase filter is looked up in that business (NOT_FOUND)`,
    variants: (victim) => [
      { input: { status: 'all' } },
      { input: { purchaseId: victim.purchase.id }, own: ['not_found'] },
    ],
  },
  'purchaseReturn.get': {
    base: 'business',
    reason: 'looked up in the x-business-id business',
    variants: (victim) => [{ input: { id: victim.purchaseReturn.id }, own: ['not_found'] }],
  },
  'purchaseReturn.create': {
    base: 'business',
    reason:
      'the purchase and its lines are looked up in the x-business-id business (a line of another ' +
      'purchase too); an id used anywhere is CONFLICT',
    variants: (victim, attacker) => [
      {
        input: {
          id: newId(),
          purchaseId: victim.purchase.id,
          kind: 'return',
          businessDate: attacker.purchase.businessDate,
          lines: [{ id: newId(), purchaseLineId: victim.purchase.lines[0]?.id, qty: '1' }],
        },
        own: ['not_found'],
      },
      {
        input: {
          id: newId(),
          purchaseId: attacker.purchase.id,
          kind: 'credit_note',
          businessDate: attacker.purchase.businessDate,
          lines: [{ id: newId(), purchaseLineId: victim.purchase.lines[0]?.id, amount: '1' }],
        },
        own: ['not_found'],
      },
      {
        input: {
          id: victim.draftReturn.id,
          purchaseId: attacker.purchase.id,
          kind: 'credit_note',
          businessDate: attacker.purchase.businessDate,
          lines: [{ id: newId(), purchaseLineId: attacker.purchase.lines[0]?.id, amount: '1' }],
        },
        own: ['conflict'],
      },
    ],
  },
  'purchaseReturn.update': {
    base: 'business',
    reason: 'the draft and its lines are looked up in the x-business-id business',
    variants: (victim, attacker) => [
      {
        input: {
          id: victim.draftReturn.id,
          version: victim.draftReturn.version,
          businessDate: victim.draftReturn.businessDate,
          lines: [],
        },
        own: ['not_found'],
      },
      {
        input: {
          id: attacker.draftReturn.id,
          version: attacker.draftReturn.version,
          businessDate: attacker.draftReturn.businessDate,
          lines: [{ id: newId(), purchaseLineId: victim.purchase.lines[0]?.id, amount: '1' }],
        },
        own: ['not_found'],
      },
    ],
  },
  'purchaseReturn.discard': {
    base: 'business',
    reason: 'looked up in the x-business-id business',
    variants: (victim) => [
      {
        input: { id: victim.draftReturn.id, version: victim.draftReturn.version },
        own: ['not_found'],
      },
    ],
  },
  'purchaseReturn.post': {
    base: 'business',
    reason: 'looked up (and locked) in the x-business-id business',
    variants: (victim) => [
      {
        input: { id: victim.draftReturn.id, version: victim.draftReturn.version },
        own: ['not_found'],
      },
    ],
  },
  'purchaseReturn.reverse': {
    base: 'business',
    reason: 'looked up (and locked) in the x-business-id business',
    variants: (victim) => [{ input: { id: victim.purchaseReturn.id }, own: ['not_found'] }],
  },
  'attachment.list': {
    base: 'business',
    reason: 'the record is looked up in the x-business-id business',
    variants: (victim) => [
      { input: { entity: 'purchase', entityId: victim.purchase.id }, own: ['not_found'] },
      { input: { entity: 'expense', entityId: victim.expense.id }, own: ['not_found'] },
    ],
  },
  'attachment.uploadUrl': {
    base: 'business',
    reason: 'the record is looked up in the x-business-id business; the path is made by the server',
    variants: (victim) => [
      {
        input: { entity: 'purchase', entityId: victim.purchase.id, contentType: 'image/png' },
        own: ['not_found'],
      },
      {
        input: { entity: 'expense', entityId: victim.expense.id, contentType: 'image/png' },
        own: ['not_found'],
      },
    ],
  },
  'attachment.add': {
    base: 'business',
    reason:
      'only an attachment path of the x-business-id business that it issued, for a record of it ' +
      '(D-085)',
    variants: (victim, attacker) => [
      {
        input: {
          entity: 'purchase',
          entityId: attacker.purchase.id,
          path: `${victim.id}/purchase/${newId()}.png`,
          fileName: 'x.png',
        },
        own: ['validation'],
      },
      {
        input: {
          entity: 'purchase',
          entityId: victim.purchase.id,
          path: `${attacker.id}/purchase/${newId()}.png`,
          fileName: 'x.png',
        },
        own: ['not_found'],
      },
    ],
  },
  'attachment.remove': {
    base: 'business',
    reason: 'looked up in the x-business-id business',
    variants: (victim) => [
      { input: { id: victim.attachment.id }, own: ['not_found'] },
      { input: { id: victim.expenseAttachment.id }, own: ['not_found'] },
    ],
  },
  // What is owed and its payments (the owner's requests of 2026-09-29): the purchase and the payment
  // are looked up in the x-business-id business, and a payment id used anywhere is CONFLICT.
  'payable.list': {
    base: 'business',
    reason: `${NO_ROWS}: its own purchases, suppliers and members`,
    variants: () => [{ input: { party: 'supplier' } }, { input: { party: 'member' } }],
  },
  'purchasePayment.list': {
    base: 'business',
    reason: 'the purchase is looked up in the x-business-id business',
    variants: (victim) => [{ input: { purchaseId: victim.creditPurchase.id }, own: ['not_found'] }],
  },
  'purchasePayment.record': {
    base: 'business',
    reason:
      'the purchase is looked up (and locked) in the x-business-id business; a payment id used ' +
      'anywhere is CONFLICT',
    variants: (victim, attacker) => [
      {
        input: {
          id: newId(),
          purchaseId: victim.creditPurchase.id,
          businessDate: attacker.creditPurchase.businessDate,
          method: 'cash',
          amount: '1',
        },
        own: ['not_found'],
      },
      {
        input: {
          id: victim.payment.id,
          purchaseId: attacker.creditPurchase.id,
          businessDate: attacker.creditPurchase.businessDate,
          method: 'cash',
          amount: '1',
        },
        own: ['conflict'],
      },
    ],
  },
  'purchasePayment.reverse': {
    base: 'business',
    reason: 'the payment is looked up in the x-business-id business',
    variants: (victim) => [{ input: { id: victim.payment.id }, own: ['not_found'] }],
  },
  'books.get': { base: 'business', reason: NO_ROWS },
  'books.close': {
    base: 'business',
    reason: NO_ROWS,
    variants: () => [{ input: { closedThrough: null } }],
  },
  'material.costs': {
    base: 'business',
    reason: 'every id is looked up in the x-business-id business (NOT_FOUND otherwise)',
    variants: (victim, attacker) => [
      { input: { ids: [victim.material.id] }, own: ['not_found'] },
      { input: { ids: [attacker.material.id, victim.material.id] }, own: ['not_found'] },
    ],
  },
  // Recipes and product costs (M2 Step 4): the product, each line's material and pack are looked up
  // in the x-business-id business (a pack only among its own material's), and a line id used anywhere
  // is CONFLICT (its primary key).
  'recipe.get': {
    base: 'business',
    reason: 'the product is looked up in the x-business-id business',
    variants: (victim) => [{ input: { productId: victim.product.id }, own: ['not_found'] }],
  },
  'recipe.save': {
    base: 'business',
    reason:
      'the product and every material are looked up in the x-business-id business, a pack among ' +
      'its own material’s packs, and a line id used anywhere is CONFLICT',
    variants: (victim, attacker) => [
      {
        input: { productId: victim.product.id, version: victim.recipe.version, lines: [] },
        own: ['not_found'],
      },
      {
        input: {
          productId: attacker.product.id,
          version: attacker.recipe.version,
          lines: [{ id: newId(), materialId: victim.material.id, qty: '1', unit: 'l' }],
        },
        own: ['not_found'],
      },
      {
        input: {
          productId: attacker.product.id,
          version: attacker.recipe.version,
          lines: [
            {
              id: newId(),
              materialId: attacker.material.id,
              qty: '1',
              packId: victim.material.packs[0]?.id,
            },
          ],
        },
        own: ['validation'],
      },
      {
        input: {
          productId: attacker.product.id,
          version: attacker.recipe.version,
          lines: [
            {
              id: victim.recipe.lines[0]?.id,
              materialId: attacker.material.id,
              qty: '1',
              unit: 'l',
            },
          ],
        },
        own: ['conflict'],
      },
    ],
  },
  'product.costs': {
    base: 'business',
    reason: 'every id is looked up in the x-business-id business (NOT_FOUND otherwise)',
    variants: (victim, attacker) => [
      { input: { ids: [victim.product.id] }, own: ['not_found'] },
      { input: { ids: [attacker.product.id, victim.resaleProduct.id] }, own: ['not_found'] },
    ],
  },
  // Expenses, their categories and payments, and running costs (M2 Step 5): every reference is
  // looked up in the x-business-id business, ids used anywhere are CONFLICT, and composite foreign
  // keys keep a category, supplier, location and member inside their business.
  'costCategory.list': {
    base: 'business',
    reason: `${NO_ROWS}; the cursor only positions a page inside that business`,
    variants: () => [{ input: { search: 'clean', status: 'all' } }],
  },
  'costCategory.create': {
    base: 'business',
    reason: 'an id already used anywhere is CONFLICT (insertIdempotent), the row is never read',
    variants: (victim) => [
      { input: { id: victim.category.id, name: `Pwned ${newId()}` }, own: ['conflict'] },
    ],
  },
  'costCategory.update': {
    base: 'business',
    reason: 'looked up in the x-business-id business',
    variants: (victim) => [
      {
        input: { id: victim.category.id, version: victim.category.version, name: 'Pwned' },
        own: ['not_found'],
      },
    ],
  },
  'costCategory.archive': {
    base: 'business',
    reason: 'looked up in the x-business-id business',
    variants: (victim) => [{ input: { id: victim.category.id }, own: ['not_found'] }],
  },
  'costCategory.unarchive': {
    base: 'business',
    reason: 'looked up in the x-business-id business',
    variants: (victim) => [{ input: { id: victim.category.id }, own: ['not_found'] }],
  },
  'expense.list': {
    base: 'business',
    reason: `${NO_ROWS}; a category or supplier filter is looked up in that business (NOT_FOUND)`,
    variants: (victim) => [
      { input: { status: 'all' } },
      { input: { categoryId: victim.category.id }, own: ['not_found'] },
      { input: { supplierId: victim.supplier.id }, own: ['not_found'] },
    ],
  },
  'expense.get': {
    base: 'business',
    reason: 'looked up in the x-business-id business',
    variants: (victim) => [{ input: { id: victim.expense.id }, own: ['not_found'] }],
  },
  // A member's own records (D-181): filtered on the caller in the x-business-id business.
  'expense.mine': {
    base: 'business',
    reason: `${NO_ROWS}: only the expenses the caller entered or paid there`,
    variants: () => [{ input: {} }, { input: { limit: 1 } }],
  },
  'expense.getMine': {
    base: 'business',
    reason: 'looked up in the x-business-id business, among the caller’s own expenses',
    variants: (victim) => [{ input: { id: victim.expense.id }, own: ['not_found'] }],
  },
  'payable.mine': {
    base: 'business',
    reason: `${NO_ROWS}: only what the caller paid there from their own money`,
    variants: () => [{ input: {} }],
  },
  'expense.payers': { base: 'business', reason: `${NO_ROWS}: its own active members` },
  'expense.settings': { base: 'business', reason: NO_ROWS },
  'expense.updateSettings': {
    base: 'business',
    reason: NO_ROWS,
    variants: () => [{ input: { approval: true } }],
  },
  'expense.create': {
    base: 'business',
    reason:
      'its category, supplier, location and the member who paid are looked up in the ' +
      'x-business-id business, and an id used anywhere is CONFLICT',
    variants: (victim, attacker) => {
      const draft = (extra: object) => ({
        id: newId(),
        categoryId: attacker.category.id,
        businessDate: attacker.expense.businessDate,
        documentType: 'no_invoice',
        paymentMethod: 'cash',
        amount: '1',
        ...extra,
      })
      return [
        { input: draft({ id: victim.expense.id }), own: ['conflict'] },
        { input: draft({ categoryId: victim.category.id }), own: ['not_found'] },
        { input: draft({ supplierId: victim.supplier.id }), own: ['not_found'] },
        { input: draft({ locationId: victim.defaultLocationId }), own: ['not_found'] },
        {
          input: draft({ paymentMethod: 'paid_by_member', paidByMemberId: victim.adminMemberId }),
          own: ['not_found'],
        },
      ]
    },
  },
  'expense.update': {
    base: 'business',
    reason: 'the draft and every row it names are looked up in the x-business-id business',
    variants: (victim, attacker) => {
      const fields = (tenant: Tenant, extra: object = {}) => ({
        categoryId: tenant.category.id,
        businessDate: tenant.draftExpense.businessDate,
        documentType: 'no_invoice',
        paymentMethod: 'cash',
        amount: '1',
        ...extra,
      })
      return [
        {
          input: {
            id: victim.draftExpense.id,
            version: victim.draftExpense.version,
            ...fields(victim),
          },
          own: ['not_found'],
        },
        {
          input: {
            id: attacker.draftExpense.id,
            version: attacker.draftExpense.version,
            ...fields(attacker, { categoryId: victim.category.id }),
          },
          own: ['not_found'],
        },
      ]
    },
  },
  'expense.discard': {
    base: 'business',
    reason: 'looked up (and locked) in the x-business-id business',
    variants: (victim) => [
      {
        input: { id: victim.draftExpense.id, version: victim.draftExpense.version },
        own: ['not_found'],
      },
    ],
  },
  'expense.submit': {
    base: 'business',
    reason: 'looked up (and locked) in the x-business-id business',
    variants: (victim) => [
      {
        input: { id: victim.draftExpense.id, version: victim.draftExpense.version },
        own: ['not_found'],
      },
    ],
  },
  'expense.approve': {
    base: 'business',
    reason: 'looked up (and locked) in the x-business-id business',
    variants: (victim) => [
      {
        input: { id: victim.submittedExpense.id, version: victim.submittedExpense.version },
        own: ['not_found'],
      },
    ],
  },
  'expense.reject': {
    base: 'business',
    reason: 'looked up (and locked) in the x-business-id business',
    variants: (victim) => [
      {
        input: {
          id: victim.submittedExpense.id,
          version: victim.submittedExpense.version,
          reason: 'Pwned',
        },
        own: ['not_found'],
      },
    ],
  },
  'expense.post': {
    base: 'business',
    reason: 'looked up (and locked) in the x-business-id business',
    variants: (victim) => [
      {
        input: { id: victim.draftExpense.id, version: victim.draftExpense.version },
        own: ['not_found'],
      },
    ],
  },
  'expense.reverse': {
    base: 'business',
    reason: 'looked up (and locked) in the x-business-id business',
    variants: (victim) => [{ input: { id: victim.expense.id }, own: ['not_found'] }],
  },
  'expense.correct': {
    base: 'business',
    reason:
      'the expense is looked up in the x-business-id business; a new id used anywhere is ' +
      'CONFLICT and the whole correction (its reversal too) is rolled back',
    variants: (victim, attacker) => [
      { input: { id: victim.expense.id, newId: newId() }, own: ['not_found'] },
      { input: { id: attacker.expense.id, newId: victim.draftExpense.id }, own: ['conflict'] },
    ],
  },
  'expensePayment.list': {
    base: 'business',
    reason: 'the expense is looked up in the x-business-id business',
    variants: (victim) => [{ input: { expenseId: victim.expense.id }, own: ['not_found'] }],
  },
  'expensePayment.record': {
    base: 'business',
    reason:
      'the expense is looked up (and locked) in the x-business-id business; a payment id used ' +
      'anywhere is CONFLICT',
    variants: (victim, attacker) => [
      {
        input: {
          id: newId(),
          expenseId: victim.expense.id,
          businessDate: attacker.expense.businessDate,
          method: 'cash',
          amount: '1',
        },
        own: ['not_found'],
      },
      {
        input: {
          id: victim.expensePayment.id,
          expenseId: attacker.expense.id,
          businessDate: attacker.expense.businessDate,
          method: 'cash',
          amount: '1',
        },
        own: ['conflict'],
      },
    ],
  },
  'expensePayment.reverse': {
    base: 'business',
    reason: 'the payment is looked up in the x-business-id business',
    variants: (victim) => [{ input: { id: victim.expensePayment.id }, own: ['not_found'] }],
  },
  'runningCost.list': {
    base: 'business',
    reason: `${NO_ROWS}; a category filter is looked up in that business (NOT_FOUND)`,
    variants: (victim) => [
      { input: { state: 'all' } },
      { input: { categoryId: victim.category.id }, own: ['not_found'] },
    ],
  },
  'runningCost.get': {
    base: 'business',
    reason: 'looked up in the x-business-id business',
    variants: (victim) => [{ input: { id: victim.runningCost.id }, own: ['not_found'] }],
  },
  'runningCost.create': {
    base: 'business',
    reason:
      'its category is looked up in the x-business-id business; an id used anywhere is CONFLICT',
    variants: (victim, attacker) => [
      {
        input: {
          id: victim.runningCost.id,
          name: 'Pwned',
          categoryId: attacker.category.id,
          amount: '1',
          startsOn: attacker.runningCost.startsOn,
        },
        own: ['conflict'],
      },
      {
        input: {
          id: newId(),
          name: 'Pwned',
          categoryId: victim.category.id,
          amount: '1',
          startsOn: attacker.runningCost.startsOn,
        },
        own: ['not_found'],
      },
    ],
  },
  'runningCost.update': {
    base: 'business',
    reason: 'the record and its category are looked up in the x-business-id business',
    variants: (victim, attacker) => [
      {
        input: {
          id: victim.runningCost.id,
          version: victim.runningCost.version,
          name: 'Pwned',
          categoryId: victim.category.id,
          amount: '1',
          startsOn: victim.runningCost.startsOn,
        },
        own: ['not_found'],
      },
      {
        input: {
          id: attacker.runningCost.id,
          version: attacker.runningCost.version,
          name: attacker.runningCost.name,
          categoryId: victim.category.id,
          amount: '1',
          startsOn: attacker.runningCost.startsOn,
        },
        own: ['not_found'],
      },
    ],
  },
  'runningCost.remove': {
    base: 'business',
    reason: 'looked up in the x-business-id business',
    variants: (victim) => [
      {
        input: { id: victim.runningCost.id, version: victim.runningCost.version },
        own: ['not_found'],
      },
    ],
  },
}

// A stand-in tenant for reading the probes' shape before the fixture exists (never sent).
const STUB_FIELD = {
  id: newId(),
  version: 1,
  path: 'stub',
  email: 'stub@test.bizcost.local',
  name: 'stub',
  packs: [{ id: newId(), name: 'stub' }],
  lines: [{ id: newId() }],
  businessDate: '2026-01-01',
  resaleMaterialId: newId(),
  startsOn: '2026-01-01',
  description: 'stub',
}
const STUB = new Proxy({} as Tenant, {
  get: (_target, key) => (key === 'roles' ? new Proxy({}, { get: () => STUB_FIELD }) : STUB_FIELD),
})

const PROCEDURES = proceduresOf(appRouter)
const BUSINESS = PROCEDURES.filter((p) => p.base === 'business')
const OWN_BUSINESS = BUSINESS.filter((p) =>
  probeOf(p)
    .variants?.(STUB, STUB)
    .some((v) => v.own),
)
const OUTSIDE = PROCEDURES.filter((p) => p.base !== 'business')

function probeOf(procedure: ProcedureInfo): Probe {
  const probe = PROBES[procedure.path]
  if (!probe) throw new Error(`${procedure.path} has no probe`)
  return probe
}

/** Field names that name a row or an object (and their plurals, e.g. `locationIds`). */
const REFERENCE_NAME = /^(?:ids?|paths?|tokens?)$|(?:Ids?|Paths?|Tokens?)$/

function isUuidString(def: z.core.$ZodTypeDef): boolean {
  const format = (def as { format?: string }).format
  return def.type === 'string' && (format === 'guid' || format === 'uuid')
}

/**
 * Fields of an input schema that name a row or an object: UUIDs, paths and tokens, by format or by
 * name. Walks inputs the way src/redact.ts walks outputs: object fields (and catchall), array items
 * and record values (`x.*`, a record keyed by UUIDs is a reference itself), tuple items, every union
 * option, both intersection sides, pipes and lazy schemas. A leaf is named by its nearest field.
 */
function referenceFields(
  schema: z.core.$ZodType,
  path: string[] = [],
  seen: Set<z.core.$ZodType> = new Set(),
): string[] {
  const def = schema._zod.def
  const walk = (inner: z.core.$ZodType, at: string[] = path) => referenceFields(inner, at, seen)
  const unique = (paths: string[]) => [...new Set(paths)]
  if (FIELD_WRAPPER_TYPES.has(def.type)) return walk((def as z.core.$ZodOptionalDef).innerType)
  switch (def.type) {
    case 'pipe': {
      const pipe = def as z.core.$ZodPipeDef
      return unique([...walk(pipe.in), ...walk(pipe.out)])
    }
    case 'lazy': {
      if (seen.has(schema)) return []
      seen.add(schema)
      return walk((def as z.core.$ZodLazyDef).getter())
    }
    case 'object': {
      const { shape, catchall } = def as z.core.$ZodObjectDef
      return [
        ...Object.entries(shape).flatMap(([key, field]) => walk(field, [...path, key])),
        ...(catchall ? walk(catchall, [...path, '*']) : []),
      ]
    }
    case 'array':
      return walk((def as z.core.$ZodArrayDef).element, [...path, '*'])
    case 'record': {
      const { keyType, valueType } = def as z.core.$ZodRecordDef
      const keyIsReference = isUuidString(keyType._zod.def) ? [[...path, '*'].join('.')] : []
      return unique([...keyIsReference, ...walk(valueType, [...path, '*'])])
    }
    case 'tuple': {
      const { items, rest } = def as z.core.$ZodTupleDef
      return unique([
        ...items.flatMap((item, index) => walk(item, [...path, String(index)])),
        ...(rest ? walk(rest, [...path, '*']) : []),
      ])
    }
    case 'union':
      return unique((def as z.core.$ZodUnionDef).options.flatMap((option) => walk(option)))
    case 'intersection': {
      const { left, right } = def as z.core.$ZodIntersectionDef
      return unique([...walk(left), ...walk(right)])
    }
  }
  const name = path.findLast((segment) => segment !== '*' && !/^\d+$/.test(segment)) ?? ''
  return isUuidString(def) || REFERENCE_NAME.test(name) ? [path.join('.')] : []
}

function inputSchemaOf(path: string): z.core.$ZodType | undefined {
  const procedures = appRouter._def.procedures as unknown as Record<
    string,
    { _def: { inputs: unknown[] } }
  >
  const procedure = procedures[path]
  return procedure?._def.inputs[0] as z.core.$ZodType | undefined
}

describe('the matrix covers every procedure', () => {
  it('has exactly one probe per procedure of appRouter, with its base and a reason', () => {
    expect(Object.keys(PROBES).sort()).toEqual(PROCEDURES.map((p) => p.path))
    for (const procedure of PROCEDURES) {
      const probe = probeOf(procedure)
      expect(probe.base, procedure.path).toBe(procedure.base)
      expect(probe.reason.length, procedure.path).toBeGreaterThan(10)
      expect(Boolean(probe.variants), `${procedure.path}: an input needs variants`).toBe(
        procedure.takesInput,
      )
      if (procedure.base !== 'business') expect(probe.answer, procedure.path).toBeDefined()
      else expect(probe.answer, procedure.path).toBeUndefined()
    }
  })

  it('the walk finds references inside arrays, records, tuples, unions, intersections and lazy schemas', () => {
    const uuid = z.uuid()
    const node: z.ZodType = z.lazy(() =>
      z.object({ parentId: uuid.optional(), children: z.array(node) }),
    )
    const schema = z.object({
      id: z.string(),
      name: z.string(),
      permissionKeys: z.array(z.string()),
      locationIds: z.array(z.string()),
      lines: z.array(z.object({ productId: z.string(), quantity: z.string() })),
      byMember: z.record(uuid, z.boolean()),
      prices: z.record(z.string(), z.object({ supplierId: uuid.nullable() })),
      pair: z.tuple([z.string(), uuid], z.object({ path: z.string() })),
      item: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('a'), id: z.string() }),
        z.object({ kind: z.literal('b'), token: z.string() }),
      ]),
      both: z.intersection(z.object({ roleId: z.string() }), z.object({ note: z.string() })),
      tree: node,
      raw: z.string().pipe(z.uuid()),
    })
    expect(referenceFields(schema).sort()).toEqual(
      [
        'id',
        'locationIds.*',
        'lines.*.productId',
        'byMember.*',
        'prices.*.supplierId',
        'pair.1',
        'pair.*.path',
        'item.id',
        'item.token',
        'both.roleId',
        'tree.parentId',
        'raw',
      ].sort(),
    )
  })

  it('sees the module key of business.customize (item.id, inside a discriminated union) and classifies it', () => {
    const schema = inputSchemaOf('business.customize')
    expect(schema && referenceFields(schema)).toEqual(['item.id'])
    expect(Object.keys(PROBES['business.customize']?.notReferences ?? {})).toEqual(['item.id'])
  })

  it('says how the victim’s reference is refused for every input that names a row', () => {
    const withReferences: string[] = []
    for (const procedure of PROCEDURES) {
      const schema = inputSchemaOf(procedure.path)
      const found = schema ? referenceFields(schema) : []
      const probe = probeOf(procedure)
      // A classification must name a field the walk finds (no stale entries).
      for (const path of Object.keys(probe.notReferences ?? {})) {
        expect(found, `${procedure.path}: notReferences.${path}`).toContain(path)
      }
      const references = found.filter((path) => !probe.notReferences?.[path])
      if (references.length === 0) continue
      withReferences.push(procedure.path)
      if (procedure.base === 'business') {
        expect(
          probe.variants?.(STUB, STUB).some((v) => v.own),
          `${procedure.path} (${references.join(', ')}): add a variant with the answers in the attacker's own business`,
        ).toBe(true)
      } else {
        expect(
          probe.answer,
          `${procedure.path} (${references.join(', ')}): a victim's reference must be refused`,
        ).not.toBe('ok')
      }
    }
    // The walk finds references at all (ids, paths, tokens).
    expect(withReferences).toEqual(
      expect.arrayContaining([
        'account.setLastBusiness',
        'business.setLogo',
        'invitation.accept',
        'location.rename',
        'member.changeRole',
        'role.updatePermissions',
      ]),
    )
  })
})

let api: Api
const tenants = {} as Record<'A' | 'B', Tenant>

beforeAll(async () => {
  api = openApi()
  tenants.A = await createTenant(api, 'A')
  tenants.B = await createTenant(api, 'B')
}, 120_000)

afterAll(async () => {
  await api.close()
})

const DIRECTIONS = [
  ['A', 'B'],
  ['B', 'A'],
] as const

function members(tenant: Tenant): [string, Person][] {
  return [
    ['owner', tenant.owner],
    ['admin', tenant.admin],
    ['employee', tenant.employee],
  ]
}

describe('control: the leak check sees a business’s data', () => {
  it('finds the business’s markers in what its own owner reads', async () => {
    const tenant = tenants.B
    for (const path of ['business.profile', 'member.list', 'location.list', 'invitation.list']) {
      const result = await query(api.handler, path, {
        token: tenant.owner.token,
        businessId: tenant.id,
      })
      expect(result.error, path).toBeUndefined()
      expect(leaksOf(result.raw, tenant).length, path).toBeGreaterThan(0)
    }
    const me = await query(api.handler, 'me', { token: tenant.owner.token })
    expect(leaksOf(me.raw, tenant)).toEqual(
      expect.arrayContaining([tenant.id, tenant.legalName, tenant.legalNameAr, tenant.logoPath]),
    )
  })
})

describe.each(DIRECTIONS)('business %s attacks business %s', (attackerKey, victimKey) => {
  const attacker = () => tenants[attackerKey]
  const victim = () => tenants[victimKey]
  let victimBefore: Record<string, string>

  beforeAll(async () => {
    victimBefore = await tenantDigest(api.admin, victim())
  })

  it.each(BUSINESS.map((p) => [p.path, p] as const))(
    '%s with the victim’s x-business-id: FORBIDDEN for the owner, the Admin and the Employee',
    async (_path, procedure) => {
      const variants = probeOf(procedure).variants?.(victim(), attacker()) ?? [{ input: undefined }]
      for (const [role, person] of members(attacker())) {
        for (const { input } of variants) {
          const result = await callProcedure(api.handler, procedure, person.token, {
            businessId: victim().id,
            input,
          })
          const what = `${procedure.path} as ${role}`
          expect(result.status, what).toBe(403)
          expect(result.error?.data.appCode, what).toBe('forbidden')
          expect(result.headers.get('x-permissions-version'), what).toBeNull()
          expect(leaksOf(result.raw, victim(), input), what).toEqual([])
        }
      }
    },
  )

  it.each(OWN_BUSINESS.map((p) => [p.path, p] as const))(
    '%s in the attacker’s own business with the victim’s ids: refused',
    async (_path, procedure) => {
      for (const { input, own } of probeOf(procedure).variants?.(victim(), attacker()) ?? []) {
        if (!own) continue
        const result = await callProcedure(api.handler, procedure, attacker().owner.token, {
          businessId: attacker().id,
          input,
        })
        const what = `${procedure.path} ${JSON.stringify(input)}`
        expect(own, `${what}: ${result.raw}`).toContain(result.error?.data.appCode)
        expect(leaksOf(result.raw, victim(), input), what).toEqual([])
      }
    },
  )

  it.each(OUTSIDE.map((p) => [p.path, p] as const))(
    '%s (outside any business) serves the attacker nothing of the victim',
    async (_path, procedure) => {
      const probe = probeOf(procedure)
      const variants = probe.variants?.(victim(), attacker()) ?? [{ input: undefined }]
      for (const { input } of variants) {
        // x-business-id of the victim is ignored outside business procedures.
        const token = procedure.base === 'public' ? undefined : attacker().owner.token
        for (const businessId of [undefined, victim().id]) {
          const result = await callProcedure(api.handler, procedure, token, { businessId, input })
          const what = `${procedure.path} ${businessId ? 'with' : 'without'} x-business-id`
          if (probe.answer === 'ok') expect(result.error, `${what}: ${result.raw}`).toBeUndefined()
          else expect(probe.answer, `${what}: ${result.raw}`).toContain(result.error?.data.appCode)
          expect(leaksOf(result.raw, victim(), input), what).toEqual([])
        }
      }
    },
  )

  it('x-business-id spelled otherwise (capitals, spaces, two ids) opens nothing of the victim', async () => {
    const spellings = [
      victim().id.toUpperCase(),
      ` ${victim().id} `,
      `${attacker().id}, ${victim().id}`,
      `${victim().id},${attacker().id}`,
    ]
    for (const spelling of spellings) {
      for (const path of ['business.context', 'business.profile', 'member.list']) {
        const result = await query(api.handler, path, {
          token: attacker().owner.token,
          headers: { 'x-business-id': spelling },
        })
        expect(['forbidden', 'validation'], `${path} ${spelling}`).toContain(
          result.error?.data.appCode,
        )
        expect(leaksOf(result.raw, victim()), `${path} ${spelling}`).toEqual([])
      }
    }
  })

  it('leaves the victim exactly as it was: rows, audit log, profiles and Storage objects', async () => {
    const attackerIds = members(attacker()).map(([, person]) => person.user.id)
    const [audited] = await api.admin<{ n: number }[]>`
      select count(*)::int as n from app.audit_log
       where business_id = ${victim().id} and actor_user_id = any(${attackerIds}::uuid[])`
    expect(audited?.n).toBe(0)
    expect(await tenantDigest(api.admin, victim())).toEqual(victimBefore)
  })
})
