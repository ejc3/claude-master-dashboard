import { DashboardPage } from '@ejc3/claude-master-dashboard/next'
import { signIn, viewerAllowed } from '@/auth'
import { API_BASE, source } from '@/lib/dashboard'

export const dynamic = 'force-dynamic'

async function signInWithGoogle() {
  'use server'
  await signIn('google', { redirectTo: '/claude-master' })
}

export default function Page() {
  return (
    <DashboardPage
      source={source}
      authorize={viewerAllowed}
      apiBase={API_BASE}
      signInHref="/claude-master"
      unauthorized={
        <main className="signin">
          <h1>claude-master</h1>
          <p>
            This dashboard shows which accounts use the pool, so it is limited to its operators.
          </p>
          <form action={signInWithGoogle}>
            <button type="submit">Sign in with Google</button>
          </form>
        </main>
      }
    />
  )
}
