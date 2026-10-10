import { describe, expect, it } from 'vitest'
import {
  averageBurnRate,
  burnRate,
  FIVE_HOURS_MS,
  forecastHeadline,
  HOUR_MS,
  type PoolForecast,
  type ProfileStatus,
  poolForecast,
  type QuotaWindow,
  WEEK_MS,
} from '../src/core/index'

const NOW = Date.UTC(2026, 9, 9, 12)
const MIN = 60_000

function weekly(usedFraction: number | null, resetsIn = 6 * 24 * HOUR_MS): QuotaWindow {
  return { usedFraction, resetsAt: NOW + resetsIn, lengthMs: WEEK_MS }
}

function profile(name: string, overrides: Partial<ProfileStatus> = {}): ProfileStatus {
  return {
    profile: name,
    band: 'ok',
    weekly: weekly(0.5),
    fiveHour: null,
    rateLimitedUntil: null,
    tokenExpiresAt: null,
    latencyMs: { p50: null, p95: null, p99: null },
    ...overrides,
  }
}

const rates = (entries: Record<string, number>) => new Map(Object.entries(entries))

// Within one simulation step (10 minutes for weekly windows) of the expected time.
function expectNear(actual: number | null, expected: number, within = 10 * MIN) {
  expect(actual).not.toBeNull()
  expect(Math.abs((actual as number) - expected)).toBeLessThanOrEqual(within)
}

describe('burnRate', () => {
  it('adds the rises over the span and ignores a reset', () => {
    const points: Array<[number, number]> = [
      [NOW - 4 * HOUR_MS, 0.8],
      [NOW - 3 * HOUR_MS, 0.9],
      [NOW - 2 * HOUR_MS, 0.05], // reset: 0.05 used since it
      [NOW - HOUR_MS, 0.15],
      [NOW, 0.25],
    ]
    // Rises 0.1 + 0.05 + 0.1 + 0.1 = 0.35 over 4 hours.
    expect(burnRate(points, NOW, 24 * HOUR_MS)).toBeCloseTo(0.35 / 4, 9)
  })

  it('reads only the span, and needs two readings in it', () => {
    const points: Array<[number, number]> = [
      [NOW - 30 * HOUR_MS, 0],
      [NOW - 2 * HOUR_MS, 0.5],
      [NOW, 0.6],
    ]
    expect(burnRate(points, NOW, 24 * HOUR_MS)).toBeCloseTo(0.05, 9)
    expect(burnRate([[NOW, 0.6]], NOW, 24 * HOUR_MS)).toBeNull()
    expect(burnRate([], NOW, 24 * HOUR_MS)).toBeNull()
  })
})

describe('averageBurnRate', () => {
  it('is the used share over the time the window has run', () => {
    // Half of a 5-hour window gone, half its allowance used: 0.2 per hour.
    const w: QuotaWindow = {
      usedFraction: 0.5,
      resetsAt: NOW + 2.5 * HOUR_MS,
      lengthMs: FIVE_HOURS_MS,
    }
    expect(averageBurnRate(w, NOW)).toBeCloseTo(0.2, 9)
    expect(averageBurnRate({ ...w, usedFraction: null }, NOW)).toBeNull()
    expect(averageBurnRate({ ...w, resetsAt: null }, NOW)).toBeNull()
  })
})

