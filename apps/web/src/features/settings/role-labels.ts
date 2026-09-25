import type { BusinessContextDto, RoleDto } from '@bizcost/contracts'
import { isRoleTemplateKey, roleTemplateByKey, type RoleTemplateKey } from '@bizcost/modules'

// How a role is named and described in Settings. Roles are copies of the templates (docs/PRODUCT.md
// §8), named in the business's language when it was set up: templates are shown in the page's
// language instead, and a custom role keeps its own name.

/** `roles.<template>` for a template role, else null (show the role's own name). */
export function roleNameKey(templateKey: string | null): `roles.${RoleTemplateKey}` | null {
  return isRoleTemplateKey(templateKey) ? `roles.${templateKey}` : null
}

/** Whether the role still grants exactly what its template grants (its description still fits). */
export function isTemplateDefault(role: Pick<RoleDto, 'templateKey' | 'permissionKeys'>): boolean {
  const template = role.templateKey ? roleTemplateByKey(role.templateKey) : undefined
  if (!template || template.allPermissions) return false
  const keys = new Set(role.permissionKeys)
  return (
    keys.size === template.permissionKeys.length &&
    template.permissionKeys.every((key) => keys.has(key))
  )
}

/**
 * Whether the member may hand out `role` (invite with it, assign it): an owner always; anyone else
 * only a role whose permissions they hold themselves (the API's "only your own access" rule).
 */
export function canGrantRole(
  access: Pick<BusinessContextDto, 'permissions'>,
  role: Pick<RoleDto, 'permissionKeys' | 'isOwner'>,
): boolean {
  if (role.isOwner) return false
  if (access.permissions.all) return true
  const own = new Set(access.permissions.keys)
  return role.permissionKeys.every((key) => own.has(key))
}

/** Every permission a member may switch in a role's list: an owner all; anyone else their own. */
export function canGrantKey(access: Pick<BusinessContextDto, 'permissions'>, key: string): boolean {
  return access.permissions.all || access.permissions.keys.includes(key)
}
