import { GAPS_HORIZON_MS, type PoolGaps, poolGaps } from './forecast'
import type { EpochMs, ProfileStatus } from './types'

const WEEK_MS = 7 * 24 * 3_600_000

/** The share of the time the pool should have a subscription that can take work. */
export const COVERAGE_TARGET = 0.95

/** The most subscriptions the advice will suggest adding. */
export const MAX_ADDED = 10

/**
 * The share of the forecast's week (from `now`) with at least one subscription that can take work:
 * one minus the gaps' share of it, an open-ended gap running to the horizon.
 */
export function coverage(g: PoolGaps, now: EpochMs): number {
  const end = now + GAPS_HORIZON_MS
  let out = 0
  for (const gap of g.gaps) {
    const start = Math.max(gap.start, now)
    const stop = Math.min(gap.end ?? end, end)
    if (stop > start) out += stop - start
  }
  return 1 - out / GAPS_HORIZON_MS
}

/**
 * A subscription bought at `at`: its week starts then, unused, and resets a week later; until it is
 * bought it cannot take work (as if rate-limited until then). It brings no use of its own: the
 * pool's pace is the people's, not the subscriptions'.
 */
export function boughtAt(name: string, at: EpochMs): ProfileStatus {
  return {
    profile: name,
    band: 'ok',
    weekly: { usedFraction: 0, resetsAt: at + WEEK_MS, lengthMs: WEEK_MS },
    fiveHour: null,
    rateLimitedUntil: at,
    tokenExpiresAt: null,
    latencyMs: { p50: null, p95: null, p99: null },
  }
}

export type CapacityAdvice =
  | {
      kind: 'add'
      /** Subscriptions to add so the pool covers COVERAGE_TARGET of the week. */
      count: number
      /** The latest time buying them still reaches the target (later costs less). */
      buyBy: EpochMs
      /** Coverage now, and with them. */
      now: number
      after: number
    }
  | {
      kind: 'remove'
      /** Subscriptions the pool can do without and still cover COVERAGE_TARGET of the week. */
      remove: Array<{ profile: string; after: EpochMs | null }>
      now: number
      after: number
    }
  | { kind: 'enough'; now: number }
  /** Even MAX_ADDED more would not reach the target (or the forecast has no reading). */
  | { kind: 'unknown'; now: number | null }

/**
 * What to buy or cancel, from the same forecast as the headline (poolGaps at the recent pace):
 *
 * - Under COVERAGE_TARGET: the fewest subscriptions bought now that reach it, and the latest time
 *   buying that many still does (searched between now and the first gap's start).
 * - At or over it: the subscriptions that can go, one at a time, always the one whose loss costs
 *   least coverage, while the pool stays at or over it. Each is best cancelled once its current week
 *   has reset, so the week already paid for is used.
 */
export function capacityAdvice(
  profiles: ProfileStatus[],
  from: EpochMs,
  smoothed: ReadonlyMap<string, number | null>,
  now: EpochMs,
): CapacityAdvice {
  const base = poolGaps(profiles, from, smoothed, now)
  if (base.counted === 0) return { kind: 'unknown', now: null }
  // Every what-if keeps today's pace: the people's use, which adding or cancelling a subscription
  // does not change, only where it lands.
  const run = (ps: ProfileStatus[]) => poolGaps(ps, from, smoothed, now, false, base.pace)
  const current = coverage(base, now)

  if (current < COVERAGE_TARGET) {
    const extra = (k: number, at: EpochMs) =>
      Array.from({ length: k }, (_, i) => boughtAt(`added-${i + 1}`, at))
    for (let k = 1; k <= MAX_ADDED; k++) {
      const withNow = coverage(run([...profiles, ...extra(k, now)]), now)
      if (withNow < COVERAGE_TARGET) continue
      // The latest purchase that still reaches the target, between now and the first gap.
      const firstGap = base.gaps.find((g) => (g.end ?? Number.POSITIVE_INFINITY) > now)
      let lo = now
      let hi = Math.max(now, firstGap?.start ?? now)
      let after = withNow
      const atGap = coverage(run([...profiles, ...extra(k, hi)]), now)
      if (atGap >= COVERAGE_TARGET) {
        lo = hi
        after = atGap
      } else {
        // Coverage falls as the purchase moves later; ten halvings find the time to within a
        // thousandth of the span (minutes over a week).
        for (let i = 0; i < 10 && hi - lo > 60_000; i++) {
          const mid = Math.floor((lo + hi) / 2)
          const c = coverage(run([...profiles, ...extra(k, mid)]), now)
          if (c >= COVERAGE_TARGET) {
            lo = mid
            after = c
          } else {
            hi = mid
          }
        }
      }
      return { kind: 'add', count: k, buyBy: lo, now: current, after }
    }
    return { kind: 'unknown', now: current }
  }

  // Drop subscriptions while the pool still covers the target, the cheapest loss first.
  let kept = profiles
  let after = current
  const remove: Array<{ profile: string; after: EpochMs | null }> = []
  for (;;) {
    let best: { index: number; coverage: number } | null = null
    for (let i = 0; i < kept.length; i++) {
      const c = coverage(run(kept.filter((_, j) => j !== i)), now)
      if (c >= COVERAGE_TARGET && (best === null || c > best.coverage))
        best = { index: i, coverage: c }
    }
    if (best === null || kept.length <= 1) break
    const gone = kept[best.index] as ProfileStatus
    remove.push({ profile: gone.profile, after: gone.weekly.resetsAt })
    kept = kept.filter((_, j) => j !== best.index)
    after = best.coverage
  }
  return remove.length === 0
    ? { kind: 'enough', now: current }
    : { kind: 'remove', remove, now: current, after }
}
