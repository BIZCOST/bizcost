import {
  acceptInvitationDto,
  createInvitationInput,
  invitationDto,
  invitationIdInput,
  invitationListDto,
  invitationPreviewDto,
  invitationTokenInput,
  okDto,
} from '@bizcost/contracts'
import {
  acceptInvitation,
  createInvitation,
  listInvitations,
  previewInvitation,
  resendInvitation,
  revokeInvitation,
} from '../services/invitations'
import {
  authedProcedure,
  businessProcedure,
  publicProcedure,
  requireCapability,
  requirePermission,
  router,
} from '../trpc'

/** Settings → Team (services/invitations.ts): a business with a team only (CAPABILITY_DISABLED). */
const team = businessProcedure.use(requireCapability('has_team'))
const manageTeam = team.use(requirePermission('settings.members.manage'))

export const invitationRouter = router({
  /** `invitation.list` (settings.members.view): pending invitations (expired ones included). */
  list: team
    .use(requirePermission('settings.members.view'))
    .output(invitationListDto)
    .query(({ ctx }) => listInvitations(ctx)),
  /** `invitation.create` (settings.members.manage): emails a link; 20 a day per business. */
  create: manageTeam
    .input(createInvitationInput)
    .output(invitationDto)
    .mutation(({ ctx, input }) => createInvitation(ctx, input)),
  /** `invitation.resend` (settings.members.manage): a new link; 3 resends per invitation. */
  resend: manageTeam
    .input(invitationIdInput)
    .output(invitationDto)
    .mutation(({ ctx, input }) => resendInvitation(ctx, input)),
  /** `invitation.revoke` (settings.members.manage). */
  revoke: manageTeam
    .input(invitationIdInput)
    .output(okDto)
    .mutation(({ ctx, input }) => revokeInvitation(ctx, input)),
  /** `invitation.preview` (public): business, inviter, role, masked email, expiry. */
  preview: publicProcedure
    .input(invitationTokenInput)
    .output(invitationPreviewDto)
    .query(({ ctx, input }) => previewInvitation(ctx, input)),
  /** `invitation.accept` (signed in, with the invited, verified email). */
  accept: authedProcedure
    .input(invitationTokenInput)
    .output(acceptInvitationDto)
    .mutation(({ ctx, input }) => acceptInvitation(ctx, ctx.auth, input)),
})
