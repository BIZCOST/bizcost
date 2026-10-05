import type {
  catalogIdInput,
  channelListInput,
  createChannelInput,
  SalesChannelDto,
  SalesChannelListDto,
  SalesChannelResultDto,
  updateChannelInput,
} from '@bizcost/contracts'
import { createIdempotent, salesChannels, type Tx } from '@bizcost/db'
import { newId, STARTER_SALES_CHANNELS, type Locale } from '@bizcost/domain'
import { createI18n, type I18nKey } from '@bizcost/i18n'
import type { SetupAnswers } from '@bizcost/modules'
import { starterSalesChannels } from '@bizcost/modules'
import { and, asc, eq, isNotNull, isNull, sql, type SQL } from 'drizzle-orm'
import type { z } from 'zod'
import type { BusinessCtx } from '../business-context'
import { AppError } from '../errors'
import { assertQueryable } from '../trpc'
import { requestHashOf, withUniqueName } from './catalog'

// Sales channels (ROADMAP.md M3 Step 2; DATA_MODEL.md §6; D-226): one table for every way a business
// sells (its shop, WhatsApp and phone, its website, a delivery app, a marketplace). Module `sales`:
// any sales key lists them (a sale names one), sales.channels.manage adds, renames, archives and
// brings one back (the router checks them). One name per business compared the way people read it
// (app.name_key, archived ones included; NAME_TAKEN), idempotent creates, versioned updates of the
// whole channel, archive and unarchive, never a delete. A business always keeps one active channel
// (LAST_CHANNEL). The commission % (`fee_percent`, Q8) is a `cost`: set and seen only with the costs
// switch (D-187): sending it without is FORBIDDEN (even null), and an update that leaves it out keeps
// it, so a member who cannot see it never replaces it.

type ListInput = z.output<typeof channelListInput>
type IdInput = z.output<typeof catalogIdInput>
type CreateInput = z.output<typeof createChannelInput>
type UpdateInput = z.output<typeof updateChannelInput>

/** The unique index on (business_id, app.name_key(name)) of live channels. */
const NAME_KEY = 'sales_channels_name_key'

const columns = {
  id: salesChannels.id,
  name: salesChannels.name,
  kind: salesChannels.kind,
  feePercent: sql<string | null>`trim_scale(${salesChannels.feePercent})::text`,
  archivedAt: salesChannels.archivedAt,
  version: salesChannels.version,
}

type Row = {
  id: string
  name: string
  kind: SalesChannelDto['kind']
  feePercent: string | null
  archivedAt: Date | null
  version: number
}

function toDto(row: Row): SalesChannelDto {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    feePercent: row.feePercent,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    version: row.version,
  }
}

async function find(tx: Tx, businessId: string, id: string): Promise<Row | undefined> {
  const [row] = await tx
    .select(columns)
    .from(salesChannels)
    .where(
      and(
        eq(salesChannels.businessId, businessId),
        eq(salesChannels.id, id),
        isNull(salesChannels.deletedAt),
      ),
    )
  return row
}

async function load(tx: Tx, businessId: string, id: string): Promise<SalesChannelDto> {
  const row = await find(tx, businessId, id)
  if (!row) throw new AppError('not_found')
  return toDto(row)
}

function result(data: SalesChannelDto): SalesChannelResultDto {
  return { data, meta: { redacted: [] } }
}

/** The commission % is said only by a member who sees costs (FORBIDDEN before anything is read). */
function assertFeeShown(ctx: BusinessCtx, feePercent: string | null | undefined): void {
  if (feePercent !== undefined) {
    assertQueryable(ctx, [{ name: 'feePercent', category: 'cost' }])
  }
}

/**
 * The starter channels of a new business, named in its language (Smart Setup; D-113: then plain
 * data): those its answers name, or "Direct" (starterSalesChannels). The sales_security migration
 * gave the businesses that existed before the same channels.
 */
export async function seedSalesChannels(
  tx: Tx,
  businessId: string,
  locale: Locale,
  answers: SetupAnswers,
): Promise<void> {
  const i18n = createI18n({ locale, namespaces: ['setup'] })
  const kinds = new Map(STARTER_SALES_CHANNELS.map((c) => [c.key, c.kind] as const))
  await tx.insert(salesChannels).values(
    starterSalesChannels(answers).map((key) => ({
      id: newId(),
      businessId,
      name: i18n.t(`setup.sales_channels.${key}` as I18nKey),
      kind: kinds.get(key) ?? 'other',
    })),
  )
}

