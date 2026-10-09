import { DashboardPage } from '@ejc3/claude-master-dashboard/next'
import { API_BASE, authorizePage, source } from '@/lib/dashboard'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <DashboardPage
      source={source}
      authorize={authorizePage}
      apiBase={API_BASE}
      // Cloudflare Access signs the viewer in again when the page reloads.
      signInHref="/claude-master"
      unauthorized={
        <main className="signin">
          <h1>claude-master</h1>
          <p>
            This dashboard opens only through Cloudflare Access, which signs you in. Open it at its
            Access-protected address; if you just did, your address is not on its list.
          </p>
        </main>
      }
    />
  )
}
