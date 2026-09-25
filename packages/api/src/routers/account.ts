import {
  deleteAccountDto,
  profileDto,
  setLastBusinessInput,
  updateProfileInput,
} from '@bizcost/contracts'
import { deleteAccount, setLastBusiness, updateProfile } from '../services/account'
import { authedProcedure, router } from '../trpc'

/**
 * The signed-in user's own account (authed, outside any business).
 * - `updateProfile`: display name and/or language (profiles.locale). The app keeps
 *   user_metadata.locale (read by the auth emails) in step through Supabase Auth.
 * - `delete`: refused with `sole_owner` while the caller is the only owner of a business that has
 *   other members; otherwise removes the memberships, soft-deletes businesses where the caller was
 *   the only member, anonymizes the profile and deletes the auth user (services/account.ts).
 * - `setLastBusiness`: remembers the business the caller opened last (profiles.last_business_id), for
 *   where to go after sign-in. The web calls it when a business page opens; createFromSetup sets it too.
 */
export const accountRouter = router({
  updateProfile: authedProcedure
    .input(updateProfileInput)
    .output(profileDto)
    .mutation(({ ctx, input }) => updateProfile(ctx, ctx.auth, input)),
  setLastBusiness: authedProcedure
    .input(setLastBusinessInput)
    .output(profileDto)
    .mutation(({ ctx, input }) => setLastBusiness(ctx, ctx.auth, input.businessId)),
  delete: authedProcedure
    .output(deleteAccountDto)
    .mutation(({ ctx }) => deleteAccount(ctx, ctx.auth)),
})
