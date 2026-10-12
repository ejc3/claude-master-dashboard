import { TIME_ZONE_COOKIE } from '@ejc3/claude-master-dashboard'
import { DashboardPage } from '@ejc3/claude-master-dashboard/next'
import { cookies } from 'next/headers'
import {
  API_BASE,
  authorizePage,
  demoData,
  resetScenarioSource,
  source,
  TRY_RESET,
} from '@/lib/dashboard'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ slug?: string[] }> }) {
  // The viewer's time zone, as the browser reported it, so times render on the server.
  const timeZone = (await cookies()).get(TIME_ZONE_COOKIE)?.value
  // /claw-master/try-reset: the reset scenario, to try the countdown and the return of quota.
  const tryReset = (await params).slug?.[0] === TRY_RESET
  return (
    <DashboardPage
      source={tryReset ? resetScenarioSource : source}
      authorize={authorizePage}
      apiBase={tryReset ? `${API_BASE}/${TRY_RESET}` : API_BASE}
      demoData={tryReset || demoData()}
      timeZone={timeZone}
      // Cloudflare Access signs the viewer in again when the page reloads.
      signInHref="/claw-master"
      unauthorized={
        <main className="signin">
          <h1>claw-master</h1>
          <p>
            This dashboard opens only through Cloudflare Access, which signs you in. Open it at its
            Access-protected address; if you just did, your address is not on its list.
          </p>
        </main>
      }
    />
  )
}
