import { describe, expect, it } from 'vitest'
import {
  FIVE_HOURS_MS,
  GAPS_HORIZON_MS,
  gapsHeadline,
  HOUR_MS,
  type PoolGaps,
  type ProfileStatus,
  poolGaps,
  TRACE_STEP_MS,
  WEEK_MS,
} from '../src/core/index'

const NOW = Date.UTC(2026, 9, 9, 12)
const H = HOUR_MS
const M = 60_000

/** A subscription: its weekly and 5-hour used shares and resets (null: not read). */
function sub(
  name: string,
  weekly: [number, number] | null,
  five: [number, number | null] | null,
  extra: Partial<ProfileStatus> = {},
): ProfileStatus {
  return {
    profile: name,
    band: 'ok',
    weekly:
      weekly === null
        ? { usedFraction: null, resetsAt: null, lengthMs: WEEK_MS }
        : { usedFraction: weekly[0], resetsAt: NOW + weekly[1], lengthMs: WEEK_MS },
    fiveHour:
      five === null
        ? null
        : {
            usedFraction: five[0],
            resetsAt: five[1] === null ? null : NOW + five[1],
            lengthMs: FIVE_HOURS_MS,
          },
    rateLimitedUntil: null,
    tokenExpiresAt: null,
    latencyMs: { p50: null, p95: null, p99: null },
    ...extra,
  }
}

const rates = (entries: Record<string, number>) => new Map(Object.entries(entries))
const hours = (g: PoolGaps) =>
  g.gaps.map((gap) => ({
    start: (gap.start - NOW) / H,
    end: gap.end === null ? null : (gap.end - NOW) / H,
    endsWith: gap.endsWith,
  }))
/** The status line and its facts, as one string: "headline | fact | fact". */
const headline = (g: PoolGaps) => {
  const h = gapsHeadline(g, NOW)
  return [h.headline, ...h.facts].join(' | ')
}

