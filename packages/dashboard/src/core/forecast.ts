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

/** Readings must cover at least this long for a smoothed rate; two close readings say little. */
export const MIN_SMOOTHING_COVERAGE_MS = HOUR_MS

/** A window that has run less than this is measured as if it had run this long. */
export const MIN_AVERAGE_ELAPSED_MS = 30 * 60_000

/** A reading below this share of the highest one before it is a reset, not a dip. */
const RESET_FALL = 0.5

/**
 * A subscription's smoothed burn rate, in shares of its allowance per hour, from readings of its
 * used share within the span: how much the share rose, over the time the readings cover.
 * Readings are sorted and a time read twice keeps its highest value. A fall below half the
 * highest reading so far is a reset, and the new reading counts as use since it; a smaller dip
 * adds nothing until the share passes its earlier high again. Null when the readings cover less
 * than MIN_SMOOTHING_COVERAGE_MS.
 */
export function burnRate(
  points: Array<[EpochMs, number]>,
  now: EpochMs,
  spanMs: number,
): number | null {
  const byTime = new Map<EpochMs, number>()
  for (const [t, v] of points) {
    if (!Number.isFinite(t) || !Number.isFinite(v) || t < now - spanMs || t > now) continue
    byTime.set(t, Math.max(byTime.get(t) ?? Number.NEGATIVE_INFINITY, v))
  }
  const readings = [...byTime.entries()].sort((x, y) => x[0] - y[0])
  const first = readings[0]
  const last = readings[readings.length - 1]
  if (first === undefined || last === undefined) return null
  const covered = last[0] - first[0]
  if (covered < MIN_SMOOTHING_COVERAGE_MS) return null
  let rise = 0
  let peak = first[1]
  for (const [, v] of readings.slice(1)) {
    if (v < peak * RESET_FALL) {
      rise += Math.max(0, v)
      peak = v
    } else if (v > peak) {
      rise += v - peak
      peak = v
    }
  }
  return (rise / covered) * HOUR_MS
}

/**
 * The average burn rate since the window began (shares per hour), as of `at`, the time of the
 * reading; a window younger than MIN_AVERAGE_ELAPSED_MS counts as that old, so a little use in
 * its first minutes does not read as a stampede. Null when unknown.
 */
export function averageBurnRate(window: QuotaWindow, at: EpochMs): number | null {
  const elapsed = elapsedFraction(window, at)
  const used = window.usedFraction
  if (elapsed === null || used === null || !Number.isFinite(used)) return null
  const elapsedMs = Math.max(elapsed * window.lengthMs, MIN_AVERAGE_ELAPSED_MS)
  return (Math.min(1, Math.max(0, used)) / elapsedMs) * HOUR_MS
}

export interface PoolForecast {
  window: WindowKind
  /** Subscriptions with a reading of this window. */
  counted: number
  /** Subscriptions without one, which the forecast leaves out. */
  unreported: number
  /** The mean used share of those counted, 0 to 1; null with none. */
  used: number | null
  /** The pool's demand, in one subscription's allowance per hour. */
  burnPerHour: number
  /** How many counted subscriptions have a smoothed rate; the rest use their average. */
  smoothedCount: number
  /** When every counted subscription has used this window up; `from` when that is already so. */
  clipsAt: EpochMs | null
  /** When the first of them resets after the clip, so work flows again; null when unknown. */
  recoversAt: EpochMs | null
  /**
   * Why there is no clip time: demand is nil, nothing runs out within the horizon, no
   * subscription reports this window, or every one that does has an expired login.
   */
  lasts: 'idle' | 'horizon' | 'unknown' | 'logins' | null
}

/** One window of one subscription as the simulation moves it along. */
interface SimWindow {
  used: number
  resetsAt: EpochMs | null
  lengthMs: number
}

/**
 * A subscription in the simulation: the window being forecast, and its weekly window, which is
 * what claude-master routes by (the same object when the weekly window is the one forecast).
 */
interface Slot {
  quota: SimWindow
  weekly: SimWindow
  /** Its place in the snapshot, claude-master's last tiebreak (the configured order). */
  index: number
}

/** Above this used share a weekly allowance is in claude-master's reserve tier. */
export const WEEKLY_RESERVE_FROM = 0.9

