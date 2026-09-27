import type { DeleteAccountDto } from '@bizcost/contracts'
import { appCodeOf, DemoApi, type DemoUser } from './client'
import { DEMO_EMAIL_DOMAIN } from './personas'

// `pnpm demo:reset`: removes every demo account (…@demo.bizcost.local) the way a user deletes their
// own account in the app (account.delete, D-064), so nothing bypasses the product's rules:
// - a business whose only member is the account is soft-deleted (deleted_at) with all its rows kept;
// - the account's memberships become `removed`, its name and email are cleared, its invitations are
//   revoked, its profile is anonymized, and its Auth user is deleted;
// - audit_log only grows: these changes are audited like any other write; nothing is erased.
// Members are removed before owners (an owner cannot leave a business that still has other members).
// A business that someone outside the demo has joined stays, with its demo owner: that is reported.
// To wipe the whole local database instead: `pnpm db:reset` (it also drops your own local data).

async function deleteAccount(api: DemoApi, user: DemoUser): Promise<'deleted' | 'blocked'> {
  try {
    const result = await api.mutate<DeleteAccountDto>('account.delete', await api.token(user))
    const count = result.deletedBusinessIds.length
    console.log(`✓ ${user.email}${count ? ` (${count} business${count > 1 ? 'es' : ''})` : ''}`)
    return 'deleted'
  } catch (error) {
    if (appCodeOf(error) === 'sole_owner') return 'blocked'
    throw error
  }
}

async function main() {
  const api = await DemoApi.open()
  try {
    let left = await api.demoUsers()
    if (left.length === 0) {
      console.log(`No demo accounts (@${DEMO_EMAIL_DOMAIN}) to remove.`)
      return
    }
    // Each pass removes everyone it can; an owner waits until their members are gone.
    while (left.length > 0) {
      const blocked: DemoUser[] = []
      for (const user of left) {
        if ((await deleteAccount(api, user)) === 'blocked') blocked.push(user)
      }
      if (blocked.length === left.length) break
      left = blocked
    }
    if (left.length > 0) {
      console.log('')
      for (const user of left) {
        console.log(
          `✗ ${user.email}: owns a business that someone outside the demo has joined; ` +
            'remove that member (or transfer ownership) in the app, then run demo:reset again.',
        )
      }
      process.exitCode = 1
    }
  } finally {
    await api.close()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
