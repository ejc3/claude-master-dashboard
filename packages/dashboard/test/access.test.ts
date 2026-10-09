import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import { ACCESS_ASSERTION_HEADER, cloudflareAccess } from '../src/access'

const TEAM = 'https://example.cloudflareaccess.com'
const AUD = 'aud-made-up-for-tests'

let sign: (
  claims: Record<string, unknown>,
  options?: { issuer?: string; audience?: string; expiresIn?: string },
) => Promise<string>
let signWithOtherKey: (claims: Record<string, unknown>) => Promise<string>
let jwks: { keys: JWK[] }

beforeAll(async () => {
  const mine = await generateKeyPair('RS256')
  const theirs = await generateKeyPair('RS256')
  jwks = { keys: [{ ...(await exportJWK(mine.publicKey)), kid: 'k1', alg: 'RS256' }] }
  const make =
    (key: CryptoKey) =>
    async (
      claims: Record<string, unknown>,
      o: { issuer?: string; audience?: string; expiresIn?: string } = {},
    ) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(o.issuer ?? TEAM)
        .setAudience(o.audience ?? AUD)
        .setIssuedAt()
        .setExpirationTime(o.expiresIn ?? '5m')
        .sign(key)
  sign = make(mine.privateKey)
  signWithOtherKey = (claims) => make(theirs.privateKey)(claims)
})

function access(extra: { allowedEmails?: string[]; serviceTokenClientId?: string } = {}) {
  return cloudflareAccess({
    teamDomain: `${TEAM}/`,
    audience: AUD,
    keys: createLocalJWKSet(jwks),
    ...extra,
  })
}

describe('cloudflareAccess', () => {
  it('admits a person Access signed in for this application', async () => {
    const token = await sign({ email: 'Owner@Example.com' })
    expect(await access().identify(token)).toEqual({
      email: 'owner@example.com',
      serviceToken: null,
    })
    const request = new Request('https://dash.example/x', {
      headers: { [ACCESS_ASSERTION_HEADER]: token },
    })
    expect(await access().authorize(request)).toBe(true)
  })

  it('refuses anything Access did not sign for this application', async () => {
    const a = access()
    expect(
      await a.identify(await sign({ email: 'owner@example.com' }, { audience: 'another-app' })),
    ).toBeNull()
    expect(
      await a.identify(
        await sign(
          { email: 'owner@example.com' },
          { issuer: 'https://other.cloudflareaccess.com' },
        ),
      ),
    ).toBeNull()
    expect(
      await a.identify(await sign({ email: 'owner@example.com' }, { expiresIn: '-1m' })),
    ).toBeNull()
    expect(await a.identify(await signWithOtherKey({ email: 'owner@example.com' }))).toBeNull()
    expect(await a.identify('not-a-token')).toBeNull()
    expect(await a.identify(null)).toBeNull()
    expect(await a.authorize(new Request('https://dash.example/x'))).toBe(false)
  })

  it('applies the email allowlist on top of the Access policy', async () => {
    const a = access({ allowedEmails: ['owner@example.com'] })
    expect(await a.identify(await sign({ email: 'OWNER@example.com' }))).not.toBeNull()
    expect(await a.identify(await sign({ email: 'family@example.com' }))).toBeNull()
  })

  it('admits only the configured service token', async () => {
    const token = await sign({ common_name: 'client-1.access' })
    expect(await access().identify(token)).toBeNull()
    expect(await access({ serviceTokenClientId: 'client-2.access' }).identify(token)).toBeNull()
    expect(await access({ serviceTokenClientId: 'client-1.access' }).identify(token)).toEqual({
      email: null,
      serviceToken: 'client-1.access',
    })
  })
})
