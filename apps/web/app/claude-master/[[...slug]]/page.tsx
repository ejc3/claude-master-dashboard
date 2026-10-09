import { DashboardPage } from '@ejc3/claude-master-dashboard/next'
import { viewerAllowed } from '@/auth'
import { API_BASE, source } from '@/lib/dashboard'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <DashboardPage
      source={source}
      authorize={viewerAllowed}
      apiBase={API_BASE}
      unauthorized={
        <main className="signin">
          <h1>claude-master</h1>
          <p>
            This dashboard shows which accounts use the pool, so it is limited to its operators.
          </p>
          <a href={`/api/auth/signin?callbackUrl=${encodeURIComponent('/claude-master')}`}>
            Sign in with Google
          </a>
        </main>
      }
    />
  )
}
