import type { EpochMs, QuotaWindow } from './types.js'

/**
 * How usage compares with the share of the window that has passed. Spending evenly through a
 * window keeps usage equal to elapsed time; 'ahead' and 'over' mean the allowance runs out
 * before the reset at the current rate.
 */
export type Pace = 'even' | 'ahead' | 'over' | 'unknown'

/** Usage may run this far ahead of elapsed time and still count as even. */
export const EVEN_MARGIN = 0.05
/** Past this margin ahead of elapsed time, usage is 'over'. */
export const OVER_MARGIN = 0.15

/** The share of the window that has elapsed at `now`, 0 to 1; null when the reset is unknown. */
export function elapsedFraction(window: QuotaWindow, now: EpochMs): number | null {
  if (window.resetsAt === null || window.lengthMs <= 0) return null
  const remaining = (window.resetsAt - now) / window.lengthMs
  return Math.min(1, Math.max(0, 1 - remaining))
}

export function pace(window: QuotaWindow, now: EpochMs): Pace {
  const elapsed = elapsedFraction(window, now)
  if (window.usedFraction === null || elapsed === null) return 'unknown'
  const lead = window.usedFraction - elapsed
  if (lead <= EVEN_MARGIN) return 'even'
  if (lead <= OVER_MARGIN) return 'ahead'
  return 'over'
}

/**
 * When the window's allowance runs out if use continues at its average rate so far; null when it
 * lasts until the reset, nothing has been used, or the inputs are unknown.
 */
export function projectedExhaustion(window: QuotaWindow, now: EpochMs): EpochMs | null {
  const elapsed = elapsedFraction(window, now)
  const used = window.usedFraction
  if (used === null || elapsed === null || window.resetsAt === null) return null
  if (used >= 1) return now
  if (used <= 0 || elapsed <= 0) return null
  const ratePerMs = used / (elapsed * window.lengthMs)
  const at = now + (1 - used) / ratePerMs
  return at < window.resetsAt ? Math.round(at) : null
}
