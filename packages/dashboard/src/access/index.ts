import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose'

/** The header Cloudflare Access adds to every request it lets through. */
export const ACCESS_ASSERTION_HEADER = 'cf-access-jwt-assertion'

export interface AccessOptions {
  /** The Access team domain, e.g. "https://example.cloudflareaccess.com". */
  teamDomain: string
  /** The Access application's audience tag (AUD). */
  audience: string
  /** When set, a signed-in person must also be one of these addresses (any case). */
  allowedEmails?: readonly string[]
  /** When set, a service token with this client id is admitted too (automated checks). */
  serviceTokenClientId?: string
  /** Where the signing keys come from; defaults to the team's published certificates. */
  keys?: JWTVerifyGetKey
}

export interface AccessIdentity {
  /** The signed-in person's address, or null for a service token. */
  email: string | null
  /** The service token's client id, or null for a person. */
  serviceToken: string | null
}

/**
 * Verifies a Cloudflare Access assertion: signature against the team's keys, issuer, audience and
 * expiry, then the optional allowlists. Returns null for anything that does not pass, so a request
 * that reaches the app without going through Access (or through another Access application) is
 * refused.
 */
export function cloudflareAccess(options: AccessOptions): {
  identify: (assertion: string | null | undefined) => Promise<AccessIdentity | null>
  authorize: (request: Request) => Promise<boolean>
} {
  const teamDomain = options.teamDomain.replace(/\/+$/, '')
  const keys = options.keys ?? createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`))
  const allowed = options.allowedEmails?.map((e) => e.trim().toLowerCase())

  async function identify(assertion: string | null | undefined): Promise<AccessIdentity | null> {
    if (assertion === null || assertion === undefined || assertion === '') return null
    let payload: Record<string, unknown>
    try {
      ;({ payload } = await jwtVerify(assertion, keys, {
        issuer: teamDomain,
        audience: options.audience,
        algorithms: ['RS256'],
      }))
    } catch {
      return null
    }
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : null
    if (email !== null && email !== '') {
      if (allowed !== undefined && !allowed.includes(email)) return null
      return { email, serviceToken: null }
    }
    // A service token's assertion carries its client id as common_name and no email.
    const clientId = typeof payload.common_name === 'string' ? payload.common_name : null
    if (clientId !== null && clientId === options.serviceTokenClientId) {
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
