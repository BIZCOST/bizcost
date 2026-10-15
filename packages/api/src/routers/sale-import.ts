import {
  addImportRowsDto,
  addImportRowsInput,
  channelStatementListDto,
  channelStatementResultDto,
  createImportInput,
  createStatementInput,
  importIdInput,
  importListDto,
  importListInput,
  importProfileIdInput,
  importProfileListDto,
  importVersionInput,
  matchImportInput,
  okDto,
  reverseImportInput,
  saleImportResultDto,
  setImportOverlapInput,
  statementIdInput,
  statementListInput,
  statementVersionInput,
  updateStatementInput,
} from '@bizcost/contracts'
import {
  createStatement,
  discardStatement,
  getStatement,
  listStatements,
  postStatement,
  reverseStatement,
  updateStatement,
} from '../services/channel-statements'
import {
  addImportRows,
  createImport,
  discardImport,
  getImport,
  listImportProfiles,
  listImports,
  matchImport,
  postImport,
  removeImportProfile,
  reverseImport,
  setImportOverlap,
} from '../services/sale-imports'
import { businessProcedure, requireModule, requirePermission, router } from '../trpc'

/**
 * Importing sales from a file (services/sale-imports.ts; M3 Step 4): module `sales` (planned until
 * Release A, so served only under the dev-only preview, D-125) and Products & Services (the names are
 * matched to products); `sales.imports.manage`, which grants nothing without sales.documents.manage
 * and .post (PERMISSION_NEEDS). Reversing an import's day or the whole of it reverses finalized sales:
 * it needs sales.documents.reverse too, as sale.reverse does (D-260; replacing days asks it in the
 * service). Outputs are withMeta(): the fee column's total and the materials without a price are
 * `cost`.
 */
const importing = businessProcedure
  .use(requireModule('sales'))
  .use(requireModule('products'))
  .use(requirePermission('sales.imports.manage'))

export const saleImportRouter = router({
  /** `saleImport.list`: newest first; one's own without "see every sale", one's branches. */
  list: importing
    .input(importListInput)
    .output(importListDto)
    .query(({ ctx, input }) => listImports(ctx, input)),
  /** `saleImport.get`: a draft's preview, or what a finalized import posted. */
  get: importing
    .input(importIdInput)
    .output(saleImportResultDto)
    .query(({ ctx, input }) => getImport(ctx, input)),
  /** `saleImport.create`: a draft for a file read in the browser; the same file twice is refused. */
  create: importing
    .input(createImportInput)
    .output(saleImportResultDto)
    .mutation(({ ctx, input }) => createImport(ctx, input)),
  /** `saleImport.addRows`: up to IMPORT_ROWS_CHUNK of its rows (day × item totals). */
  addRows: importing
    .input(addImportRowsInput)
    .output(addImportRowsDto)
    .mutation(({ ctx, input }) => addImportRows(ctx, input)),
  /** `saleImport.match`: answers for its names, saved for the next files too. */
  match: importing
    .input(matchImportInput)
    .output(saleImportResultDto)
    .mutation(({ ctx, input }) => matchImport(ctx, input)),
  /** `saleImport.setOverlap`: days already imported are skipped or replaced. */
  setOverlap: importing
    .input(setImportOverlapInput)
    .output(saleImportResultDto)
    .mutation(({ ctx, input }) => setImportOverlap(ctx, input)),
  /** `saleImport.discard`: a draft is taken out. */
  discard: importing
    .input(importVersionInput)
    .output(okDto)
    .mutation(({ ctx, input }) => discardImport(ctx, input)),
  /** `saleImport.post`: one sale per day × branch × channel, costs frozen. Idempotent. */
  post: importing
    .input(importVersionInput)
    .output(saleImportResultDto)
    .mutation(({ ctx, input }) => postImport(ctx, input)),
  /** `saleImport.reverse`: the whole import or one day, with sale.reverse's key. Idempotent. */
  reverse: importing
    .use(requirePermission('sales.documents.reverse'))
    .input(reverseImportInput)
    .output(saleImportResultDto)
    .mutation(({ ctx, input }) => reverseImport(ctx, input)),
})

/** The layouts of files imported (one click maps the next file of the same export). */
const profiles = businessProcedure
  .use(requireModule('sales'))
  .use(requirePermission('sales.imports.manage'))

export const importProfileRouter = router({
  /** `importProfile.list`: the latest used first. */
  list: profiles.output(importProfileListDto).query(({ ctx }) => listImportProfiles(ctx)),
  /** `importProfile.remove`: a layout is forgotten. */
  remove: profiles
    .input(importProfileIdInput)
    .output(okDto)
    .mutation(({ ctx, input }) => removeImportProfile(ctx, input)),
})

/**
 * A channel's statements (services/channel-statements.ts): module `sales`, sales.channels.manage and
 * the costs switch (the service refuses without it: every amount is `cost`).
 */
const statements = businessProcedure
  .use(requireModule('sales'))
  .use(requirePermission('sales.channels.manage'))

export const channelStatementRouter = router({
  /** `channelStatement.list`: a channel's, the latest days first. */
  list: statements
    .input(statementListInput)
    .output(channelStatementListDto)
    .query(({ ctx, input }) => listStatements(ctx, input)),
  /** `channelStatement.get`. */
  get: statements
    .input(statementIdInput)
    .output(channelStatementResultDto)
    .query(({ ctx, input }) => getStatement(ctx, input)),
  /** `channelStatement.create`: a draft, idempotent on the client's id. */
  create: statements
    .input(createStatementInput)
    .output(channelStatementResultDto)
    .mutation(({ ctx, input }) => createStatement(ctx, input)),
  /** `channelStatement.update`: the whole draft, `version` as read. */
  update: statements
    .input(updateStatementInput)
    .output(channelStatementResultDto)
    .mutation(({ ctx, input }) => updateStatement(ctx, input)),
  /** `channelStatement.discard`: a draft is taken out. */
  discard: statements
    .input(statementVersionInput)
    .output(okDto)
    .mutation(({ ctx, input }) => discardStatement(ctx, input)),
  /** `channelStatement.post`: final; its fees replace the channel's for its days. Idempotent. */
  post: statements
    .input(statementVersionInput)
    .output(channelStatementResultDto)
    .mutation(({ ctx, input }) => postStatement(ctx, input)),
  /** `channelStatement.reverse`: a final statement is taken back. Idempotent. */
  reverse: statements
    .input(statementIdInput)
    .output(channelStatementResultDto)
    .mutation(({ ctx, input }) => reverseStatement(ctx, input)),
})
