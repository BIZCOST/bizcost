import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { compareDecimal, sumDecimals } from '@bizcost/domain'
import { describe, expect, it } from 'vitest'
import type { DemoQuotation } from './documents'
import type { DemoInvoices } from './invoices'
import { DEMO_PERSONAS, type DemoPersona } from './personas'

// The demo's documents (demo/documents.ts, demo/invoices.ts; Release B, M3 Step 9) hold together
// before they reach the API: every invoice names a quotation, an order, a sale or a customer of its own
// business, payment stages add up to 100, a credit note takes back a line its invoice has, the sample
// images exist, every TRN is one business's own, and each persona the owner reviews Release B on has
// what the plan's Step 9 gives it.

const IMAGES = fileURLToPath(new URL('../scripts/samples/images/', import.meta.url))

const persona = (title: RegExp): DemoPersona => {
  const found = DEMO_PERSONAS.find((p) => title.test(p.title))
  if (!found) throw new Error(`no persona ${title}`)
  return found
}

/**
 * What each sample picture shows (scripts/samples/images; the sample quotation's lines name them),
 * and what a demo line printed beside it must describe (Release B review: the owner read wardrobes
 * beside bookshelves). A picture not listed here is added with what it shows before a line uses it.
 */
const PICTURES: Readonly<Record<string, RegExp>> = {
  'line-1.jpg': /تكسية|cladding/i, // wall panelling in wood veneer
  'line-2.jpg': /تلفزيون|TV/i, // a wall-hung TV unit
  'line-3.jpg': /رفوف|مكتبة|shel/i, // shelves of books
  'line-4.jpg': /خزانة عرض|display/i, // a glass-door display cabinet
  'line-5.jpg': /بوفيه|sideboard/i, // a sideboard under a mirror
  'line-7.jpg': /خزانة ملابس|wardrobe/i, // a wardrobe, a mirror on its middle door
  'line-12.jpg': /مطبخ|kitchen/i, // kitchen base and upper cabinets
  'line-15.jpg': /طاولة|table/i, // a round pedestal table
}

/** The lines a quotation's latest revision has. */
const latestLines = (q: DemoQuotation) => q.revision?.lines ?? q.lines

describe.each(DEMO_PERSONAS.filter((p) => p.documents).map((p) => [p.title, p] as const))(
  '%s: its documents',
  (_title, p) => {
    const documents = p.documents!

    it('names sample images that exist, and quotes for its own customers with stages adding up to 100', () => {
      for (const file of [documents.logo, documents.signature, documents.stamp]) {
        if (file) expect(existsSync(`${IMAGES}${file}`), file).toBe(true)
      }
      const customers = new Set((p.costing?.customers ?? []).map((c) => c.name))
      const refs = new Set<string>()
      for (const q of documents.quotations) {
        expect(customers.has(q.customer), q.customer).toBe(true)
        expect(refs.has(q.customerRef), q.customerRef).toBe(false)
        refs.add(q.customerRef)
        if (q.stages?.length) {
          expect(compareDecimal(sumDecimals(q.stages.map((s) => s.percent)), '100')).toBe(0)
        }
        for (const line of [...q.lines, ...(q.revision?.lines ?? [])]) {
          if (!line.picture) continue
          expect(existsSync(`${IMAGES}${line.picture}`), line.picture).toBe(true)
          // The picture shows what the line sells.
          const shows = PICTURES[line.picture]
          expect(shows, `what ${line.picture} shows`).toBeDefined()
          expect(line.description, line.picture).toMatch(shows!)
        }
        // A revision is made of a sent quotation, and dated on or after it.
        if (q.revision) {
          expect(q.send).toBe(true)
          expect(q.revision.daysAgo ?? 0).toBeLessThanOrEqual(q.daysAgo ?? 0)
        }
      }
    })

    it('types its address, bank lines and terms in its owner’s language', () => {
      // The owner reads each persona's PDFs: an Arabic-speaking owner's typed lines are in Arabic (the
      // IBAN line as banks print it), an English-speaking one's in English (Release B second review:
      // the workshop printed English terms and bank lines under «الشروط والأحكام»).
      const { letterhead, settings } = documents
      const lines = [
        letterhead.addressLine,
        letterhead.city,
        letterhead.tradeLicenceAuthority,
        settings.signatory,
        settings.footer,
        settings.quotationTerms,
      ]
        .flatMap((text) => (text ?? '').split('\n'))
        .filter((line) => line !== '' && !line.startsWith('IBAN:'))
      expect(lines.length).toBeGreaterThan(0)
      for (const line of lines) {
        if (p.owner.locale === 'ar') {
          expect(line, line).toMatch(/\p{Script=Arabic}/u)
          expect(line, line).not.toMatch(/[A-Za-z]/)
        } else {
          expect(line, line).not.toMatch(/\p{Script=Arabic}/u)
        }
      }
    })
  },
)

