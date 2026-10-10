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
import { lastReady } from '../src/react/hooks'
import { rateNote } from '../src/react/Pool'

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
    // 0.2 left at 0.2 per hour would clip at 1h, but a (soonest reset, so it takes the load)
    // fills at 30m just as it resets; then its whole allowance lasts 5h, and b's 0.1 30m more.
    const f = poolForecast(
      [profile('a', { weekly: weekly(0.9, 30 * MIN) }), profile('b', { weekly: weekly(0.9) })],
      'weekly',
      NOW,
      rates({ a: 0.1, b: 0.1 }),
    )
    expectNear(f.clipsAt, NOW + 6 * HOUR_MS)
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
  const base = {
    counted: 2,
    unreported: 0,
    smoothedCount: 0,
    used: 0.5,
    burnPerHour: 0.1,
    recoversAt: null,
  }
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

describe('review fixes', () => {
  it('says every login has expired rather than that the allowance is gone', () => {
    const expired = { tokenExpiresAt: NOW - MIN }
    const f = poolForecast([profile('a', expired), profile('b', expired)], 'weekly', NOW)
    expect(f).toMatchObject({ clipsAt: null, lasts: 'logins', used: 0.5 })
    expect(forecastHeadline([f], NOW)).toEqual({
      tone: 'error',
      headline: 'No subscription can take work: every login has expired.',
      window: 'weekly',
    })
  })

  it('keeps the last delivered readings while the next range loads or fails', () => {
    const kept = [{ key: 'a', points: [] as Array<[number, number]> }]
    expect(lastReady(kept, { state: 'loading' })).toBe(kept)
    expect(lastReady(kept, { state: 'error', failure: { status: 500, message: 'x' } })).toBe(kept)
    const fresh = [{ key: 'b', points: [] as Array<[number, number]> }]
    expect(lastReady(kept, { state: 'ready', data: fresh, at: 0, failure: null })).toBe(fresh)
    expect(lastReady(null, { state: 'loading' })).toBeNull()
  })

  it('ignores a small dip and counts a real reset', () => {
    const ramp: Array<[number, number]> = Array.from({ length: 25 }, (_, i) => [
      NOW - (24 - i) * HOUR_MS,
      0.3 + 0.01 * i,
    ])
    const clean = burnRate(ramp, NOW, 24 * HOUR_MS) as number
    expect(clean).toBeCloseTo(0.01, 9)
    // One reading 0.01 low: the climb back adds nothing new.
    const dipped = ramp.map(([t, v], i): [number, number] => [t, i === 12 ? v - 0.02 : v])
    expect(burnRate(dipped, NOW, 24 * HOUR_MS)).toBeCloseTo(clean, 9)
  })

  it('reads unsorted and repeated readings like sorted ones, and needs an hour of them', () => {
    const sorted: Array<[number, number]> = [
      [NOW - 3 * HOUR_MS, 0.1],
      [NOW - 2 * HOUR_MS, 0.2],
      [NOW - HOUR_MS, 0.3],
      [NOW, 0.4],
    ]
    const rate = burnRate(sorted, NOW, 24 * HOUR_MS)
    expect(burnRate([...sorted].reverse(), NOW, 24 * HOUR_MS)).toBeCloseTo(rate as number, 9)
    // The same time twice keeps its highest reading, not a fall and a rise.
    const repeated: Array<[number, number]> = [...sorted, [NOW - HOUR_MS, 0.29]]
    expect(burnRate(repeated, NOW, 24 * HOUR_MS)).toBeCloseTo(rate as number, 9)
    expect(
      burnRate(
        [
          [NOW - 1, 0.1],
          [NOW, 0.2],
        ],
        NOW,
        24 * HOUR_MS,
      ),
    ).toBeNull()
  })

  it('measures a young window as at least half an hour old', () => {
    // A minute in, 2% used: not 1.2 per hour.
    const w: QuotaWindow = {
      usedFraction: 0.02,
      resetsAt: NOW + FIVE_HOURS_MS - MIN,
      lengthMs: FIVE_HOURS_MS,
    }
    expect(averageBurnRate(w, NOW)).toBeCloseTo(0.04, 9)
    expect(averageBurnRate({ ...w, usedFraction: 1.3 }, NOW)).toBeCloseTo(2, 9)
  })

  it('names the reporting subscriptions when others have no reading of the window', () => {
    const five: QuotaWindow = { usedFraction: 1, resetsAt: NOW + HOUR_MS, lengthMs: FIVE_HOURS_MS }
    const f = poolForecast([profile('a', { fiveHour: five }), profile('b')], 'fiveHour', NOW)
    expect(f).toMatchObject({ counted: 1, unreported: 1, clipsAt: NOW })
    expect(forecastHeadline([f], NOW)).toMatchObject({
      tone: 'warning',
      headline: 'The pool is out of 5-hour capacity now (the 1 reporting it).',
    })
  })

  it('sends demand to the subscription that resets soonest first', () => {
    // a takes everything: full at its reset (10h), full again 20h later; then b's 0.1 lasts 2h.
    // Shared evenly it would run out about 2 hours sooner.
    const f = poolForecast(
      [profile('a', { weekly: weekly(0.5, 10 * HOUR_MS) }), profile('b', { weekly: weekly(0.9) })],
      'weekly',
      NOW,
      rates({ a: 0.05, b: 0 }),
    )
    expectNear(f.clipsAt, NOW + 32 * HOUR_MS)
  })

  it('catches up on resets far in the past at once', () => {
    const started = performance.now()
    const old = poolForecast(
      [profile('a', { weekly: { usedFraction: 0.5, resetsAt: 0, lengthMs: 1000 } })],
      'weekly',
      NOW,
    )
    expect(performance.now() - started).toBeLessThan(500)
    expect(old.used).toBe(0)
    const lost = poolForecast(
      [profile('a', { weekly: { usedFraction: 0.5, resetsAt: -1e300, lengthMs: 1000 } })],
      'weekly',
      NOW,
    )
    expect(lost.used).toBe(0)
  })

  it('treats a NaN or null smoothed rate as missing, and a stale reading as reset', () => {
    const w = weekly(0.5)
    const averaged = poolForecast([profile('a', { weekly: w })], 'weekly', NOW)
    for (const smooth of [Number.NaN, null]) {
      const f = poolForecast([profile('a', { weekly: w })], 'weekly', NOW, new Map([['a', smooth]]))
      expect(f.burnPerHour).toBeCloseTo(averaged.burnPerHour, 9)
      expect(f.smoothedCount).toBe(0)
    }
    const stale = poolForecast([profile('a', { weekly: weekly(1, -HOUR_MS) })], 'weekly', NOW)
    expect(stale.used).toBe(0)
  })

  it('has no recovery time when no reset is known', () => {
    const f = poolForecast(
      [profile('a', { weekly: { usedFraction: 1, resetsAt: null, lengthMs: WEEK_MS } })],
      'weekly',
      NOW,
    )
    expect(f).toMatchObject({ clipsAt: NOW, recoversAt: null })
  })

  it('runs through several 5-hour windows within the horizon', () => {
    // 0.3 per hour: each window holds 1 allowance for 5h, so every window runs out at 3h20m.
    const five: QuotaWindow = {
      usedFraction: 0,
      resetsAt: NOW + FIVE_HOURS_MS,
      lengthMs: FIVE_HOURS_MS,
    }
    const f = poolForecast([profile('a', { fiveHour: five })], 'fiveHour', NOW, rates({ a: 0.3 }))
    expectNear(f.clipsAt, NOW + (1 / 0.3) * HOUR_MS, 2 * MIN)
    expect(f.recoversAt).toBe(NOW + FIVE_HOURS_MS)
  })

  it('describes how the demand was measured', () => {
    const f = poolForecast([profile('a'), profile('b')], 'weekly', NOW, rates({ a: 0.1 }))
    expect(f.smoothedCount).toBe(1)
    expect(rateNote(f)).toBe(
      'smoothed over up to the last 24 hours for 1 of 2, else the average since each reset',
    )
    expect(rateNote({ ...f, smoothedCount: 2 })).toBe('smoothed over up to the last 24 hours')
    expect(rateNote({ ...f, smoothedCount: 0 })).toBe('the average since each reset')
  })
})