describe('poolGaps: both windows in one simulation', () => {
  it('a pool much like a real one: 5-hour gaps soon, then a week of days', () => {
    // One subscription with room in its week and little in its 5-hour window, one with room in
    // its week and no 5-hour reading, two whose weeks are used up.
    const g = poolGaps(
      [
        sub('a', [0.27, 81 * H], null),
        sub('b', [0.47, 158 * H], [0.77, 3.75 * H]),
        sub('c', [1, 95 * H], null),
        sub('d', [1, 58 * H], null),
      ],
      NOW,
      rates({ a: 0.03, b: 0.06, c: 0.03, d: 0.03 }),
    )
    // a's 5-hour window, unread, starts with its first work and fills, then b's.
    expect(hours(g).slice(0, 3)).toEqual([
      { start: 2, end: 3.75, endsWith: 'fiveHour' },
      { start: 7 + 2 / 60, end: 8 + 46 / 60, endsWith: 'fiveHour' },
      { start: 11 + 56 / 60, end: 58, endsWith: 'weekly' },
    ])
    expect(headline(g)).toBe(
      'On pace to run out in 2h | Out for 1h 45m, until a 5-hour window resets | Then again in 11h 56m, for 1d 22h, until a week resets',
    )
    expect(gapsHeadline(g, NOW).tone).toBe('warning')
  })

  it('every week full: out now until the first week resets, whatever the 5-hour windows', () => {
    const g = poolGaps(
      [sub('a', [1, 50 * H], [0.1, 3 * H]), sub('b', [1, 60 * H], [0.1, 3 * H])],
      NOW,
    )
    expect(hours(g)[0]).toEqual({ start: 0, end: 50, endsWith: 'weekly' })
    expect(headline(g)).toMatch(/^Out of capacity now \| Work resumes in 2d 2h, when a week resets/)
    expect(gapsHeadline(g, NOW).tone).toBe('error')
  })

  it('uses up no week during a 5-hour gap', () => {
    // Weeks nearly full, 5-hour windows half used: the 5-hour windows go first, and the weeks
    // run out only after enough working hours between 5-hour gaps.
    const g = poolGaps(
      [sub('a', [0.97, 50 * H], [0.5, 4.5 * H]), sub('b', [0.97, 60 * H], [0.5, 4.5 * H])],
      NOW,
      rates({ a: 0.01, b: 0.01 }),
    )
    expect(hours(g).slice(0, 3)).toEqual([
      { start: 0.5, end: 4.5, endsWith: 'fiveHour' },
      { start: 5.5, end: 9.5, endsWith: 'fiveHour' },
      { start: 10.5, end: 14.5, endsWith: 'fiveHour' },
    ])
    expect(hours(g).find((gap) => gap.endsWith === 'weekly')).toEqual({
      start: 15 + 16 / 60,
      end: 50,
      endsWith: 'weekly',
    })
    expect(headline(g)).toBe(
      'On pace to run out in 30m | Out for 4h, until a 5-hour window resets | Then again in 15h 16m, for 1d 10h, until a week resets',
    )
  })

  it('has no 5-hour gap inside a weekly one', () => {
    const g = poolGaps(
      [sub('a', [0.99, 50 * H], [0.15, 4.5 * H]), sub('b', [0.99, 60 * H], [0.15, 4.5 * H])],
      NOW,
      rates({ a: 0.01, b: 0.01 }),
    )
    expect(hours(g)[0]).toEqual({ start: 1, end: 50, endsWith: 'weekly' })
    expect((hours(g)[1]?.start ?? Infinity) >= 50).toBe(true)
    expect(headline(g)).toBe('On pace to run out in 1h | Out for 2d 1h, until a week resets')
  })

  it('keeps the others working through one subscription’s gap', () => {
    // a is out of both windows; b, with no 5-hour reading, works on until its week is full.
    const g = poolGaps(
      [sub('a', [1, 50 * H], [1, 3 * H]), sub('b', [0.9, 60 * H], null)],
      NOW,
      rates({ a: 0, b: 0.1 }),
    )
    expect(hours(g)[0]).toEqual({ start: 1, end: 50, endsWith: 'weekly' })
  })

  it('ends a gap at the reset that lets work flow, not the first reset', () => {
    // The week resets in an hour, but the 5-hour window is full for four.
    const one = poolGaps([sub('a', [1, H], [1, 4 * H])], NOW)
    expect(hours(one)[0]).toEqual({ start: 0, end: 4, endsWith: 'fiveHour' })
    expect(headline(one)).toBe(
      'Out of capacity now | Work resumes in 4h, when a 5-hour window resets',
    )
    // With a second subscription whose week resets in two hours, that ends it.
    const two = poolGaps([sub('a', [1, H], [1, 4 * H]), sub('b', [1, 2 * H], [0.1, 3 * H])], NOW)
    expect(hours(two)[0]).toEqual({ start: 0, end: 2, endsWith: 'weekly' })
  })

  it('opens a 5-hour window with work when none is open, and closes it at its reset', () => {
    // b reports no window open (nothing used, no reset time): it opens at b's first work, so
    // the gap lasts until that window resets, not until a week does.
    const g = poolGaps(
      [sub('a', [1, 72 * H], [0.5, 4 * H]), sub('b', [0.2, 100 * H], [0, null])],
      NOW,
      rates({ a: 0.001, b: 0.001 }),
    )
    expect(hours(g)[0]).toEqual({ start: 2, end: 5, endsWith: 'fiveHour' })
    expect(headline(g)).toBe('On pace to run out in 2h | Out for 3h, until a 5-hour window resets')
    // a's window resets five minutes in, while its week is full: the next opens when work
    // resumes at 4h, not on the old window's five-hour clock.
    const c = sub('c', [0.3, 100 * H], [0.5, H], { tokenExpiresAt: NOW - H })
    const after = poolGaps(
      [sub('a', [1, 4 * H], [0.9, 5 * M]), c],
      NOW,
      rates({ a: 0.001, c: 0.001 }),
    )
    expect(hours(after)[0]).toEqual({ start: 0, end: 4, endsWith: 'weekly' })
    expect(hours(after)[1]?.end).toBe(9)
  })

  it('lists every gap in the horizon, so a weekly one after many 5-hour ones is found', () => {
    const subs = [0, 1, 2, 3].map((i) =>
      sub(`s${i}`, [0.6, (150 + i) * H], [0.8, (1.25 * (i + 1) - 0.01) * H]),
    )
    const g = poolGaps(subs, NOW, new Map(subs.map((s) => [s.profile, 0.012])))
    expect(g.gaps.length).toBeGreaterThan(50)
    expect(headline(g)).toMatch(/ \| Then again in 4d 19h, for 1d 10h, until a week resets$/)
  })

  it('finds a run-out of a few minutes, as the 5-hour card does', () => {
    const g = poolGaps([sub('a', [0.1, 100 * H], [0.99, 4.5 * M])], NOW)
    expect(headline(g)).toBe('On pace to run out in 4m | Out for 30s, until a 5-hour window resets')
  })

  it('after a short weekly gap, names the next weekly one that lasts longer, past 5-hour ones', () => {
    const g = poolGaps(
      [sub('a', [1, 10 * M], [0, M]), sub('b', [1, 72 * H], [0.5, 4 * H])],
      NOW,
      rates({ a: 0.02, b: 0.02 }),
    )
    expect(headline(g)).toBe(
      'Out of capacity now | Work resumes in 10m, when a week resets | Then again in 2d 13h, for 10h 50m, until a week resets',
    )
  })

  it('keeps a full 5-hour window closed until its reset, from the readings time', () => {
    // Read at 11:55 (from), now is 12:00; the full window resets at 11:59:30. Work can start only
    // then, so the week is used for 30 seconds before now, not five minutes.
    const from = NOW - 5 * M
    const profile = {
      ...sub('a', [0.99, 48 * H], null),
      fiveHour: { usedFraction: 1, resetsAt: NOW - 30_000, lengthMs: FIVE_HOURS_MS },
    }
    const g = poolGaps([profile], from, rates({ a: 0.6 }), NOW)
    // The week (1% left at 60% an hour) lasts a minute of work: it runs out after now.
    expect(g.gaps[0]?.start ?? 0).toBeGreaterThan(NOW)
    expect(g.gaps[0]?.endsWith).toBe('weekly')
  })

  it('keeps a rate-limited subscription out of work until the limit ends', () => {
    const g = poolGaps([sub('a', [0.3, 100 * H], null, { rateLimitedUntil: NOW + 2 * H })], NOW)
    expect(hours(g)[0]).toEqual({ start: 0, end: 2, endsWith: 'rateLimit' })
    expect(headline(g)).toBe('Out of capacity now | Work resumes in 2h, when a rate limit ends')
  })

  it('a pool hit by its 5-hour limits: out within minutes, not "two can take work"', () => {
    // One near the end of its 5-hour window, one whose window is full (its last reading kept),
    // two with their weeks used up, one rate-limited.
    const g = poolGaps(
      [
        sub('a', [0.52, 78 * H], [0.96, 3.77 * H]),
        sub('b', [0.54, 155 * H], [1, H]),
        sub('c', [1, 92 * H], null),
        sub('d', [1, 55 * H], null),
        sub('e', [0.27, 107 * H], null, { rateLimitedUntil: NOW + 146 * M }),
      ],
      NOW,
      rates({ a: 0.05, b: 0.05, c: 0.05, d: 0.05, e: 0.05 }),
    )
    expect(hours(g)[0]).toEqual({ start: 4 / 60, end: 1, endsWith: 'fiveHour' })
    expect(headline(g)).toMatch(
      /^On pace to run out in 4m \| Out for 56m, until a 5-hour window resets/,
    )
  })

  it('skips a gap that has ended by now, and starts from the readings', () => {
    // Read three hours ago: a week full then, reset an hour ago.
    const from = NOW - 3 * H
    const g = poolGaps(
      [
        {
          ...sub('a', [1, 0], null),
          weekly: { usedFraction: 1, resetsAt: NOW - H, lengthMs: WEEK_MS },
        },
      ],
      from,
      new Map(),
      NOW,
    )
    expect(g.gaps.every((gap) => gap.end === null || gap.end > NOW)).toBe(true)
    expect(g.gaps[0]?.start ?? Infinity).toBeGreaterThan(NOW - H)
  })

  it('reads idle, unknown and expired logins', () => {
    expect(poolGaps([sub('a', [0.2, 50 * H], [0.1, 3 * H])], NOW, rates({ a: 0 })).lasts).toBe(
      'horizon',
    )
    expect(poolGaps([sub('a', [0, 50 * H], [0, 3 * H])], NOW, rates({ a: 0 })).lasts).toBe('idle')
    expect(poolGaps([sub('a', null, [0.5, 3 * H])], NOW).lasts).toBe('unknown')
    expect(poolGaps([sub('a', [0.5, 50 * H], null, { tokenExpiresAt: NOW - 1 })], NOW).lasts).toBe(
      'logins',
    )
  })
})

