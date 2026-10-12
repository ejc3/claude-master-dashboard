import 'server-only'

import { createDashboardHandler, firstSegmentUnder } from '@ejc3/claw-master-dashboard/next'
import { authorizeRequest, resetScenarioSource, source, TRY_RESET } from './dashboard'

const live = createDashboardHandler({ source, authorize: authorizeRequest })
// .../try-reset/...: the reset scenario's made-up data, behind the same sign-in.
const tryReset = createDashboardHandler({
  source: resetScenarioSource,
  authorize: authorizeRequest,
})

/** The API mounted at `base`: the live data, or the reset scenario's under its name. */
export function dashboardApi(base: string): (request: Request) => Promise<Response> {
  return async (request) =>
    firstSegmentUnder(request.url, base) === TRY_RESET ? tryReset.GET(request) : live.GET(request)
}
