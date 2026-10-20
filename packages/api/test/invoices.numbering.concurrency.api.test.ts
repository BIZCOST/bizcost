import type { CreditNoteDto, InvoiceDto } from '@bizcost/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Person } from './purchasing'
import { codeOf, ok } from './purchasing'
import { InvoiceScope, InvoicesApi, typed } from './invoices'
import { Races } from './races'

// Invoice and credit note numbers (ROADMAP.md M3 Step 8; VAT ER Art. 59(1)(d): "a sequential Tax
// Invoice number"): taken at issue, in one gapless series per business, the counter locked last (D-283).
// Fifty drafts of five members issued at once get INV-0001…INV-0050, each once; every issue sent again
// at the same time is answered with its own number and takes none; a refused issue takes none; credit
// notes count in their own series (CN-0001…), and a series' first number is the business's own. The
// issues "at once" are spread over five API instances, each with its own database connection
// (races.ts), so they really run together (M3 Step 10; one instance runs its calls one at a time).
// m3.concurrency.api.test.ts adds refusals, discards and credit notes racing in the same rounds.

const api = new InvoicesApi()
const races = new Races(api.admin, 5)
afterAll(async () => {
  await races.close()
  await api.close()
})

/** An issue as `person` on API instance `i`. */
const issueOn = (scope: InvoiceScope, i: number, draft: InvoiceDto, person: Person = scope.owner) =>
  races.call<InvoiceDto>(
    scope,
    i,
    'invoice.issue',
    { id: draft.id, version: draft.version },
    person,
  )

const sorted = (numbers: readonly (string | null)[]) => [...numbers].sort()
const series = (prefix: string, from: number, count: number, padding = 4) =>
  Array.from({ length: count }, (_, i) => `${prefix}${String(from + i).padStart(padding, '0')}`)

describe('invoice numbers under contention', () => {
  let scope: InvoiceScope
  let members: Person[]
  let customerId: string
  beforeAll(async () => {
    scope = await InvoiceScope.open(api)
    await scope.taxReady()
    customerId = (await scope.buyer()).id
    members = [scope.owner]
    for (let i = 0; i < 4; i++) members.push(await api.member(scope, 'manager'))
  }, 60_000)

  it('50 drafts of 5 members issued at once: INV-0001…INV-0050, no gap, none twice; replays take none', async () => {
    const drafts: [Person, InvoiceDto][] = []
    for (const person of members) {
      for (let i = 0; i < 10; i++) {
        const draft = await scope.invoice(
          { customerId, lines: [typed(`Panel ${drafts.length + 1}`, '1', '100')] },
          person,
        )
        drafts.push([person, draft])
      }
    }
    // Each issue sent twice at the same time on two instances (a double tap, a retry): both answered.
    const results = await Promise.all(
      drafts.flatMap(([person, draft], k) => [
        issueOn(scope, k, draft, person),
        issueOn(scope, k + 2, draft, person),
      ]),
    )
    for (const result of results) expect(result.error, result.raw).toBeUndefined()
    const issued = results.map((r) => r.data!)
    for (let i = 0; i < drafts.length; i++) {
      // The two answers of one draft carry one number.
      expect(issued[2 * i]!.number).toBe(issued[2 * i + 1]!.number)
      expect(issued[2 * i]!.id).toBe(drafts[i]![1].id)
    }
    const numbers = drafts.map((_, i) => issued[2 * i]!.number)
    expect(sorted(numbers)).toEqual(series('INV-', 1, 50))
    // Issued again later: the same invoice, the same number, still none taken.
    const [person, draft] = drafts[7]!
    const again = ok(await scope.issueRaw(draft, person))
    expect(again.number).toBe(numbers[7])
    const next = await scope.issued({ customerId, lines: [typed('Door', '1', '50')] })
    expect(next.number).toBe('INV-0051')
  }, 120_000)

  it('a refused issue takes no number (DETAILS_MISSING, then VALIDATION)', async () => {
    // A registered customer with no address cannot be named on a tax invoice yet (B16, C5).
    const noAddress = await scope.customer({ kind: 'business', trn: '100555666700003' })
    const refused = await scope.invoice({
      customerId: noAddress.id,
      lines: [typed('Shelf', '1', '80')],
    })
    expect(codeOf(await scope.issueRaw(refused))).toBe('details_missing')
    expect((await scope.getInvoice(refused.id)).missing).toEqual(['customer_address'])
    const after = await scope.issued({ customerId, lines: [typed('Frame', '1', '40')] })
    expect(after.number).toBe('INV-0052')
    // The draft refused is still a draft without a number.
    expect(await scope.getInvoice(refused.id)).toMatchObject({ status: 'draft', number: null })
  })

  it('credit notes count in their own series: CN-0001, CN-0002, the invoices’ unchanged', async () => {
    const invoice = await scope.issued({
      customerId,
      lines: [typed('Wardrobe', '2', '500')],
    })
    expect(invoice.number).toBe('INV-0053')
    const drafts = await Promise.all(
      [1, 2].map(() =>
        scope.creditDraft(invoice.id, {
          by: 'amount',
          lines: [{ invoiceLineId: invoice.lines[0]!.id, amount: '10' }],
        }),
      ),
    )
    const notes = (
      await Promise.all(
        drafts.map((note, k) =>
          races.call<CreditNoteDto>(scope, k, 'creditNote.issue', {
            id: note.id,
            version: note.version,
          }),
        ),
      )
    ).map((result) => ok(result))
    expect(sorted(notes.map((n) => n.number))).toEqual(['CN-0001', 'CN-0002'])
    const later = await scope.issued({ customerId, lines: [typed('Drawer', '1', '30')] })
    expect(later.number).toBe('INV-0054')
  })
})

describe("a series' first number is the business's own", () => {
  it('invoices from 457 (Settings → Documents) and credit notes from 1, gapless at once', async () => {
    const scope = await InvoiceScope.open(api)
    await scope.taxReady()
    const customerId = (await scope.buyer()).id
    ok(
      await scope.updateDocumentSettings({
        series: [
          { series: 'invoice', prefix: 'TI-', padding: 0, firstNo: 457 },
          { series: 'credit_note', prefix: 'CR-', padding: 5 },
        ],
      }),
    )
    const drafts = await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        scope.invoice({ customerId, lines: [typed(`Counter ${i}`, '1', '200')] }),
      ),
    )
    const issued = (await Promise.all(drafts.map((draft, k) => issueOn(scope, k, draft)))).map(
      (result) => ok(result),
    )
    expect(sorted(issued.map((i) => i.number))).toEqual([
      'TI-457',
      'TI-458',
      'TI-459',
      'TI-460',
      'TI-461',
    ])
    const note = await scope.credit(issued[0]!.id, {
      by: 'amount',
      lines: [{ invoiceLineId: issued[0]!.lines[0]!.id, amount: '20' }],
    })
    expect(note.number).toBe('CR-00001')
    // Once the series has started, its first number is kept (SERIES_STARTED).
    const changed = await scope.updateDocumentSettings({
      series: [{ series: 'invoice', prefix: 'TI-', padding: 0, firstNo: 900 }],
    })
    expect(codeOf(changed)).toBe('series_started')
  })
})
