import { projectedExhaustion } from './pace'
import { type EpochMs, HOUR_MS, type ProfileStatus, type QuotaWindow } from './types'

export interface RunOut {
  profile: string
  window: 'weekly' | 'fiveHour'
  at: EpochMs
}

// Whether the usage poll reads a window as used up, while its reset is still ahead (or unknown).
function readFull(window: QuotaWindow | null, now: EpochMs): boolean {
  if (window === null || window.usedFraction === null || window.usedFraction < 1) return false
  return window.resetsAt === null || window.resetsAt > now
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
 * login that has expired needs someone to fix it). Only Anthropic decides that a subscription is
 * out: it refuses (a 429, which claw-master holds as rate-limited until Anthropic's reset). The
 * usage poll does not: it reads whole percents, so its 100% can still be under Anthropic's, and
 * claw-master keeps sending work until Anthropic refuses (see pollSaysUsedUp).
 */
export type Blocked =
  | { reason: 'no-reading'; until: null }
  | { reason: 'login-expired'; until: null }
  | { reason: 'rate-limited'; until: EpochMs | null }

/** Null when the subscription can take work. */
export function blocked(profile: ProfileStatus, now: EpochMs): Blocked | null {
  if (profile.band === 'unknown') return { reason: 'no-reading', until: null }
  if (profile.tokenExpiresAt !== null && profile.tokenExpiresAt <= now) {
    return { reason: 'login-expired', until: null }
  }
  if (profile.rateLimitedUntil !== null && profile.rateLimitedUntil > now) {
    return { reason: 'rate-limited', until: profile.rateLimitedUntil }
  }
  return null
}

/**
 * Whether the usage poll reads a subscription's week or open 5-hour window as used up while
 * Anthropic has not refused it: nearly out, its last percent or so still taking work.
 */
export function pollSaysUsedUp(profile: ProfileStatus, now: EpochMs): boolean {
  return (
    blocked(profile, now) === null &&
    (readFull(profile.weekly, now) || readFull(fiveHourAt(profile.fiveHour, now), now))
  )
}

/** What a usage poll's 100% leaves, at most: it reads whole percents. */
export const POLL_FULL_LEFT = 0.01

/**
 * The subscriptions as the forecast should see them: one the poll reads as used up but Anthropic
 * has not refused keeps POLL_FULL_LEFT of that window, so the forecast has it run out shortly
 * instead of being out already. A refused one stays as read; its refusal holds it until it ends.
 */
export function forecastProfiles(profiles: ProfileStatus[], now: EpochMs): ProfileStatus[] {
  const cap = (w: QuotaWindow | null): QuotaWindow | null =>
    w === null || w.usedFraction === null || w.usedFraction < 1
      ? w
      : { ...w, usedFraction: 1 - POLL_FULL_LEFT }
  return profiles.map((p) =>
    blocked(p, now) !== null
      ? p
      : { ...p, weekly: cap(p.weekly) ?? p.weekly, fiveHour: cap(p.fiveHour) },
  )
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
