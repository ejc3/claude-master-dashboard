import { describe, expect, it } from 'vitest'
import {
  BadQueryError,
  FIVE_HOURS_MS,
  formatCount,
  formatCountdown,
  formatDuration,
  formatPercent,
  formatWhen,
  HOUR_MS,
  hasHeadroom,
  MAX_POINTS,
  nextAvailable,
  nextRunOut,
  type ProfileStatus,
  type SeriesQuery,
  seriesQueryFromParams,
  seriesQueryToParams,
  WEEK_MS,
} from '../src/core/index'

const NOW = Date.UTC(2026, 9, 9, 12)

function profile(name: string, overrides: Partial<ProfileStatus> = {}): ProfileStatus {
  return {
    profile: name,
    band: 'ok',
    weekly: { usedFraction: 0.2, resetsAt: NOW + 3 * 24 * HOUR_MS, lengthMs: WEEK_MS },
    fiveHour: { usedFraction: 0.1, resetsAt: NOW + 4 * HOUR_MS, lengthMs: FIVE_HOURS_MS },
    rateLimitedUntil: null,
    tokenExpiresAt: null,
    latencyMs: { p50: null, p95: null, p99: null },
    ...overrides,
  }
}

describe('wire format', () => {
  const query: SeriesQuery = {
    metric: 'requests',
    groupBy: 'client',
    range: { start: NOW - 24 * HOUR_MS, end: NOW },
    stepSeconds: 300,
  }

  it('round-trips a series query', () => {
    expect(seriesQueryFromParams(seriesQueryToParams(query))).toEqual(query)
    const { groupBy: _, ...total } = query
    expect(seriesQueryFromParams(seriesQueryToParams(total))).toEqual(total)
  })

  it.each([
    ['an unknown metric', { metric: 'secrets' }],
    ['a split the metric does not have', { groupBy: 'model', metric: 'errors' }],
    ['a reversed range', { start: String(NOW), end: String(NOW - 1) }],
    ['a range over 15 days', { start: String(NOW - 16 * 24 * HOUR_MS) }],
    ['a step under a minute', { step: '30' }],
    ['too many points', { start: String(NOW - 14 * 24 * HOUR_MS), step: '60' }],
    ['a non-numeric bound', { start: '1e12' }],
  ])('refuses %s', (_, change) => {
    const params = seriesQueryToParams(query)
    for (const [k, v] of Object.entries(change)) params.set(k, v)
    expect(() => seriesQueryFromParams(params)).toThrow(BadQueryError)
  })

  it('accepts exactly the point limit', () => {
    const params = seriesQueryToParams({
      ...query,
      range: { start: NOW - MAX_POINTS * 60_000, end: NOW },
      stepSeconds: 60,
    })
    expect(() => seriesQueryFromParams(params)).not.toThrow()
  })
})

