import { apiHandler } from '../../../../src/lib/trpc/server'

// The only API entry of the web app (docs/ARCHITECTURE.md §Repo structure): tRPC over fetch.

function handle(req: Request): Promise<Response> {
  return apiHandler()(req)
}

export { handle as GET, handle as POST }
