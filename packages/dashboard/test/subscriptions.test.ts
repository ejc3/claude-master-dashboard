import { describe, expect, it } from 'vitest'
import { type EpochMs, HOUR_MS, subscriptionCount } from '../src/core/index'

const T0 = Date.UTC(2026, 9, 9, 0, 0, 0)
const STEP_S = 3600
const query = (hours: number) => ({
  range: { start: T0, end: T0 + hours * HOUR_MS },
  stepSeconds: STEP_S,
})
// A reading every 10 minutes from `from` to `to` hours.
const readings = (key: string, from: number, to: number) => ({
  key,
  points: Array.from({ length: Math.round((to - from) * 6) }, (_, i): [EpochMs, number] => [
    T0 + from * HOUR_MS + i * 600_000,
    0.5,
  ]),
})
const counts = (series: Array<[EpochMs, number]>) => series.map(([, v]) => v)

describe('subscriptionCount', () => {
  it('steps up when a subscription joins the pool', () => {
    const series = subscriptionCount(
      [readings('a', 0, 6), readings('b', 0, 6), readings('c', 3, 6)],
      query(6),
    )
    expect(series.map(([t]) => t)).toEqual([0, 1, 2, 3, 4, 5].map((h) => T0 + h * HOUR_MS))
    expect(counts(series)).toEqual([2, 2, 2, 3, 3, 3])
  })

  it('keeps one through a gap shorter than the hold, and drops it after a longer one', () => {
    // b misses 50 minutes (2:00 to 2:50) and then stops at 4:00.
    const b = {
      key: 'b',
      points: [...readings('b', 0, 2).points, ...readings('b', 2 + 5 / 6, 4).points],
    }
    expect(counts(subscriptionCount([readings('a', 0, 7), b], query(7)))).toEqual([
      2, 2, 2, 2, 2, 1, 1,
    ])
  })

  it('counts the newest step, which CloudWatch has not filled yet, from the readings before it', () => {
    expect(counts(subscriptionCount([readings('a', 0, 2)], query(3)))).toEqual([1, 1, 1])
  })

  it('ignores a reading that is not a number', () => {
    const bad = { key: 'x', points: [[T0, Number.NaN]] as Array<[EpochMs, number]> }
    expect(counts(subscriptionCount([bad, readings('a', 0, 1)], query(1)))).toEqual([1])
  })
})
