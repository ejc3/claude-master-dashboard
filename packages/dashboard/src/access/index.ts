import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose'

/** The header Cloudflare Access adds to every request it lets through. */
export const ACCESS_ASSERTION_HEADER = 'cf-access-jwt-assertion'

export interface AccessOptions {
  /** The Access team domain, e.g. "https://example.cloudflareaccess.com". */
  teamDomain: string
  /** The Access application's audience tag (AUD). */
  audience: string
  /**
   * The addresses admitted (letters A-Z in any case; other characters must match exactly).
   * Required and non-empty: the app checks the signed-in address itself, so a policy widened by
   * mistake in Access admits no one new here.
   */
  allowedEmails: readonly string[]
  /**
   * When set, a service token with this client id is admitted too. Access issues such an
   * assertion only if the application has a service-auth policy for that token.
   */
  serviceTokenClientId?: string
  /** Where the signing keys come from; defaults to the team's published certificates. */
  keys?: JWTVerifyGetKey
}

/**
 * The team domain as an https origin (no path, no trailing slash), which is also the issuer of
 * its assertions. Throws for anything else, so a mistyped setting is reported, not silently
 * refusing every viewer.
 */
export function accessTeamDomain(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('the Access team domain must be a URL like https://<team>.cloudflareaccess.com')
  }
  if (url.protocol !== 'https:' || (url.pathname !== '/' && url.pathname !== '') || url.search) {
    throw new Error('the Access team domain must be an https origin with no path')
  }
  return url.origin
}

export interface AccessIdentity {
  /** The signed-in person's address, or null for a service token. */
  email: string | null
  /** The service token's client id, or null for a person. */
  serviceToken: string | null
}

/**
 * Lowercases A-Z only. Unicode case folding maps some characters onto ASCII letters (the Kelvin
 * sign onto "k"), which would let a lookalike address match one on the list.
 */
export function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (c) => c.toLowerCase())
}

/**
 * Verifies a Cloudflare Access assertion: signature against the team's keys, issuer, audience
 * and expiry, then the signed-in address against the allowlist (or the service token's client
 * id). Returns null for anything that does not pass, so a request that reaches the app without
 * going through Access (or through another Access application) is refused.
 */
export function cloudflareAccess(options: AccessOptions): {
  identify: (assertion: string | null | undefined) => Promise<AccessIdentity | null>
  authorize: (request: Request) => Promise<boolean>
} {
  const teamDomain = accessTeamDomain(options.teamDomain)
  const keys = options.keys ?? createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`))
  const audience = options.audience.trim()
  if (audience === '') throw new Error('the Access audience tag is empty')
  if (!Array.isArray(options.allowedEmails)) throw new Error('the email allowlist is missing')
  const allowed = options.allowedEmails.map((e) => asciiLower(e.trim())).filter((e) => e !== '')
  if (allowed.length === 0) throw new Error('the email allowlist is empty')
  // A blank client id is no service token: it must not match an assertion without a name.
  const serviceToken = options.serviceTokenClientId?.trim() || null

  async function identify(assertion: string | null | undefined): Promise<AccessIdentity | null> {
    if (assertion === null || assertion === undefined || assertion === '') return null
    let payload: Record<string, unknown>
    try {
      ;({ payload } = await jwtVerify(assertion, keys, {
        issuer: teamDomain,
        audience,
        algorithms: ['RS256'],
        // Access always sets an expiry; a signed assertion without one is not accepted.
        requiredClaims: ['exp'],
      }))
    } catch (error) {
      // Why, never the token: a wrong audience or an unreachable certificate endpoint should be
      // visible in the logs, not look like one more stranger.
      const code = (error as { code?: unknown }).code
      console.warn(
        'claude-master dashboard: Access assertion refused:',
        typeof code === 'string' ? code : 'unknown error',
      )
      return null
    }
    const email = typeof payload.email === 'string' ? asciiLower(payload.email) : null
    if (email !== null && email !== '') {
      if (!allowed.includes(email)) {
        // Never the address: a typo in the list should be visible, a stranger's address not.
        console.warn('claude-master dashboard: signed-in address is not on the allowlist')
        return null
      }
      return { email, serviceToken: null }
    }
    // A service token's assertion carries its client id as common_name and no email.
    const clientId = typeof payload.common_name === 'string' ? payload.common_name : null
    if (serviceToken !== null && clientId === serviceToken) {
      return { email: null, serviceToken: clientId }
    }
    return null
  }

  return {
    identify,
    authorize: async (request) =>
      (await identify(request.headers.get(ACCESS_ASSERTION_HEADER))) !== null,
  }
}

/**
 * String settings (process.env, or a Worker's string vars and secrets) by the names docs/deploy.md
 * uses: CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD, DASHBOARD_ALLOWED_EMAILS and the optional
 * DASHBOARD_SERVICE_TOKEN_CLIENT_ID.
 */
export type AccessEnv = Readonly<Record<string, string | undefined>>

/**
 * The options for cloudflareAccess from environment settings, or the names of the required ones
 * that are missing (never their values). The allowlist takes addresses separated by commas or
 * whitespace.
 */
export function accessOptionsFromEnv(
  env: AccessEnv,
): { options: AccessOptions } | { missing: string[] } {
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN?.trim() ?? ''
  const audience = env.CF_ACCESS_AUD?.trim() ?? ''
  const allowedEmails = (env.DASHBOARD_ALLOWED_EMAILS ?? '').split(/[\s,]+/).filter((e) => e !== '')
  const missing = [
    teamDomain === '' ? 'CF_ACCESS_TEAM_DOMAIN' : null,
    audience === '' ? 'CF_ACCESS_AUD' : null,
    allowedEmails.length === 0 ? 'DASHBOARD_ALLOWED_EMAILS' : null,
  ].filter((name): name is string => name !== null)
  if (missing.length > 0) return { missing }
  const serviceTokenClientId = env.DASHBOARD_SERVICE_TOKEN_CLIENT_ID?.trim()
  return {
    options: {
      teamDomain,
      audience,
      allowedEmails,
      ...(serviceTokenClientId ? { serviceTokenClientId } : {}),
    },
  }
}
