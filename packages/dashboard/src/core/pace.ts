import type { EpochMs, QuotaWindow } from './types'

/**
 * How far usage leads the share of the window that has passed. 'even' is within EVEN_MARGIN of
 * elapsed time (or behind it); 'ahead' leads by up to OVER_MARGIN; 'over' leads by more, or the
 * allowance is used up. A window that leads at all runs out before its reset at the average rate
 * so far; projectedExhaustion says when, and is reported only for 'ahead' and 'over'.
 */
export type Pace = 'even' | 'ahead' | 'over' | 'unknown'

/** Usage may lead elapsed time by this much and still count as even. */
export const EVEN_MARGIN = 0.05
/** Past this lead, usage is 'over'. */
export const OVER_MARGIN = 0.15

// Shares are compared after rounding away float noise (0.55 - 0.5 is 0.05000000000000004).
const round = (x: number) => Math.round(x * 1e9) / 1e9

function known(window: QuotaWindow, now: EpochMs): boolean {
  return (
    window.resetsAt !== null &&
    Number.isFinite(window.resetsAt) &&
    Number.isFinite(window.lengthMs) &&
    window.lengthMs > 0 &&
    // A reading taken before its window reset says nothing about the new window.
    window.resetsAt > now
  )
}

/**
 * The share of the window that has elapsed at `now`, 0 to 1; null when the reset is unknown or
 * has already passed.
 */
export function elapsedFraction(window: QuotaWindow, now: EpochMs): number | null {
  if (!known(window, now)) return null
  const remaining = ((window.resetsAt as EpochMs) - now) / window.lengthMs
  return Math.min(1, Math.max(0, 1 - remaining))
}

function usedFraction(window: QuotaWindow): number | null {
  const used = window.usedFraction
  return used === null || !Number.isFinite(used) ? null : used
}

export function pace(window: QuotaWindow, now: EpochMs): Pace {
  const elapsed = elapsedFraction(window, now)
  const used = usedFraction(window)
  if (used === null || elapsed === null) return 'unknown'
  if (used >= 1) return 'over'
  const lead = round(used - elapsed)
  if (lead <= EVEN_MARGIN) return 'even'
  if (lead <= OVER_MARGIN) return 'ahead'
  return 'over'
}

/**
 * When the window's allowance runs out if use continues at its average rate so far; null when
 * the pace is even or unknown, or nothing has been used yet.
 */
export function projectedExhaustion(window: QuotaWindow, now: EpochMs): EpochMs | null {
  const p = pace(window, now)
  if (p === 'even' || p === 'unknown') return null
  const used = usedFraction(window) as number
  const elapsed = elapsedFraction(window, now) as number
  if (used >= 1) return now
  if (used <= 0 || elapsed <= 0) return null
  const ratePerMs = used / (elapsed * window.lengthMs)
  return Math.round(now + (1 - used) / ratePerMs)
}
