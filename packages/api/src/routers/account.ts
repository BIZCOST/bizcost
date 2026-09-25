import { deleteAccountDto, profileDto, updateProfileInput } from '@bizcost/contracts'
import { deleteAccount, updateProfile } from '../services/account'
import { authedProcedure, router } from '../trpc'

/**
 * The signed-in user's own account (authed, outside any business).
 * - `updateProfile`: display name and/or language (profiles.locale). The app keeps
 *   user_metadata.locale (read by the auth emails) in step through Supabase Auth.
 * - `delete`: refused with `sole_owner` while the caller is the only owner of a business that has
 *   other members; otherwise removes the memberships, soft-deletes businesses where the caller was
 *   the only member, anonymizes the profile and deletes the auth user (services/account.ts).
 */
export const accountRouter = router({
  updateProfile: authedProcedure
    .input(updateProfileInput)
    .output(profileDto)
    .mutation(({ ctx, input }) => updateProfile(ctx, ctx.auth, input)),
  delete: authedProcedure
    .output(deleteAccountDto)
    .mutation(({ ctx }) => deleteAccount(ctx, ctx.auth)),
})
