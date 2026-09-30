import {
  addAttachmentInput,
  attachmentIdInput,
  attachmentListDto,
  attachmentListInput,
  attachmentResultDto,
  attachmentUploadUrlDto,
  attachmentUploadUrlInput,
  okDto,
} from '@bizcost/contracts'
import type { AttachmentEntity } from '@bizcost/domain'
import type { BusinessCtx } from '../business-context'
import {
  addAttachment,
  attachmentUploadUrl,
  listAttachments,
  removeAttachment,
} from '../services/attachments'
import {
  assertAnyAccess,
  businessProcedure,
  requireAnyAccess,
  requireModule,
  router,
  type ModuleAccessPair,
} from '../trpc'

/**
 * Attachments (services/attachments.ts): access follows the record. A purchase's receipts need the
 * purchases module and purchases.documents.view to list, .manage to add or remove; an expense's
 * receipts the expenses module and expenses.documents.view / .manage (M2 Step 5). The procedures first
 * need the Files module on (receipts and documents, released with the Costing Core in M2 Step 7: with
 * it off, the screens show no receipts and the API refuses them, MODULE_DISABLED), then one of the
 * two (MODULE_DISABLED or FORBIDDEN before the input is read), then the record's own. The download
 * URLs are supplier_price (a receipt shows what was paid).
 */
const ACCESS: Readonly<
  Record<AttachmentEntity, { view: ModuleAccessPair; manage: ModuleAccessPair }>
> = {
  purchase: {
    view: ['purchases', 'purchases.documents.view'],
    manage: ['purchases', 'purchases.documents.manage'],
  },
  expense: {
    view: ['expenses', 'expenses.documents.view'],
    manage: ['expenses', 'expenses.documents.manage'],
  },
}

const files = businessProcedure.use(requireModule('files'))
const viewAny = files.use(requireAnyAccess(ACCESS.purchase.view, ACCESS.expense.view))
const manageAny = files.use(requireAnyAccess(ACCESS.purchase.manage, ACCESS.expense.manage))

const mayView = (ctx: BusinessCtx, entity: AttachmentEntity) =>
  assertAnyAccess(ctx, [ACCESS[entity].view])
const mayManage = (ctx: BusinessCtx, entity: AttachmentEntity) =>
  assertAnyAccess(ctx, [ACCESS[entity].manage])

export const attachmentRouter = router({
  /** `attachment.list`: the record's files with signed download URLs. */
  list: viewAny
    .input(attachmentListInput)
    .output(attachmentListDto)
    .query(({ ctx, input }) => {
      mayView(ctx, input.entity)
      return listAttachments(ctx, input)
    }),
  /** `attachment.uploadUrl`: where to upload one file for the record. */
  uploadUrl: manageAny
    .input(attachmentUploadUrlInput)
    .output(attachmentUploadUrlDto)
    .mutation(({ ctx, input }) => {
      mayManage(ctx, input.entity)
      return attachmentUploadUrl(ctx, input)
    }),
  /** `attachment.add`: attaches the uploaded file after checking it. */
  add: manageAny
    .input(addAttachmentInput)
    .output(attachmentResultDto)
    .mutation(({ ctx, input }) => {
      mayManage(ctx, input.entity)
      return addAttachment(ctx, input)
    }),
  /** `attachment.remove`: the file is taken off and deleted. */
  remove: manageAny
    .input(attachmentIdInput)
    .output(okDto)
    .mutation(({ ctx, input }) => removeAttachment(ctx, input, (entity) => mayManage(ctx, entity))),
})