function simWindow(w: QuotaWindow | null): SimWindow {
  const lengthMs = w !== null && Number.isFinite(w.lengthMs) && w.lengthMs > 0 ? w.lengthMs : null
  const used = w?.usedFraction
  return {
    used:
      used === null || used === undefined || !Number.isFinite(used)
        ? 0
        : Math.min(1, Math.max(0, used)),
    resetsAt:
      lengthMs !== null && w?.resetsAt != null && Number.isFinite(w.resetsAt) ? w.resetsAt : null,
    lengthMs: lengthMs ?? 1,
  }
}

// Moves a window past every reset up to `t` in one step (a loop of single windows could run for
// ever on a reset time far in the past).
function catchUp(w: SimWindow, t: EpochMs): void {
  if (w.resetsAt === null || w.resetsAt > t) return
  const windows = Math.floor((t - w.resetsAt) / w.lengthMs) + 1
  w.resetsAt += windows * w.lengthMs
  w.used = 0
  // Past float precision the reset time cannot move; it is unknown from here.
  if (!(w.resetsAt > t)) w.resetsAt = null
}

/** Whether claude-master can pick the subscription: room in the forecast window and the week. */
const routable = (s: Slot) => s.quota.used < 1 && s.weekly.used < 1

/**
 * claude-master's order, from the state at this step: outside the weekly reserve tier first,
 * then the soonest weekly reset (unknown last), then the configured order.
 */
function routeOrder(x: Slot, y: Slot): number {
  const reserve = (s: Slot) => Number(s.weekly.used >= WEEKLY_RESERVE_FROM)
  const reset = (s: Slot) => s.weekly.resetsAt ?? Number.POSITIVE_INFINITY
  return reserve(x) - reserve(y) || reset(x) - reset(y) || x.index - y.index
}

/** When a subscription can be picked again: after whichever full window resets last. */
function availableAt(s: Slot, t: EpochMs): EpochMs | null {
  let at = t
  for (const w of [s.quota, s.weekly]) {
    if (w.used < 1) continue
    if (w.resetsAt === null) return null
    at = Math.max(at, w.resetsAt)
  }
  return at
}

const reading = (p: ProfileStatus, window: WindowKind): QuotaWindow | null => {
  const w = window === 'weekly' ? p.weekly : p.fiveHour
  return w === null || w.usedFraction === null || !Number.isFinite(w.usedFraction) ? null : w
}

/**
 * When the whole pool runs out of one window: every subscription's allowance of it used up at
 * once, so requests go to the paid backup or fail. It starts at `from`, the time of the
 * readings (the snapshot's asOf).
 *
 * Demand is the sum of the subscriptions' burn rates (the smoothed one when given, else the
 * average since the window began), measured in one subscription's allowance per hour, so it
 * assumes the subscriptions are the same size. Going forward the demand goes where
 * claude-master routes it, judged at every step: subscriptions with room in this window and
 * their week only, those under the weekly reserve tier first, then the soonest weekly reset,
 * then the configured order. The 5-hour forecast moves each weekly window to its resets but
 * keeps its used share (the 5-hour use is not converted to weekly use). A subscription takes
 * work again when its windows reset, and a 5-hour window is taken to restart at once. A run-out
 * that has ended by `now` is skipped. A subscription whose login has expired adds no room; one with no reading of the
 * window is left out (`unreported`). Steps are STEP_MS apart, so a pool that runs out less than
 * a step before a reset may show no clip.
 */
