import { createDashboardHandler } from '@ejc3/claude-master-dashboard/next'
import { authorizeRequest, resetScenarioSource, source, TRY_RESET } from '@/lib/dashboard'

export const dynamic = 'force-dynamic'

const live = createDashboardHandler({ source, authorize: authorizeRequest })
// /api/claude-master/try-reset/...: the reset scenario's made-up data, behind the same sign-in.
const tryReset = createDashboardHandler({
  source: resetScenarioSource,
  authorize: authorizeRequest,
})

export async function GET(request: Request): Promise<Response> {
  const [first] = new URL(request.url).pathname.replace(/^\/api\/claude-master\//, '').split('/')
  return first === TRY_RESET ? tryReset.GET(request) : live.GET(request)
}
