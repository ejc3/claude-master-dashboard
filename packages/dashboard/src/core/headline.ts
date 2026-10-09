import { projectedExhaustion } from './pace'
import type { EpochMs, ProfileStatus, QuotaWindow } from './types'

export interface RunOut {
  profile: string
  window: 'weekly' | 'fiveHour'
  at: EpochMs
}

/** A subscription can take work: not exhausted, not cooling down after a 429. */
export function hasHeadroom(profile: ProfileStatus, now: EpochMs): boolean {
  if (profile.band === 'exhausted') return false
  return profile.rateLimitedUntil === null || profile.rateLimitedUntil <= now
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

/** The next time any window resets. */
export function nextReset(profiles: ProfileStatus[], now: EpochMs): EpochMs | null {
  let soonest: EpochMs | null = null
  for (const p of profiles) {
    for (const w of [p.weekly, p.fiveHour]) {
      const at = w?.resetsAt ?? null
      if (at !== null && at > now && (soonest === null || at < soonest)) soonest = at
    }
  }
  return soonest
}
