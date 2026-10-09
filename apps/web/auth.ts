// Sign-in. Google is the only way in for people; the session is a signed cookie, and only the
// addresses in DASHBOARD_ALLOWED_EMAILS are admitted.
import { timingSafeEqual } from 'node:crypto'
import NextAuth from 'next-auth'
import type { Provider } from 'next-auth/providers'
import Credentials from 'next-auth/providers/credentials'
import Google from 'next-auth/providers/google'

const allowed = new Set(
  (process.env.DASHBOARD_ALLOWED_EMAILS ?? '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0),
)

// Automated checks cannot sign in with Google. With DASHBOARD_E2E_KEY set (32+ characters),
// whoever presents it gets a session as a test user that can read the dashboard and nothing more.
const e2eKey = process.env.DASHBOARD_E2E_KEY ?? ''
const E2E_EMAIL = 'checks@e2e.invalid'

const providers: Provider[] = [Google]
if (e2eKey.length >= 32) {
  providers.push(
    Credentials({
      id: 'e2e',
      credentials: { key: {} },
      authorize({ key }) {
        if (typeof key !== 'string') return null
        const given = Buffer.from(key)
        const expected = Buffer.from(e2eKey)
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
        return { id: 'e2e', name: 'Automated checks', email: E2E_EMAIL }
      },
    }),
  )
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers,
  session: { strategy: 'jwt' },
  callbacks: {
    signIn({ user, account }) {
      if (account?.provider === 'e2e') return true
      const email = user.email?.toLowerCase()
      return email !== undefined && allowed.has(email)
    },
  },
})

/**
 * Local development without Google: DASHBOARD_AUTH=off admits everyone, and only outside a
 * production build, so it can never open a deployment.
 */
export const authDisabled =
  process.env.NODE_ENV !== 'production' && process.env.DASHBOARD_AUTH === 'off'

/** Whether the current viewer may see the dashboard. */
export async function viewerAllowed(): Promise<boolean> {
  if (authDisabled) return true
  const session = await auth()
  const email = session?.user?.email?.toLowerCase()
  return email !== undefined && (email === E2E_EMAIL ? e2eKey.length >= 32 : allowed.has(email))
}
