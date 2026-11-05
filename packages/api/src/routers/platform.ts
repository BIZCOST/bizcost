import {
  betaAddInput,
  betaEntryDto,
  betaListDto,
  betaRemoveInput,
  okDto,
  platformFeedbackDto,
  platformFeedbackInput,
} from '@bizcost/contracts'
import { betaAdd, betaList, betaRemove } from '../services/beta-list'
import { platformFeedback } from '../services/feedback'
import { platformProcedure, router } from '../trpc'

/**
 * The owner's beta page (D-357): the beta list and the feedback, for platform admins only
 * (BIZCOST_PLATFORM_ADMINS, checked on the server for every procedure; FORBIDDEN for everyone else,
 * whatever their roles). It reads no tenant data beyond what feedback holds.
 */
export const platformRouter = router({
  betaList: platformProcedure.output(betaListDto).query(({ ctx }) => betaList(ctx)),
  betaAdd: platformProcedure
    .input(betaAddInput)
    .output(betaEntryDto)
    .mutation(({ ctx, input }) => betaAdd(ctx, input)),
  betaRemove: platformProcedure
    .input(betaRemoveInput)
    .output(okDto)
    .mutation(({ ctx, input }) => betaRemove(ctx, input)),
  feedback: platformProcedure
    .input(platformFeedbackInput)
    .output(platformFeedbackDto)
    .query(({ ctx, input }) => platformFeedback(ctx, input)),
})