describe('poolForecast', () => {
  it('clips when the room left across the pool is used at the pool rate', () => {
    // Room 0.5 + 0.5 = 1 allowance, demand 0.1 + 0.1 = 0.2 per hour: 5 hours.
    const f = poolForecast([profile('a'), profile('b')], 'weekly', NOW, rates({ a: 0.1, b: 0.1 }))
    expect(f.used).toBeCloseTo(0.5, 9)
    expect(f.burnPerHour).toBeCloseTo(0.2, 9)
    expectNear(f.clipsAt, NOW + 5 * HOUR_MS)
    expect(f.recoversAt).toBe(NOW + 6 * 24 * HOUR_MS)
    expect(f.lasts).toBeNull()
  })

  it('moves demand to subscriptions that still have room', () => {
    // a has 0.1 left and b 1.0: a full a does not clip the pool; 1.1 at 0.2 per hour.
    const f = poolForecast(
      [profile('a', { weekly: weekly(0.9) }), profile('b', { weekly: weekly(0) })],
      'weekly',
      NOW,
      rates({ a: 0.1, b: 0.1 }),
    )
    expectNear(f.clipsAt, NOW + 5.5 * HOUR_MS)
  })

  it('gives a subscription its room back when its window resets', () => {
    // 0.2 left at 0.2 per hour would clip at 1h, but a resets at 30m with 0.1 used of it:
    // then a has 1.0 and b 0.05, which lasts 5.25 hours more.
    const f = poolForecast(
      [profile('a', { weekly: weekly(0.9, 30 * MIN) }), profile('b', { weekly: weekly(0.9) })],
      'weekly',
      NOW,
      rates({ a: 0.1, b: 0.1 }),
    )
    expectNear(f.clipsAt, NOW + 30 * MIN + 5.25 * HOUR_MS)
  })

  it('reports a pool already used up, and when it takes work again', () => {
    const f = poolForecast(
      [
        profile('a', { weekly: weekly(1, 3 * HOUR_MS) }),
        profile('b', { weekly: weekly(1, 9 * HOUR_MS) }),
      ],
      'weekly',
      NOW,
    )
    expect(f.clipsAt).toBe(NOW)
    expect(f.recoversAt).toBe(NOW + 3 * HOUR_MS)
  })

  it('lasts when nothing is used, or nothing runs out within the horizon', () => {
    const idle = poolForecast([profile('a')], 'weekly', NOW, rates({ a: 0 }))
    expect(idle).toMatchObject({ clipsAt: null, lasts: 'idle' })
    const slow = poolForecast([profile('a')], 'weekly', NOW, rates({ a: 0.001 }))
    expect(slow).toMatchObject({ clipsAt: null, lasts: 'horizon' })
  })

  it('counts no room for an expired login, though its use counts toward the mean', () => {
    const expired = profile('b', { weekly: weekly(0), tokenExpiresAt: NOW - MIN })
    const f = poolForecast([profile('a'), expired], 'weekly', NOW, rates({ a: 0.1 }))
    expect(f.used).toBeCloseTo(0.25, 9)
    // Only a's 0.5 is room: 5 hours at 0.1 per hour.
    expectNear(f.clipsAt, NOW + 5 * HOUR_MS)
  })

  it('falls back to the average since the window began without a smoothed rate', () => {
    // Half of a 5-hour window gone with 0.6 used: 0.24 per hour, so the 0.4 left lasts 1h40m,
    // before the window resets at 2h30m.
    const five: QuotaWindow = {
      usedFraction: 0.6,
      resetsAt: NOW + 2.5 * HOUR_MS,
      lengthMs: FIVE_HOURS_MS,
    }
    const f = poolForecast([profile('a', { fiveHour: five })], 'fiveHour', NOW)
    expect(f.burnPerHour).toBeCloseTo(0.24, 9)
    expect(f.counted).toBe(1)
    expectNear(f.clipsAt, NOW + (0.4 / 0.24) * HOUR_MS, 2 * MIN)
    expect(f.recoversAt).toBe(NOW + 2.5 * HOUR_MS)
  })

  it('lasts when the pace exactly matches the window', () => {
    // 0.5 used halfway through: it runs out just as the window resets, every window.
    const five: QuotaWindow = {
      usedFraction: 0.5,
      resetsAt: NOW + 2.5 * HOUR_MS,
      lengthMs: FIVE_HOURS_MS,
    }
    expect(poolForecast([profile('a', { fiveHour: five })], 'fiveHour', NOW).lasts).toBe('horizon')
  })

  it('is unknown with no reading of the window', () => {
    const f = poolForecast([profile('a'), profile('b')], 'fiveHour', NOW)
    expect(f).toMatchObject({ counted: 0, used: null, clipsAt: null, lasts: 'unknown' })
    const none = poolForecast([profile('a', { weekly: weekly(null) })], 'weekly', NOW)
    expect(none.lasts).toBe('unknown')
  })
})

describe('forecastHeadline', () => {
  const base = { counted: 2, used: 0.5, burnPerHour: 0.1, recoversAt: null }
  const weeklyAt = (clipsAt: number | null, lasts: PoolForecast['lasts'] = null): PoolForecast => ({
    ...base,
    window: 'weekly',
    clipsAt,
    lasts,
  })
  const fiveAt = (clipsAt: number | null, lasts: PoolForecast['lasts'] = null): PoolForecast => ({
    ...base,
    window: 'fiveHour',
    clipsAt,
    lasts,
  })

  it('leads with the soonest run-out', () => {
    const h = forecastHeadline([weeklyAt(NOW + 30 * HOUR_MS), fiveAt(NOW + 2 * HOUR_MS)], NOW)
    expect(h).toEqual({
      tone: 'warning',
      headline: 'At this pace the pool runs out of its 5-hour capacity in 2h.',
      window: 'fiveHour',
    })
  })

  it('says when the pool is out now', () => {
    const h = forecastHeadline([weeklyAt(NOW), fiveAt(null, 'horizon')], NOW)
    expect(h).toMatchObject({ tone: 'error', window: 'weekly' })
    expect(h.headline).toBe('The pool is out of weekly allowance now.')
  })

  it('reads success when nothing runs out, and info without readings', () => {
    expect(forecastHeadline([weeklyAt(null, 'horizon'), fiveAt(null, 'unknown')], NOW).tone).toBe(
      'success',
    )
    expect(forecastHeadline([weeklyAt(null, 'unknown'), fiveAt(null, 'unknown')], NOW).tone).toBe(
      'info',
    )
    expect(forecastHeadline(null, NOW).tone).toBe('info')
  })
})
