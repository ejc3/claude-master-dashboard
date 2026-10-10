import { formatCountdown } from './format'
import { elapsedFraction } from './pace'
import { type EpochMs, HOUR_MS, type ProfileStatus, type QuotaWindow } from './types'

/** Which allowance a forecast is about. */
export type WindowKind = 'weekly' | 'fiveHour'

/** How far ahead each forecast looks: past this, the pool is reported as lasting. */
export const FORECAST_HORIZON_MS: Record<WindowKind, number> = {
  weekly: 7 * 24 * HOUR_MS,
  fiveHour: 24 * HOUR_MS,
}

const STEP_MS: Record<WindowKind, number> = {
  weekly: 10 * 60_000,
  fiveHour: 2 * 60_000,
}

/** The span a smoothed weekly burn rate is measured over: a whole day, so night and day average out. */
export const WEEKLY_SMOOTHING_MS = 24 * HOUR_MS

/**
 * A subscription's smoothed burn rate, in shares of its allowance per hour, from readings of its
 * used share: the sum of every rise over the span divided by the span the readings cover. Across
 * a reset (a fall) the new reading counts as use since the reset. Null with fewer than two
 * readings in the span.
 */
export function burnRate(
  points: Array<[EpochMs, number]>,
  now: EpochMs,
  spanMs: number,
): number | null {
  const inSpan = points.filter(([t, v]) => t >= now - spanMs && t <= now && Number.isFinite(v))
  if (inSpan.length < 2) return null
  let rise = 0
  for (let i = 1; i < inSpan.length; i++) {
    const value = inSpan[i]?.[1] ?? 0
    const step = value - (inSpan[i - 1]?.[1] ?? 0)
    // A fall is a reset: what the new reading shows was used since it.
    rise += step >= 0 ? step : Math.max(0, value)
  }
  const covered = (inSpan[inSpan.length - 1]?.[0] ?? 0) - (inSpan[0]?.[0] ?? 0)
  return covered <= 0 ? null : (rise / covered) * HOUR_MS
}

/** The average burn rate since the window began (shares per hour); null when unknown. */
export function averageBurnRate(window: QuotaWindow, now: EpochMs): number | null {
  const elapsed = elapsedFraction(window, now)
  const used = window.usedFraction
  if (elapsed === null || used === null || !Number.isFinite(used) || elapsed <= 0) return null
  return (Math.max(0, used) / (elapsed * window.lengthMs)) * HOUR_MS
}

export interface PoolForecast {
  window: WindowKind
  /** Subscriptions with a reading of this window. */
  counted: number
  /** Their mean used share, 0 to 1; null with none. */
  used: number | null
  /** The pool's demand, in one subscription's allowance per hour. */
  burnPerHour: number
  /** When every subscription has used this window up; `now` when that is already so. */
  clipsAt: EpochMs | null
  /** When the first of them resets after the clip, so work flows again; null when unknown. */
  recoversAt: EpochMs | null
  /**
   * Why there is no clip time: demand is nil, nothing runs out within the horizon, or no
   * subscription has a reading of this window.
   */
  lasts: 'idle' | 'horizon' | 'unknown' | null
}

interface Slot {
  used: number
  resetsAt: EpochMs | null
  lengthMs: number
}

/**
 * When the whole pool runs out of one window: every subscription's allowance of it used up at
 * once, so requests go to the paid backup or fail.
 *
 * Demand is the sum of the subscriptions' burn rates (the smoothed one when given, else the
 * average since the window began), measured in one subscription's allowance per hour, so it
 * assumes the subscriptions are the same size. Going forward claude-master moves that demand to
 * whichever subscriptions still have room, shared evenly; a subscription takes work again when
 * its window resets, and a 5-hour window is taken to restart at once. A subscription with no
 * reading, or whose login has expired, adds no room.
 */
