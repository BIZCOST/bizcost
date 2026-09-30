import {
  changeMemberRoleInput,
  memberDto,
  memberIdInput,
  memberListDto,
  memberPermissionsDto,
  memberPermissionsInput,
  okDto,
  updateMemberPermissionsInput,
} from '@bizcost/contracts'
import {
  changeMemberRole,
  getMemberPermissions,
  leaveBusiness,
  listMembers,
  removeMember,
  transferOwnership,
  updateMemberPermissions,
} from '../services/members'
import { businessProcedure, requireCapability, requirePermission, router } from '../trpc'

/** Settings → Team (services/members.ts): a business with a team only (CAPABILITY_DISABLED otherwise). */
const team = businessProcedure.use(requireCapability('has_team'))

/**
 * A member's own access (M2 Step 7, D-084): whoever sees the team and edits what roles may do reads
 * and changes what one member may do.
 */
const memberAccess = team
  .use(requirePermission('settings.members.view'))
  .use(requirePermission('settings.roles.manage'))

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
  /**
   * `member.permissions` (settings.members.view and settings.roles.manage): what a member may do, from
   * their role and their own changes to it.
   */
  permissions: memberAccess
    .input(memberPermissionsInput)
    .output(memberPermissionsDto)
    .query(({ ctx, input }) => getMemberPermissions(ctx, input)),
  /**
   * `member.updatePermissions` (settings.members.view and settings.roles.manage): the member's own
   * changes to their role's access, saved whole; never beyond the caller's own access.
   */
  updatePermissions: memberAccess
    .input(updateMemberPermissionsInput)
    .output(memberPermissionsDto)
    .mutation(({ ctx, input }) => updateMemberPermissions(ctx, input)),
})
