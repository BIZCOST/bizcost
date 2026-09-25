import {
  changeMemberRoleInput,
  memberDto,
  memberIdInput,
  memberListDto,
  okDto,
} from '@bizcost/contracts'
import {
  changeMemberRole,
  leaveBusiness,
  listMembers,
  removeMember,
  transferOwnership,
} from '../services/members'
import { businessProcedure, requireCapability, requirePermission, router } from '../trpc'

/** Settings → Team (services/members.ts): a business with a team only (CAPABILITY_DISABLED otherwise). */
const team = businessProcedure.use(requireCapability('has_team'))

export const memberRouter = router({
  /** `member.list` (settings.members.view). */
  list: team
    .use(requirePermission('settings.members.view'))
    .output(memberListDto)
    .query(({ ctx }) => listMembers(ctx)),
  /** `member.changeRole` (settings.members.manage): not to or from the Owner role. */
  changeRole: team
    .use(requirePermission('settings.members.manage'))
    .input(changeMemberRoleInput)
    .output(memberDto)
    .mutation(({ ctx, input }) => changeMemberRole(ctx, input)),
  /** `member.remove` (settings.members.manage): not the owner. */
  remove: team
    .use(requirePermission('settings.members.manage'))
    .input(memberIdInput)
    .output(okDto)
    .mutation(({ ctx, input }) => removeMember(ctx, input)),
  /**
   * `member.leave` (any member but the owner): leaves the business. Needs no permission and works
   * whatever the capabilities, so everyone can leave a business.
   */
  leave: businessProcedure.output(okDto).mutation(({ ctx }) => leaveBusiness(ctx)),
  /** `member.transferOwnership` (the owner only, with a recent sign-in). */
  transferOwnership: team
    .input(memberIdInput)
    .output(okDto)
    .mutation(({ ctx, input }) => transferOwnership(ctx, input)),
})