describe('headline', () => {
  it('counts a rate-limited or exhausted subscription as without headroom', () => {
    expect(hasHeadroom(profile('a'), NOW)).toBe(true)
    expect(hasHeadroom(profile('a', { band: 'exhausted' }), NOW)).toBe(false)
    expect(hasHeadroom(profile('a', { rateLimitedUntil: NOW + 60_000 }), NOW)).toBe(false)
    expect(hasHeadroom(profile('a', { rateLimitedUntil: NOW - 60_000 }), NOW)).toBe(true)
  })

  it('finds the soonest projected run-out among subscriptions with headroom', () => {
    // 80% of a 5-hour window gone in 2.5 hours: the rest lasts about 37 minutes.
    const fast = profile('fast', {
      fiveHour: { usedFraction: 0.8, resetsAt: NOW + 2.5 * HOUR_MS, lengthMs: FIVE_HOURS_MS },
    })
    const spent = profile('spent', {
      band: 'exhausted',
      weekly: { usedFraction: 1, resetsAt: NOW + HOUR_MS, lengthMs: WEEK_MS },
    })
    const runOut = nextRunOut([profile('slow'), spent, fast], NOW)
    expect(runOut?.profile).toBe('fast')
    expect(runOut?.window).toBe('fiveHour')
    expect(((runOut?.at ?? 0) - NOW) / 60_000).toBeCloseTo(37.5, 0)
    expect(nextRunOut([profile('slow')], NOW)).toBeNull()
  })

  it('counts no reading, an expired login and a used-up 5-hour window as without headroom', () => {
    expect(hasHeadroom(profile('a', { band: 'unknown' }), NOW)).toBe(false)
    expect(hasHeadroom(profile('a', { tokenExpiresAt: NOW - 1 }), NOW)).toBe(false)
    expect(hasHeadroom(profile('a', { tokenExpiresAt: NOW + HOUR_MS }), NOW)).toBe(true)
    const fiveHourSpent = { usedFraction: 1, resetsAt: NOW + HOUR_MS, lengthMs: FIVE_HOURS_MS }
    expect(hasHeadroom(profile('a', { fiveHour: fiveHourSpent }), NOW)).toBe(false)
    // Once that window has reset, the old reading no longer blocks.
    const reset = { ...fiveHourSpent, resetsAt: NOW - 1 }
    expect(hasHeadroom(profile('a', { fiveHour: reset }), NOW)).toBe(true)
  })

  it('says when the first blocked subscription takes work again, by its last blocker', () => {
    // Used up weekly for 9 hours: its 5-hour reset in 30 minutes does not free it.
    const weeklySpent = profile('weekly', {
      band: 'exhausted',
      weekly: { usedFraction: 1, resetsAt: NOW + 9 * HOUR_MS, lengthMs: WEEK_MS },
      fiveHour: { usedFraction: 1, resetsAt: NOW + 0.5 * HOUR_MS, lengthMs: FIVE_HOURS_MS },
    })
    const limited = profile('limited', { rateLimitedUntil: NOW + 2 * HOUR_MS })
    const expired = profile('expired', { tokenExpiresAt: NOW - 1 })
    expect(nextAvailable([weeklySpent, limited, expired], NOW)).toEqual({
      profile: 'limited',
      at: NOW + 2 * HOUR_MS,
    })
    expect(nextAvailable([weeklySpent], NOW)?.at).toBe(NOW + 9 * HOUR_MS)
    expect(nextAvailable([expired], NOW)).toBeNull()
    // Used up with an unknown reset: a shorter rate limit does not make it available.
    const unknownReset = profile('unknown', {
      band: 'exhausted',
      weekly: { usedFraction: 1, resetsAt: null, lengthMs: WEEK_MS },
      fiveHour: null,
      rateLimitedUntil: NOW + 10 * 60_000,
    })
    expect(nextAvailable([unknownReset], NOW)).toBeNull()
    expect(hasHeadroom(unknownReset, NOW)).toBe(false)
  })
})

describe('format', () => {
  it('counts down in the two largest units', () => {
    expect(formatCountdown(3 * 24 * HOUR_MS + 2 * HOUR_MS + 5 * 60_000)).toBe('3d 2h')
    expect(formatCountdown(2 * 24 * HOUR_MS)).toBe('2d')
    expect(formatCountdown(2 * HOUR_MS + 12 * 60_000)).toBe('2h 12m')
    expect(formatCountdown(12 * 60_000 + 59_000)).toBe('12m')
    expect(formatCountdown(40_000)).toBe('40s')
    expect(formatCountdown(0)).toBe('now')
  })

  it('formats shares, counts and durations, with a dash for unknown', () => {
    expect(formatPercent(0.424)).toBe('42%')
    expect(formatPercent(0.025)).toBe('2.5%')
    expect(formatPercent(0)).toBe('0%')
    expect(formatPercent(0.996)).toBe('99.6%')
    expect(formatPercent(1)).toBe('100%')
    expect(formatPercent(null)).toBe('—')
    expect(formatCount(1234)).toBe('1,234')
    expect(formatCount(12_400)).toBe('12.4K')
    expect(formatDuration(840)).toBe('840 ms')
    expect(formatDuration(14_230)).toBe('14.2 s')
    expect(formatDuration(null)).toBe('—')
  })

  it('names a time by how far away it is', () => {
    expect(formatWhen(NOW + 2 * HOUR_MS, NOW, 'UTC')).toBe('14:00')
    expect(formatWhen(Date.UTC(2026, 9, 12, 9, 30), NOW, 'UTC')).toBe('Mon 09:30')
    expect(formatWhen(Date.UTC(2026, 9, 30, 9, 30), NOW, 'UTC')).toBe('Oct 30, 09:30')
  })
})
