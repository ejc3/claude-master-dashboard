import 'server-only'

import type { ReactNode } from 'react'
import {
  BadQueryError,
  type MetricsSource,
  seriesQueryFromParams,
  UnsupportedQueryError,
} from '../core/index'
import { Dashboard } from '../react/Dashboard'

export interface DashboardHandlerConfig {
  /** Where the numbers come from; called per request, so a host can choose by environment. */
  source: () => MetricsSource
  /** Whether this request may read the data. Required: there is no default that admits everyone. */
  authorize: (request: Request) => boolean | Promise<boolean>
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
  })
}

/**
 * A route handler serving `…/snapshot` and `…/series?…` under whatever path it is mounted at:
 *
 *   // app/api/claude-master/[...path]/route.ts
 *   export const { GET } = createDashboardHandler({ source, authorize })
 */
export function createDashboardHandler(config: DashboardHandlerConfig): {
  GET: (request: Request) => Promise<Response>
} {
  async function GET(request: Request): Promise<Response> {
    if (!(await config.authorize(request))) {
      return json({ error: 'Sign in with an allowed account to see this dashboard.' }, 401)
    }
    const url = new URL(request.url)
    const endpoint = url.pathname.split('/').filter(Boolean).at(-1)
    try {
      if (endpoint === 'snapshot') return json(await config.source().snapshot())
      if (endpoint === 'series') {
        return json(await config.source().series(seriesQueryFromParams(url.searchParams)))
      }
      return json({ error: 'Not found.' }, 404)
    } catch (error) {
      if (error instanceof BadQueryError || error instanceof UnsupportedQueryError) {
        return json({ error: error.message }, 400)
      }
      // The message, not the error: an SDK error can carry request details.
      console.error(
        'claude-master dashboard: the metrics source failed:',
        error instanceof Error ? error.message : String(error),
      )
      return json({ error: 'The metrics source did not answer. The page retries on its own.' }, 502)
    }
  }
  return { GET }
}

export interface DashboardPageProps {
  source: () => MetricsSource
  /** Whether the viewer may see the page; same rule as the handler's authorize. */
  authorize: () => boolean | Promise<boolean>
  /** Shown instead of the dashboard when authorize says no, e.g. a sign-in link. */
  unauthorized: ReactNode
  /** Where createDashboardHandler is mounted, e.g. "/api/claude-master". */
  apiBase: string
  title?: string
}

/** A server component: renders the first snapshot on the server, then hands over to the browser. */
export async function DashboardPage(props: DashboardPageProps): Promise<ReactNode> {
  if (!(await props.authorize())) return props.unauthorized
  const initialSnapshot = await props.source().snapshot()
  return (
    <Dashboard
      initialSnapshot={initialSnapshot}
      apiBase={props.apiBase}
      {...(props.title === undefined ? {} : { title: props.title })}
    />
  )
}