describe('poolGaps capacity trace', () => {
  it('starts at what is left, falls at the pace of use, and steps up when a week resets', () => {
    // Two subscriptions with half their week left each; one resets in a day.
    const g = poolGaps(
      [sub('a', [0.5, 24 * H], [0, null]), sub('b', [0.5, 100 * H], [0, null])],
      NOW,
      rates({ a: 0.01, b: 0.01 }),
    )
    const at = (h: number) => g.trace.find((p) => p.at === NOW + h * H)
    expect(g.trace[0]).toEqual({ at: NOW, weekly: 1, fiveHour: 2 })
    // 2% of one subscription's week an hour: 0.98 left after an hour.
    expect(at(1)?.weekly).toBeCloseTo(0.98, 6)
    // a's week resets at 24h: what is left jumps by a's used share.
    const before = at(23 + 5 / 6)?.weekly ?? 0
    const after = at(24)?.weekly ?? 0
    expect(after - before).toBeGreaterThan(0.5)
    // Every sample is on the grid, to the horizon.
    expect(g.trace.every((p, i) => p.at === NOW + i * TRACE_STEP_MS)).toBe(true)
    expect(g.trace.at(-1)?.at).toBe(NOW + GAPS_HORIZON_MS)
  })

  it('shows a reset during a gap, and with no use at all', () => {
    // The week resets in an hour, the full 5-hour window in four: work stops until 4h, but the
    // week's allowance is back at 1h.
    const g = poolGaps([sub('a', [1, H], [1, 4 * H])], NOW)
    const at = (gaps: PoolGaps, h: number) => gaps.trace.find((p) => p.at === NOW + h * H)
    expect(at(g, 0.5)?.weekly).toBe(0)
    expect(at(g, 1)?.weekly).toBe(1)
    // Nothing used: half the week left until its reset at 24h, then all of it.
    const idle = poolGaps([sub('a', [0.5, 24 * H], [0, null])], NOW, rates({ a: 0 }))
    expect(at(idle, 23)?.weekly).toBe(0.5)
    expect(at(idle, 24)?.weekly).toBe(1)
  })

  it('holds what is left through a gap, then shows the reset that ends it', () => {
    // Every week full until the first resets in 50h.
    const g = poolGaps(
      [sub('a', [1, 50 * H], [0.1, 3 * H]), sub('b', [1, 60 * H], [0.1, 3 * H])],
      NOW,
    )
    const at = (h: number) => g.trace.find((p) => p.at === NOW + h * H)
    expect(at(10)?.weekly).toBe(0)
    expect(at(49 + 5 / 6)?.weekly).toBe(0)
    expect(at(50)?.weekly).toBeCloseTo(1, 6)
  })
})

