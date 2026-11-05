import {
  feedbackImageUploadDto,
  feedbackImageUploadInput,
  feedbackSendInput,
  okDto,
} from '@bizcost/contracts'
import { feedbackImageUploadUrl, sendFeedback } from '../services/feedback'
import { authedProcedure, router } from '../trpc'

/**
 * "Send feedback" (D-356): any signed-in person, in a business or not. Not a business procedure, so a
 * page outside any business can send it too; when the request names a business (x-business-id, as every
 * business page does), the database takes the business and member from that context and refuses anyone
 * who is not its active member. Nobody can read feedback back here: only `platform.feedback` reads it.
 */
export const feedbackRouter = router({
  imageUploadUrl: authedProcedure
    .input(feedbackImageUploadInput)
    .output(feedbackImageUploadDto)
    .mutation(({ ctx, input }) => feedbackImageUploadUrl(ctx, ctx.auth, input)),
  send: authedProcedure
    .input(feedbackSendInput)
    .output(okDto)
    .mutation(({ ctx, input }) => sendFeedback(ctx, ctx.auth, input)),
})
