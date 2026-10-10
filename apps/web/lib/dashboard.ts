import 'server-only'

import type { MetricsSource } from '@ejc3/claude-master-dashboard'
import { ACCESS_ASSERTION_HEADER, cloudflareAccess } from '@ejc3/claude-master-dashboard/access'
import { createDemoSource } from '@ejc3/claude-master-dashboard/demo'
import { headers } from 'next/headers'

export const API_BASE = '/api/claude-master'

const demo = createDemoSource()

/** The demo source until a CloudWatch source is configured for this deployment. */
export function source(): MetricsSource {
  return demo
}

/**
 * Local development without Cloudflare Access: DASHBOARD_AUTH=off admits everyone, and only
 * outside a production build, so it can never open a deployment.
 */
const authDisabled = process.env.NODE_ENV !== 'production' && process.env.DASHBOARD_AUTH === 'off'

let access: ReturnType<typeof cloudflareAccess> | null | undefined

// Built on first use: on Workers the environment is filled in per request, after module load.
// Without CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD and DASHBOARD_ALLOWED_EMAILS, or with an invalid
// one, nobody is admitted (the app fails closed) and the reason is logged once.
function accessCheck(): ReturnType<typeof cloudflareAccess> | null {
  if (access !== undefined) return access
  const teamDomain = process.env.CF_ACCESS_TEAM_DOMAIN?.trim()
  const audience = process.env.CF_ACCESS_AUD?.trim()
  const emails = (process.env.DASHBOARD_ALLOWED_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e !== '')
  const serviceToken = process.env.DASHBOARD_SERVICE_TOKEN_CLIENT_ID?.trim()
  if (!teamDomain || !audience || emails.length === 0) {
    console.error(
      'claude-master dashboard: CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD and DASHBOARD_ALLOWED_EMAILS must all be set; admitting nobody',
    )
    access = null
    return access
  }
  try {
    access = cloudflareAccess({
      teamDomain,
      audience,
      allowedEmails: emails,
      ...(serviceToken ? { serviceTokenClientId: serviceToken } : {}),
    })
  } catch (error) {
    console.error(
      'claude-master dashboard: invalid Access settings; admitting nobody:',
      error instanceof Error ? error.message : String(error),
    )
    access = null
  }
  return access
}

/** For the route handler: the request must carry a valid Access assertion for this app. */
export async function authorizeRequest(request: Request): Promise<boolean> {
  if (authDisabled) return true
  return (await accessCheck()?.authorize(request)) ?? false
}

/** For the page: the same check, on the incoming request's headers. */
export async function authorizePage(): Promise<boolean> {
  if (authDisabled) return true
  const check = accessCheck()
  if (check === null) return false
  return (await check.identify((await headers()).get(ACCESS_ASSERTION_HEADER))) !== null
}