describe('gapsHeadline', () => {
  const g = (over: Partial<PoolGaps>): PoolGaps => ({
    counted: 2,
    unreported: 0,
    gaps: [],
    lasts: null,
    trace: [],
    capacity: 2,
    ...over,
  })

  it('says when nothing runs out, or nothing is known', () => {
    expect(gapsHeadline(null, NOW)).toEqual({
      tone: 'info',
      headline: 'Waiting for the first reading',
      facts: [],
    })
    expect(gapsHeadline(g({ lasts: 'unknown' }), NOW)).toEqual({
      tone: 'info',
      headline: 'No weekly usage reported yet',
      facts: [],
    })
    expect(gapsHeadline(g({ lasts: 'horizon' }), NOW)).toEqual({
      tone: 'success',
      headline: 'Not on pace to run out in the next 7 days',
      facts: [],
    })
  })

  it('says every login has expired, among the reporting ones when some do not report', () => {
    expect(gapsHeadline(g({ lasts: 'logins' }), NOW)).toEqual({
      tone: 'error',
      headline: 'Every login has expired',
      facts: ['Log the subscriptions in again'],
    })
    expect(gapsHeadline(g({ lasts: 'logins', counted: 1, unreported: 1 }), NOW)).toEqual({
      tone: 'warning',
      headline: 'Every login has expired',
      facts: ['Counting the 1 that report their weekly usage'],
    })
  })

  it('names those it covers when some subscriptions do not report, and never reads as an error', () => {
    const out = g({
      counted: 3,
      unreported: 1,
      gaps: [{ start: NOW, end: NOW + 2 * H, endsWith: 'weekly' }],
    })
    expect(gapsHeadline(out, NOW)).toEqual({
      tone: 'warning',
      headline: 'Out of capacity now',
      facts: [
        'Work resumes in 2h, when a week resets',
        'Counting the 3 that report their weekly usage',
      ],
    })
  })

  it('says when no reset time is known', () => {
    expect(gapsHeadline(g({ gaps: [{ start: NOW + H, end: null, endsWith: null }] }), NOW)).toEqual(
      {
        tone: 'warning',
        headline: 'On pace to run out in 1h',
        facts: ['No reset time is known'],
      },
    )
  })

  it('names a later gap only when a week ends it and it lasts longer', () => {
    const week = { start: NOW + H, end: NOW + 30 * H, endsWith: 'weekly' as const }
    const shorter = { start: NOW + 40 * H, end: NOW + 44 * H, endsWith: 'fiveHour' as const }
    const longer = { start: NOW + 50 * H, end: NOW + 100 * H, endsWith: 'weekly' as const }
    expect(gapsHeadline(g({ gaps: [week, shorter] }), NOW).facts).toEqual([
      'Out for 1d 5h, until a week resets',
    ])
    expect(gapsHeadline(g({ gaps: [week, shorter, longer] }), NOW).facts).toEqual([
      'Out for 1d 5h, until a week resets',
      'Then again in 2d 2h, for 2d 2h, until a week resets',
    ])
  })
})