/** `channel.list`: by name (case ignored), then id; active ones by default. */
export function listChannels(ctx: BusinessCtx, input: ListInput): Promise<SalesChannelListDto> {
  const conditions: SQL[] = [
    eq(salesChannels.businessId, ctx.businessId),
    isNull(salesChannels.deletedAt),
  ]
  if (input.status === 'active') conditions.push(isNull(salesChannels.archivedAt))
  if (input.status === 'archived') conditions.push(isNotNull(salesChannels.archivedAt))
  return ctx.tx(async (tx) => {
    const rows = await tx
      .select(columns)
      .from(salesChannels)
      .where(and(...conditions))
      .orderBy(sql`lower(${salesChannels.name})`, asc(salesChannels.id))
    return { data: { items: rows.map(toDto) }, meta: { redacted: [] } }
  })
}

/**
 * `channel.create`: idempotent on the client's id (the same payload again returns it; an id used by
 * another create or another business is CONFLICT). NAME_TAKEN when the business already has a channel
 * of that name (archived ones included).
 */
export function createChannel(
  ctx: BusinessCtx,
  input: CreateInput,
): Promise<SalesChannelResultDto> {
  assertFeeShown(ctx, input.feePercent)
  const values = { name: input.name, kind: input.kind, feePercent: input.feePercent ?? null }
  return withUniqueName(NAME_KEY, () =>
    ctx.tx(async (tx) => {
      const { row } = await createIdempotent(tx, salesChannels, {
        id: input.id,
        businessId: ctx.businessId,
        ...values,
        requestHash: requestHashOf(values),
      })
      if (row.deletedAt !== null) throw new AppError('conflict', { message: 'channel was removed' })
      return result(await load(tx, ctx.businessId, row.id))
    }),
  )
}

/**
 * `channel.update`: the whole channel, `version` as read (CONFLICT when it changed since). The
 * commission left out is kept as it is.
 */
export function updateChannel(
  ctx: BusinessCtx,
  input: UpdateInput,
): Promise<SalesChannelResultDto> {
  assertFeeShown(ctx, input.feePercent)
  return withUniqueName(NAME_KEY, () =>
    ctx.tx(async (tx) => {
      const [row] = await tx
        .update(salesChannels)
        .set({
          name: input.name,
          kind: input.kind,
          ...(input.feePercent === undefined ? {} : { feePercent: input.feePercent }),
        })
        .where(
          and(
            eq(salesChannels.businessId, ctx.businessId),
            eq(salesChannels.id, input.id),
            isNull(salesChannels.deletedAt),
            eq(salesChannels.version, input.version),
          ),
        )
        .returning({ id: salesChannels.id })
      if (!row) {
        if (await find(tx, ctx.businessId, input.id)) throw new AppError('conflict')
        throw new AppError('not_found')
      }
      return result(await load(tx, ctx.businessId, input.id))
    }),
  )
}

/**
 * `channel.archive`: hidden from pickers from now on; its sales keep it (never deleted). The last
 * active channel stays (LAST_CHANNEL): the business's channels are locked first, so two archives at
 * once never leave none.
 */
export function archiveChannel(ctx: BusinessCtx, input: IdInput): Promise<SalesChannelResultDto> {
  return ctx.tx(async (tx) => {
    const active = (await tx.execute(sql`
      select c.id from app.sales_channels c
       where c.business_id = ${ctx.businessId} and c.deleted_at is null and c.archived_at is null
       order by c.id
         for update
    `)) as unknown as { id: string }[]
    const channel = await find(tx, ctx.businessId, input.id)
    if (!channel) throw new AppError('not_found')
    if (channel.archivedAt === null) {
      if (active.length <= 1) throw new AppError('last_channel')
      await tx
        .update(salesChannels)
        .set({ archivedAt: sql`now()` })
        .where(and(eq(salesChannels.businessId, ctx.businessId), eq(salesChannels.id, input.id)))
    }
    return result(await load(tx, ctx.businessId, input.id))
  })
}

/** `channel.unarchive`: back in the pickers. */
export function unarchiveChannel(ctx: BusinessCtx, input: IdInput): Promise<SalesChannelResultDto> {
  return ctx.tx(async (tx) => {
    await tx
      .update(salesChannels)
      .set({ archivedAt: null })
      .where(
        and(
          eq(salesChannels.businessId, ctx.businessId),
          eq(salesChannels.id, input.id),
          isNull(salesChannels.deletedAt),
          isNotNull(salesChannels.archivedAt),
        ),
      )
    return result(await load(tx, ctx.businessId, input.id))
  })
}
