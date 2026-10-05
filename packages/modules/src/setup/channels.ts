import { STARTER_SALES_CHANNELS, type StarterSalesChannel } from '@bizcost/domain'
import type { SetupAnswers } from './answers'

// The sales channels a new business starts with (M3 Step 2, D-226): the ones its Smart Setup answers
// name (`sales_channels`: walk-in customers → "Shop", messages → "WhatsApp & phone", online →
// "Online"), or one "Direct" channel when none of these was chosen (quotes and "invoice later" are
// ways of being paid, not channels). The sales_tables migration gives the businesses that existed
// before the same channels from their stored answers; both must agree (a test compares them).

const BY_ANSWER = {
  walk_in: 'shop',
  messages: 'messages',
  online: 'online',
} as const satisfies Partial<
  Record<NonNullable<SetupAnswers['sales_channels']>[number], StarterSalesChannel>
>

/** The starter channels of these answers, in STARTER_SALES_CHANNELS order (never empty). */
export function starterSalesChannels(answers: SetupAnswers): readonly StarterSalesChannel[] {
  const named = new Set<StarterSalesChannel>(
    (answers.sales_channels ?? []).flatMap((answer) =>
      answer in BY_ANSWER ? [BY_ANSWER[answer as keyof typeof BY_ANSWER]] : [],
    ),
  )
  const keys = STARTER_SALES_CHANNELS.map((c) => c.key).filter((key) => named.has(key))
  return keys.length > 0 ? keys : ['direct']
}
