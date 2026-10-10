import { TIME_ZONE_COOKIE } from '@ejc3/claude-master-dashboard'
import { DashboardPage } from '@ejc3/claude-master-dashboard/next'
import { cookies } from 'next/headers'
import { API_BASE, authorizePage, demoData, source } from '@/lib/dashboard'

export const dynamic = 'force-dynamic'

export default async function Page() {
  // The viewer's time zone, as the browser reported it, so times render on the server.
  const timeZone = (await cookies()).get(TIME_ZONE_COOKIE)?.value
  return (
    <DashboardPage
      source={source}
      authorize={authorizePage}
      apiBase={API_BASE}
      demoData={demoData()}
      timeZone={timeZone}
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
