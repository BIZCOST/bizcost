import { apiHandler } from '../../../../src/lib/trpc/server'

// The only API entry of the web app (docs/ARCHITECTURE.md §Repo structure): tRPC over fetch.

// Longer than the longest honest request (a PDF that waits its turn up to 60 s and renders up to 30 s;
// an import or a fill of many statements, each under the role's 15 s), far short of Vercel's 300 s
// default: a call cut off here rolls back, and its business can try again (D-353).
export const maxDuration = 120

function handle(req: Request): Promise<Response> {
  return apiHandler()(req)
}

export { handle as GET, handle as POST }