export function poolForecast(
  profiles: ProfileStatus[],
  window: WindowKind,
  from: EpochMs,
  smoothed: ReadonlyMap<string, number | null> = new Map(),
  now: EpochMs = from,
): PoolForecast {
  const slots: Slot[] = []
  let demand = 0
  let usedSum = 0
  let counted = 0
  let smoothedCount = 0
  for (const [index, p] of profiles.entries()) {
    const w = reading(p, window)
    if (w === null) continue
    counted++
    const quota = simWindow(w)
    const slot: Slot = {
      quota,
      weekly: window === 'weekly' ? quota : simWindow(p.weekly),
      index,
    }
    // A reading from before its window reset: that window is over and nothing of the new one
    // is known to be used.
    catchUp(slot.quota, from)
    catchUp(slot.weekly, from)
    usedSum += slot.quota.used
    const smooth = smoothed.get(p.profile)
    const hasSmooth = smooth !== null && smooth !== undefined && Number.isFinite(smooth)
    if (hasSmooth) smoothedCount++
    const rate = hasSmooth ? smooth : (averageBurnRate(w, from) ?? 0)
    demand += Number.isFinite(rate) ? Math.max(0, rate) : 0
    const loginExpired = p.tokenExpiresAt !== null && p.tokenExpiresAt <= from
    if (!loginExpired) slots.push(slot)
  }
  const base = {
    window,
    counted,
    unreported: profiles.length - counted,
    used: counted === 0 ? null : usedSum / counted,
    burnPerHour: demand,
    smoothedCount,
  }
  const lasting = (lasts: PoolForecast['lasts']): PoolForecast => ({
    ...base,
    clipsAt: null,
    recoversAt: null,
    lasts,
  })
  if (counted === 0) return lasting('unknown')
  if (slots.length === 0) return lasting('logins')

  const step = STEP_MS[window]
  const perStep = (demand / HOUR_MS) * step
  const end = from + FORECAST_HORIZON_MS[window]
  for (let t = from; t <= end; t += step) {
    for (const s of slots) {
      catchUp(s.quota, t)
      if (s.weekly !== s.quota) catchUp(s.weekly, t)
    }
    const open = slots.filter(routable)
    if (open.length === 0) {
      const resets = slots.map((s) => availableAt(s, t)).filter((r): r is EpochMs => r !== null)
      const recoversAt = resets.length === 0 ? null : Math.min(...resets)
      // A run-out that has already ended by `now` (the readings lag the clock) is not reported;
      // the simulation goes on from the reset.
      if (recoversAt === null || recoversAt > now) {
        return { ...base, clipsAt: t, recoversAt, lasts: null }
      }
      continue
    }
    if (perStep <= 0) break
    // In claude-master's order as of this step; what one cannot take goes to the next.
    open.sort(routeOrder)
    let left = perStep
    for (const s of open) {
      if (left <= 0) break
      const take = Math.min(left, 1 - s.quota.used)
      s.quota.used += take
      left -= take
    }
  }
  return lasting(demand <= 0 ? 'idle' : 'horizon')
}

/** How the outlook reads at a glance. */
export type PoolTone = 'success' | 'warning' | 'error' | 'info'

const ALLOWANCE: Record<WindowKind, string> = {
  weekly: 'weekly allowance',
  fiveHour: '5-hour capacity',
}

/**
 * Whether a forecast covers every subscription. One that covers only those reporting the window
 * says so and never reads as an error: the others may still have room.
 */
export function reportingAll(f: PoolForecast): boolean {
  return f.unreported === 0
}

/** Words naming whose forecast it is when it does not cover every subscription. */
export function among(f: PoolForecast): string {
  return reportingAll(f) ? '' : ` (the ${f.counted} reporting it)`
}

/** The answer to "will we run out?": the soonest clip of either window, and its tone. */
export function forecastHeadline(
  forecasts: PoolForecast[] | null,
  now: EpochMs,
): { tone: PoolTone; headline: string; window: WindowKind | null } {
  if (forecasts === null) {
    return { tone: 'info', headline: 'Waiting for the first reading.', window: null }
  }
  const logins = forecasts.find((f) => f.lasts === 'logins')
  if (logins !== undefined && reportingAll(logins)) {
    return {
      tone: 'error',
      headline: 'No subscription can take work: every login has expired.',
      window: logins.window,
    }
  }
  const clips = forecasts
    .filter((f): f is PoolForecast & { clipsAt: EpochMs } => f.clipsAt !== null)
    .sort((a, b) => a.clipsAt - b.clipsAt)
  const first = clips[0]
  if (first !== undefined && first.clipsAt <= now) {
    return {
      tone: reportingAll(first) ? 'error' : 'warning',
      headline: `The pool is out of ${ALLOWANCE[first.window]} now${among(first)}.`,
      window: first.window,
    }
  }
  if (first !== undefined) {
    return {
      tone: 'warning',
      headline: `At this pace the pool runs out of its ${ALLOWANCE[first.window]} in ${formatCountdown(first.clipsAt - now)}${among(first)}.`,
      window: first.window,
    }
  }
  // Expired logins among only some subscriptions rank below any run-out, which may be an error.
  if (logins !== undefined) {
    return {
      tone: 'warning',
      headline: `Every subscription reporting its ${ALLOWANCE[logins.window]} has an expired login${among(logins)}.`,
      window: logins.window,
    }
  }
  if (forecasts.every((f) => f.lasts === 'unknown')) {
    return { tone: 'info', headline: 'No subscription has reported its usage yet.', window: null }
  }
  return { tone: 'success', headline: 'At this pace the pool does not run out.', window: null }
}