describe('poolGaps invariants (seeded)', () => {
  // A small deterministic generator, so a failure names its seed.
  function rng(seed: number) {
    let x = seed >>> 0 || 1
    return () => {
      x ^= x << 13
      x ^= x >>> 17
      x ^= x << 5
      return (x >>> 0) / 2 ** 32
    }
  }

  it('gives ordered gaps that do not overlap, end after they start, and have not ended by now', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed)
      const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)] as T
      const profiles = Array.from({ length: 1 + Math.floor(r() * 5) }, (_, i) =>
        sub(
          `s${i}`,
          r() < 0.1 ? null : [pick([0, r(), 0.9 + r() * 0.1, 1]), r() * WEEK_MS],
          r() < 0.3 ? null : [pick([0, r(), 1]), r() * FIVE_HOURS_MS],
          r() < 0.1 ? { tokenExpiresAt: NOW - 1 } : {},
        ),
      )
      const smoothed = new Map(profiles.map((p) => [p.profile, r() < 0.5 ? r() * 0.2 : null]))
      const g = poolGaps(profiles, NOW, smoothed, NOW)
      let previousEnd = Number.NEGATIVE_INFINITY
      for (const gap of g.gaps) {
        const where = `seed ${seed}: ${JSON.stringify(hours(g))}`
        expect(gap.start, where).toBeGreaterThanOrEqual(previousEnd)
        expect(gap.start, where).toBeLessThanOrEqual(NOW + GAPS_HORIZON_MS)
        if (gap.end !== null) {
          expect(gap.end, where).toBeGreaterThan(gap.start)
          expect(gap.end, where).toBeGreaterThan(NOW)
          expect(gap.endsWith, where).not.toBeNull()
        }
        previousEnd = gap.end ?? Number.POSITIVE_INFINITY
      }
      expect(g.lasts === null, `seed ${seed}`).toBe(g.gaps.length > 0)
      // The status line and each fact start with a capital and are not sentences.
      const h = gapsHeadline(g, NOW)
      for (const line of [h.headline, ...h.facts]) {
        expect(line, `seed ${seed}`).toMatch(/^[A-Z][^.]*[^.]$/)
      }
    }
  })
})
