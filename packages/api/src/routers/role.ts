import { roleDto, roleListDto, updateRolePermissionsInput } from '@bizcost/contracts'
import { listRoles, updateRolePermissions } from '../services/roles'
import {
  businessProcedure,
  requireAnyPermission,
  requireCapability,
  requirePermission,
  router,
} from '../trpc'

/** Settings → Roles (services/roles.ts): a business with a team only (CAPABILITY_DISABLED). */
const team = businessProcedure.use(requireCapability('has_team'))

export const roleRouter = router({
  /**
   * `role.list` (settings.members.view or settings.roles.manage): the members list needs the roles to
   * assign one; the Roles section edits them.
   */
  list: team
    .use(requireAnyPermission('settings.members.view', 'settings.roles.manage'))
    .output(roleListDto)
    .query(({ ctx }) => listRoles(ctx)),
  /** `role.updatePermissions` (settings.roles.manage): not the Owner role. */
  updatePermissions: team
    .use(requirePermission('settings.roles.manage'))
    .input(updateRolePermissionsInput)
    .output(roleDto)
    .mutation(({ ctx, input }) => updateRolePermissions(ctx, input)),
})
