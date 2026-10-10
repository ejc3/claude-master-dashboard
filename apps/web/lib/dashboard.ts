import 'server-only'

import type { MetricsSource } from '@ejc3/claude-master-dashboard'
import {
  ACCESS_ASSERTION_HEADER,
  accessOptionsFromEnv,
  cloudflareAccess,
} from '@ejc3/claude-master-dashboard/access'
import { type SourceSelection, selectSource } from '@ejc3/claude-master-dashboard/cloudwatch'
import { createDemoSource } from '@ejc3/claude-master-dashboard/demo'
import { headers } from 'next/headers'

export const API_BASE = '/api/claude-master'

let selection: SourceSelection | undefined

// Chosen on first use: on Workers the environment is filled in per request, after module load.
// CloudWatch when the read-only key is set (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION),
// the demo fixture otherwise, and the page says which. DASHBOARD_ACCOUNT_ALIASES, read from the
// same environment, folds the account codes of points exported before names into the names. A CloudWatch failure is an error on the
// page, never a quiet switch to demo data.
function selected(): SourceSelection {
  if (selection === undefined) selection = selectSource(process.env, createDemoSource())
  return selection
}

export function source(): MetricsSource {
  return selected().source
}

/** True when the page shows the demo fixture, so it can say so. */
export function demoData(): boolean {
  return selected().kind === 'demo'
}

/**
 * Local development without Cloudflare Access: DASHBOARD_AUTH=off admits everyone, and only
 * outside a production build, so it can never open a deployment.
 */
const authDisabled = process.env.NODE_ENV !== 'production' && process.env.DASHBOARD_AUTH === 'off'

let access: ReturnType<typeof cloudflareAccess> | null | undefined

// Built on first use: on Workers the environment is filled in per request, after module load.
// Without any of CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD and DASHBOARD_ALLOWED_EMAILS, or with an
// invalid one, nobody is admitted (the app fails closed) and the reason is logged once.
function accessCheck(): ReturnType<typeof cloudflareAccess> | null {
  if (access !== undefined) return access
  const settings = accessOptionsFromEnv(process.env)
  if ('missing' in settings) {
    console.error(
      `claude-master dashboard: ${settings.missing.join(', ')} not set; admitting nobody`,
    )
    access = null
    return access
  }
  try {
    access = cloudflareAccess(settings.options)
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
