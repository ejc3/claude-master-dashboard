import { describe, expect, it } from 'vitest'
import { type EpochMs, HOUR_MS, subscriptionCount } from '../src/core/index'

const T0 = Date.UTC(2026, 9, 9, 0, 0, 0)
const FIVE_MIN = 5 * 60_000
const query = (hours: number, stepMs: number) => ({
  range: { start: T0, end: T0 + hours * HOUR_MS },
  stepSeconds: stepMs / 1000,
})
// As CloudWatch returns a gauge: one point per bucket with data, at the bucket's start.
const buckets = (key: string, stepMs: number, from: number, to: number) => ({
  key,
  points: Array.from(
    { length: Math.round(((to - from) * HOUR_MS) / stepMs) },
    (_, i): [EpochMs, number] => [T0 + from * HOUR_MS + i * stepMs, 0.5],
  ),
})
const counts = (series: Array<[EpochMs, number]>) => series.map(([, v]) => v)

describe('subscriptionCount', () => {
  it('steps up when a subscription joins the pool', () => {
    const series = subscriptionCount(
      [buckets('a', HOUR_MS, 0, 6), buckets('b', HOUR_MS, 0, 6), buckets('c', HOUR_MS, 3, 6)],
      query(6, HOUR_MS),
    )
    expect(series.map(([t]) => t)).toEqual([0, 1, 2, 3, 4, 5].map((h) => T0 + h * HOUR_MS))
    expect(counts(series)).toEqual([2, 2, 2, 3, 3, 3])
  })

  it('counts the newest hour, which CloudWatch has not filled yet, from the hour before', () => {
    expect(counts(subscriptionCount([buckets('a', HOUR_MS, 0, 2)], query(3, HOUR_MS)))).toEqual([
      1, 1, 1,
    ])
  })

  it('drops a subscription an hour after its last bucket ends', () => {
    // Hourly: the last bucket is 1:00 to 2:00, so it still counts at 2:00 and is gone at 3:00.
    expect(counts(subscriptionCount([buckets('a', HOUR_MS, 0, 2)], query(4, HOUR_MS)))).toEqual([
      1, 1, 1, 0,
    ])
    // Five-minute steps: the last bucket is 0:55 to 1:00, so it counts until 2:00.
    const fine = counts(subscriptionCount([buckets('a', FIVE_MIN, 0, 1)], query(3, FIVE_MIN)))
    expect(fine.slice(0, 24)).toEqual(Array(24).fill(1))
    expect(fine.slice(24)).toEqual(Array(12).fill(0))
  })

  it('keeps one through a gap shorter than the hold', () => {
    // Missing 1:00 to 1:50 in five-minute buckets.
    const b = {
      key: 'b',
      points: [
        ...buckets('b', FIVE_MIN, 0, 1).points,
        ...buckets('b', FIVE_MIN, 1 + 50 / 60, 3).points,
      ],
    }
    expect(counts(subscriptionCount([b], query(3, FIVE_MIN)))).toEqual(Array(36).fill(1))
  })

  it('ignores a reading that is not a number', () => {
    const bad = { key: 'x', points: [[T0, Number.NaN]] as Array<[EpochMs, number]> }
    expect(
      counts(subscriptionCount([bad, buckets('a', HOUR_MS, 0, 1)], query(1, HOUR_MS))),
    ).toEqual([1])
  })
})
