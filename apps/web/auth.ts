// Sign-in. Google is the only way in for people; the session is a signed cookie, and only the
// verified addresses in DASHBOARD_ALLOWED_EMAILS are admitted.
import { createHash, timingSafeEqual } from 'node:crypto'
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
// The session carries a fingerprint of the key, so changing the key ends every such session.
const e2eKey = process.env.DASHBOARD_E2E_KEY ?? ''
const e2eEnabled = e2eKey.length >= 32
const e2eFingerprint = createHash('sha256')
  .update(`claude-master-dashboard:${e2eKey}`)
  .digest('hex')
const E2E_EMAIL = 'checks@e2e.invalid'

const providers: Provider[] = [Google]
if (e2eEnabled) {
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

declare module 'next-auth' {
  interface Session {
    e2e?: string
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers,
  session: { strategy: 'jwt', maxAge: 7 * 24 * 60 * 60 },
  // The dashboard page shows its own sign-in button; Auth.js's generic page would also list the
  // automated-checks form.
  pages: { signIn: '/claude-master', error: '/claude-master' },
  callbacks: {
    signIn({ user, account, profile }) {
      if (account?.provider === 'e2e') return e2eEnabled
      const email = user.email?.toLowerCase()
      return profile?.email_verified === true && email !== undefined && allowed.has(email)
    },
    jwt({ token, account }) {
      if (account?.provider === 'e2e') token.e2e = e2eFingerprint
      return token
    },
    session({ session, token }) {
      if (typeof token.e2e === 'string') session.e2e = token.e2e
      return session
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
  if (email === undefined) return false
  if (email === E2E_EMAIL) return e2eEnabled && session?.e2e === e2eFingerprint
  return allowed.has(email)
}
