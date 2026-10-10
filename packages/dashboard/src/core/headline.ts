import { projectedExhaustion } from './pace'
import { type EpochMs, HOUR_MS, type ProfileStatus, type QuotaWindow } from './types'

export interface RunOut {
  profile: string
  window: 'weekly' | 'fiveHour'
  at: EpochMs
}

// A used-up window blocks work until its reset: 'unknown' when the reset time is unknown, null when
// it does not block (not used up, or its reset has already passed).
function blocksUntil(window: QuotaWindow | null, now: EpochMs): EpochMs | 'unknown' | null {
  if (window === null || window.usedFraction === null || window.usedFraction < 1) return null
  if (window.resetsAt === null) return 'unknown'
  return window.resetsAt > now ? window.resetsAt : null
}

/**
 * A 5-hour window as of `at`: as read while its reset is ahead (or unknown); once the reset has
 * passed, no window is open (nothing used, no reset time) until the next request opens one.
 */
export function fiveHourAt(window: QuotaWindow | null, at: EpochMs): QuotaWindow | null {
  if (window === null || window.resetsAt === null || window.resetsAt > at) return window
  return { usedFraction: 0, resetsAt: null, lengthMs: window.lengthMs }
}

/**
 * Why a subscription cannot take work right now, and until when (null when unknown, e.g. a
 * login that has expired needs someone to fix it).
 */
export type Blocked =
  | { reason: 'no-reading'; until: null }
  | { reason: 'login-expired'; until: null }
  | { reason: 'used-up' | 'rate-limited'; until: EpochMs | null }

/** Null when the subscription can take work. */
export function blocked(profile: ProfileStatus, now: EpochMs): Blocked | null {
  if (profile.band === 'unknown') return { reason: 'no-reading', until: null }
  if (profile.tokenExpiresAt !== null && profile.tokenExpiresAt <= now) {
    return { reason: 'login-expired', until: null }
  }
  // Every reason that applies holds it back until the last of them ends; one with no known end
  // makes the whole wait unknown.
  const usedUp = [blocksUntil(profile.weekly, now), blocksUntil(profile.fiveHour, now)].filter(
    (t): t is EpochMs | 'unknown' => t !== null,
  )
  const limited =
    profile.rateLimitedUntil !== null && profile.rateLimitedUntil > now
      ? profile.rateLimitedUntil
      : null
  if (usedUp.length > 0 || profile.band === 'exhausted') {
    const known = usedUp.filter((t): t is EpochMs => t !== 'unknown')
    // An exhausted band no window explains has no known end either.
    const unknown = usedUp.includes('unknown') || usedUp.length === 0
    const all = limited === null ? known : [...known, limited]
    return { reason: 'used-up', until: unknown || all.length === 0 ? null : Math.max(...all) }
  }
  if (limited !== null) return { reason: 'rate-limited', until: limited }
  return null
}

export function hasHeadroom(profile: ProfileStatus, now: EpochMs): boolean {
  return blocked(profile, now) === null
}

/** The soonest a subscription with headroom runs out of a window before it resets. */
export function nextRunOut(profiles: ProfileStatus[], now: EpochMs): RunOut | null {
  let soonest: RunOut | null = null
  const consider = (profile: string, window: RunOut['window'], quota: QuotaWindow | null) => {
    if (quota === null) return
    const at = projectedExhaustion(quota, now)
    if (at !== null && (soonest === null || at < soonest.at)) soonest = { profile, window, at }
  }
  for (const p of profiles) {
    if (!hasHeadroom(p, now)) continue
    consider(p.profile, 'weekly', p.weekly)
    consider(p.profile, 'fiveHour', p.fiveHour)
  }
  return soonest
}

/** When the first blocked subscription can take work again, if any of them will on its own. */
export function nextAvailable(
  profiles: ProfileStatus[],
  now: EpochMs,
): { profile: string; at: EpochMs } | null {
  let soonest: { profile: string; at: EpochMs } | null = null
  for (const p of profiles) {
    const b = blocked(p, now)
    if (b?.until != null && (soonest === null || b.until < soonest.at)) {
      soonest = { profile: p.profile, at: b.until }
    }
  }
  return soonest
}

/**
 * claude-master renews a subscription's login once less than four hours of it are left, checking
 * every quarter of an hour. Less than this left means a renewal is overdue: worth a warning before
 * the login expires and the subscription stops taking work.
 */
export const LOGIN_OVERDUE_MS = 3 * HOUR_MS

/** Whether the login is still valid but should have been renewed by now. */
export function loginOverdue(profile: ProfileStatus, now: EpochMs): boolean {
  const at = profile.tokenExpiresAt
  return at !== null && at > now && at - now < LOGIN_OVERDUE_MS
}
