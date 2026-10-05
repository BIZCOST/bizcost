import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { STARTER_SALES_CHANNELS } from '@bizcost/domain'
import { createI18n, type I18nKey } from '@bizcost/i18n'
import { starterSalesChannels } from '@bizcost/modules'
import { describe, expect, it } from 'vitest'

// The starter sales channels (M3 Step 2, D-226): new businesses get them from Smart Setup
// (seedSalesChannels), the businesses that existed got them from the sales_security migration. Both
// must name the same channels, of the same kinds, in the same words, for the same answers.

const migrations = fileURLToPath(new URL('../../../../supabase/migrations/', import.meta.url))

function migration(): string {
  const file = readdirSync(migrations).find((name) => name.endsWith('_sales_security.sql'))
  if (!file) throw new Error('migration sales_security not found')
  return readFileSync(join(migrations, file), 'utf8')
}

describe('the starter sales channels', () => {
  const en = createI18n({ locale: 'en', namespaces: ['setup'] })
  const ar = createI18n({ locale: 'ar', namespaces: ['setup'] })
  const name = (i18n: typeof en, key: string) =>
    i18n.t(`setup.sales_channels.${key}` as I18nKey).replaceAll("'", "''")

  it('the migration gave businesses made before the same channels as Smart Setup (a guard)', () => {
    const sql = migration()
    const answers = { shop: 'walk_in', messages: 'messages', online: 'online' } as const
    for (const [position, channel] of STARTER_SALES_CHANNELS.entries()) {
      if (channel.key === 'direct') {
        expect(sql).toContain(
          `'${channel.kind}', '${name(en, 'direct')}', '${name(ar, 'direct')}', ${position + 1}`,
        )
        continue
      }
      const row = `('${channel.key}', '${answers[channel.key]}', '${channel.kind}', '${name(en, channel.key)}', '${name(ar, channel.key)}', ${position + 1})`
      expect(sql, channel.key).toContain(row)
      // The same answer gives the same channel in Smart Setup.
      expect(starterSalesChannels({ sales_channels: [answers[channel.key]] })).toEqual([
        channel.key,
      ])
    }
  })

  it('Smart Setup: the channels the answers name, in their order; "Direct" when none fits', () => {
    expect(starterSalesChannels({ sales_channels: ['online', 'walk_in', 'quotes'] })).toEqual([
      'shop',
      'online',
    ])
    expect(starterSalesChannels({ sales_channels: ['messages'] })).toEqual(['messages'])
    expect(starterSalesChannels({ sales_channels: ['quotes', 'invoice_later'] })).toEqual([
      'direct',
    ])
    expect(starterSalesChannels({})).toEqual(['direct'])
  })
})
