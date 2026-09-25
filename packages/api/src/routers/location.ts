import {
  createLocationInput,
  locationDto,
  locationIdInput,
  locationListDto,
  okDto,
  renameLocationInput,
} from '@bizcost/contracts'
import {
  createLocation,
  listBusinessLocations,
  removeLocation,
  renameLocation,
  setDefaultLocation,
} from '../services/locations'
import { businessProcedure, requireCapability, requirePermission, router } from '../trpc'

/**
 * Settings → Locations (services/locations.ts): a business with more than one location only
 * (CAPABILITY_DISABLED otherwise), and settings.locations.manage.
 */
const manageLocations = businessProcedure
  .use(requireCapability('multi_location'))
  .use(requirePermission('settings.locations.manage'))

export const locationRouter = router({
  /** `location.list`: the default first. */
  list: manageLocations.output(locationListDto).query(({ ctx }) => listBusinessLocations(ctx)),
  /** `location.create`: idempotent on the client's id. */
  create: manageLocations
    .input(createLocationInput)
    .output(locationDto)
    .mutation(({ ctx, input }) => createLocation(ctx, input)),
  /** `location.rename`: `version` as read. */
  rename: manageLocations
    .input(renameLocationInput)
    .output(locationDto)
    .mutation(({ ctx, input }) => renameLocation(ctx, input)),
  /** `location.setDefault`: returns the list. */
  setDefault: manageLocations
    .input(locationIdInput)
    .output(locationListDto)
    .mutation(({ ctx, input }) => setDefaultLocation(ctx, input)),
  /** `location.remove`: soft delete, never the default. */
  remove: manageLocations
    .input(locationIdInput)
    .output(okDto)
    .mutation(({ ctx, input }) => removeLocation(ctx, input)),
})