describe.each(DEMO_PERSONAS.filter((p) => p.invoices).map((p) => [p.title, p] as const))(
  '%s: its invoices',
  (_title, p) => {
    const invoices: DemoInvoices = p.invoices!

    it('come from a quotation, an order, a sale or a customer of its own, each once, on its letterhead', () => {
      expect(p.documents, 'a business that invoices has its letterhead').toBeDefined()
      const quotations = new Map((p.documents?.quotations ?? []).map((q) => [q.customerRef, q]))
      const orders = new Set((p.costing?.orders ?? []).map((o) => o.key))
      const sales = new Set((p.costing?.sales ?? []).map((s) => s.key))
      const customers = new Set([
        ...(p.costing?.customers ?? []).map((c) => c.key),
        ...(invoices.customers ?? []).map((c) => c.key),
      ])
      const keys = new Set<string>()
      for (const invoice of invoices.invoices) {
        expect(keys.has(invoice.key), invoice.key).toBe(false)
        keys.add(invoice.key)
        const from = invoice.from
        let lines: number
        if ('quotation' in from) {
          const quote = quotations.get(from.quotation)
          expect(quote, from.quotation).toBeDefined()
          expect(quote!.accept, `${from.quotation} is accepted`).toBe(true)
          if (from.stage !== undefined) {
            expect(from.stage).toBeLessThan(quote!.stages?.length ?? 0)
            lines = 1
          } else lines = latestLines(quote!).length
        } else if ('order' in from) {
          expect(orders.has(from.order), from.order).toBe(true)
          lines = Infinity
        } else if ('sale' in from) {
          expect(sales.has(from.sale), from.sale).toBe(true)
          lines = Infinity
        } else {
          expect(customers.has(from.scratch.customer), from.scratch.customer).toBe(true)
          lines = from.scratch.lines.length
        }
        for (const credited of invoice.credit?.lines ?? []) {
          expect(credited.line, `${invoice.key} has line ${credited.line}`).toBeLessThan(lines)
        }
      }
      for (const address of invoices.addresses ?? []) {
        expect(customers.has(address.customer), address.customer).toBe(true)
      }
    })
  },
)

describe('the TRNs of the demo', () => {
  it('are each one business’s own: no persona, customer or supplier shares one', () => {
    const seen = new Map<string, string>()
    const add = (trn: string | null | undefined, who: string) => {
      if (!trn) return
      expect(trn, who).toMatch(/^\d{15}$/)
      expect(seen.get(trn), `${who} and ${seen.get(trn)} share ${trn}`).toBeUndefined()
      seen.set(trn, who)
    }
    for (const p of DEMO_PERSONAS) {
      add(p.trn, p.title)
      for (const c of p.costing?.customers ?? []) add(c.trn, `${p.title}: ${c.name}`)
      for (const s of p.costing?.suppliers ?? []) add(s.trn, `${p.title}: ${s.name}`)
      for (const c of p.invoices?.customers ?? []) add(c.trn, `${p.title}: ${c.name}`)
    }
  })
})

describe("Release B's demo, as the plan's Step 9 gives it", () => {
  it('the fit-out company: a quote with a revision, a full tax invoice with a credit note, and a second quote billed in three stages of 30 / 40 / 30', () => {
    const fitOut = persona(/Fit-out/)
    const quotes = fitOut.documents!.quotations
    const revised = quotes.find((q) => q.revision)
    expect(revised?.accept).toBe(true)
    const invoices = fitOut.invoices!.invoices
    const full = invoices.find(
      (i) => 'quotation' in i.from && i.from.quotation === revised!.customerRef,
    )
    expect(full && 'quotation' in full.from && full.from.stage).toBeUndefined()
    expect(full?.credit).toBeDefined()
    const staged = quotes.find((q) => q.stages?.map((s) => s.percent).join('/') === '30/40/30')
    expect(staged?.accept).toBe(true)
    expect(
      invoices
        .filter((i) => 'quotation' in i.from && i.from.quotation === staged!.customerRef)
        .map((i) => ('quotation' in i.from ? i.from.stage : null)),
    ).toEqual([0, 1, 2])
  })

  it('the factory, the designer, the workshop, the café and the baker', () => {
    const factory = persona(/factory/).invoices!.invoices
    expect(factory.every((i) => 'order' in i.from)).toBe(true)
    const designer = persona(/designer/)
    expect(designer.documents!.quotations.length).toBeGreaterThanOrEqual(2)
    expect(designer.invoices!.invoices.filter((i) => 'sale' in i.from).length).toBeGreaterThan(1)
    const workshop = persona(/Workshop/)
    expect(workshop.documents!.quotations.length).toBeGreaterThan(0)
    const kitchen = workshop.invoices!.invoices.filter(
      (i) => 'order' in i.from && i.from.order === 'clinic-kitchen',
    )
    expect(
      kitchen.map((i) => ('order' in i.from ? (i.from.deposit ?? i.from.bills) : null)),
    ).toEqual([true, 'rest'])
    // The clinic's kitchen order bills a kitchen unit (D-310, D-322), with its recipe.
    const clinic = workshop.costing!.orders!.find((o) => o.key === 'clinic-kitchen')!
    const products = new Map(
      (workshop.costing!.products ?? []).map((product) => [product.key, product]),
    )
    for (const [product] of clinic.lines) {
      expect(products.get(product)?.name, product).toMatch(/مطبخ/)
      expect((workshop.costing!.recipes ?? []).some((recipe) => recipe.product === product)).toBe(
        true,
      )
    }
    const cafe = persona(/Coffee shop/)
    expect(cafe.turnOn).toContain('invoices')
    expect(cafe.invoices!.invoices.map((i) => i.countedElsewhere)).toEqual([true])
    // The home baker prints her customers' statements on her letterhead (B10).
    expect(persona(/baker/).documents).toBeDefined()
  })
})
