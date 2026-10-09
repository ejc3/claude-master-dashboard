import { describe, expect, it } from 'vitest'
import { fillSeries, HOUR_MS, type SeriesQuery, sumBetween, sumSeries } from '../src/core'

const T = Date.UTC(2026, 9, 9, 11)
const query: SeriesQuery = {
  metric: 'requests',
  range: { start: T, end: T + HOUR_MS },
  stepSeconds: 900,
}

describe('fillSeries', () => {
  it('lines up series with gaps by time, so sums add up and land on the right bucket', () => {
    // As CloudWatch answers: each group lists only the buckets it has data for.
    const filled = fillSeries(
      [
        { key: 'alpha', points: [[T, 10]] },
        {
          key: 'beta',
          points: [
            [T + 30 * 60_000, 20],
            [T + 45 * 60_000, 30],
          ],
        },
      ],
      query,
    )
    expect(filled.map((s) => s.points.map(([t]) => t))).toEqual([
      [T, T + 900_000, T + 1_800_000, T + 2_700_000],
      [T, T + 900_000, T + 1_800_000, T + 2_700_000],
    ])
    expect(sumSeries(filled)).toEqual([
      [T, 10],
      [T + 900_000, 0],
      [T + 1_800_000, 20],
      [T + 2_700_000, 30],
    ])
  })

  it('sums by time, not by position', () => {
    const points: Array<[number, number]> = [
      [T + 6 * HOUR_MS, 12],
      [T + 7 * HOUR_MS, 13],
      [T + 10 * HOUR_MS, 14],
    ]
    // Nothing in the hour before T + 12h, whatever the last three points are.
    expect(sumBetween(points, T + 11 * HOUR_MS, T + 12 * HOUR_MS)).toBe(0)
    expect(sumBetween(points, T + 6 * HOUR_MS, T + 8 * HOUR_MS)).toBe(25)
  })
})