export function poolForecast(
  profiles: ProfileStatus[],
  window: WindowKind,
  now: EpochMs,
  smoothed: ReadonlyMap<string, number | null> = new Map(),
): PoolForecast {
  const slots: Slot[] = []
  let demand = 0
  let usedSum = 0
  for (const p of profiles) {
    const w = window === 'weekly' ? p.weekly : p.fiveHour
    if (w === null || w.usedFraction === null || !Number.isFinite(w.usedFraction)) continue
    const used = Math.min(1, Math.max(0, w.usedFraction))
    usedSum += used
    const rate = smoothed.get(p.profile) ?? averageBurnRate(w, now) ?? 0
    demand += Math.max(0, rate)
    const loginExpired = p.tokenExpiresAt !== null && p.tokenExpiresAt <= now
    if (loginExpired) continue
    const resetsAt =
      w.resetsAt !== null && Number.isFinite(w.resetsAt) && w.lengthMs > 0 ? w.resetsAt : null
    slots.push({ used, resetsAt, lengthMs: w.lengthMs })
  }
  const counted = profiles.filter((p) => {
    const w = window === 'weekly' ? p.weekly : p.fiveHour
    return w !== null && w.usedFraction !== null && Number.isFinite(w.usedFraction)
  }).length
  const base = {
    window,
    counted,
    used: counted === 0 ? null : usedSum / counted,
    burnPerHour: demand,
  }

  if (counted === 0) return { ...base, clipsAt: null, recoversAt: null, lasts: 'unknown' }

  const step = STEP_MS[window]
  const perStep = (demand / HOUR_MS) * step
  const end = now + FORECAST_HORIZON_MS[window]
  for (let t = now; t <= end; t += step) {
    for (const s of slots) {
      while (s.resetsAt !== null && s.resetsAt <= t) {
        s.used = 0
        s.resetsAt += s.lengthMs
      }
    }
    const open = slots.filter((s) => s.used < 1)
    if (open.length === 0) {
      const resets = slots.map((s) => s.resetsAt).filter((r): r is EpochMs => r !== null)
      return {
        ...base,
        clipsAt: t,
        recoversAt: resets.length === 0 ? null : Math.min(...resets),
        lasts: null,
      }
    }
    if (perStep <= 0) break
    // Share this step's demand evenly; what a subscription cannot take spills to the rest.
    let left = perStep
    let room = open
    while (left > 1e-12 && room.length > 0) {
      const share = left / room.length
      for (const s of room) {
        const take = Math.min(share, 1 - s.used)
        s.used += take
        left -= take
      }
      room = room.filter((s) => s.used < 1)
    }
  }
  return { ...base, clipsAt: null, recoversAt: null, lasts: demand <= 0 ? 'idle' : 'horizon' }
}

/** How the outlook reads at a glance. */
export type PoolTone = 'success' | 'warning' | 'error' | 'info'

const ALLOWANCE: Record<WindowKind, string> = {
  weekly: 'weekly allowance',
  fiveHour: '5-hour capacity',
}

/** The answer to "will we run out?": the soonest clip of either window, and its tone. */
export function forecastHeadline(
  forecasts: PoolForecast[] | null,
  now: EpochMs,
): { tone: PoolTone; headline: string; window: WindowKind | null } {
  if (forecasts === null) {
    return { tone: 'info', headline: 'Waiting for the first reading.', window: null }
  }
  const clips = forecasts
    .filter((f): f is PoolForecast & { clipsAt: EpochMs } => f.clipsAt !== null)
    .sort((a, b) => a.clipsAt - b.clipsAt)
  const first = clips[0]
  if (first !== undefined && first.clipsAt <= now) {
    return {
      tone: 'error',
      headline: `The pool is out of ${ALLOWANCE[first.window]} now.`,
      window: first.window,
    }
  }
  if (first !== undefined) {
    return {
      tone: 'warning',
      headline: `At this pace the pool runs out of its ${ALLOWANCE[first.window]} in ${formatCountdown(first.clipsAt - now)}.`,
      window: first.window,
    }
  }
  if (forecasts.every((f) => f.lasts === 'unknown')) {
    return { tone: 'info', headline: 'No subscription has reported its usage yet.', window: null }
  }
  return { tone: 'success', headline: 'At this pace the pool does not run out.', window: null }
}
