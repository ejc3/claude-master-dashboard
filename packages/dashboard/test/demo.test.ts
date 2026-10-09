import { describe, expect, it } from 'vitest'
import {
  BadQueryError,
  HOUR_MS,
  pace,
  type SeriesQuery,
  UnsupportedQueryError,
  validateSeriesQuery,
} from '../src/core/index.js'
import { createDemoSource, DEMO_VALUES, split } from '../src/demo/index.js'

const NOW = Date.UTC(2026, 9, 9, 12)
const source = createDemoSource({ now: () => NOW })
const day = { start: NOW - 24 * HOUR_MS, end: NOW }
const sum = (points: Array<[number, number]>) => points.reduce((a, [, v]) => a + v, 0)

describe('demo source', () => {
  it('is reproducible', async () => {
    const again = createDemoSource({ now: () => NOW })
    expect(await again.snapshot()).toEqual(await source.snapshot())
    const query: SeriesQuery = {
      metric: 'requests',
      groupBy: 'profile',
      range: day,
      stepSeconds: 300,
    }
    expect(await again.series(query)).toEqual(await source.series(query))
  })

  it('shows every state the dashboard must render', async () => {
    const snapshot = await source.snapshot()
    expect(new Set(snapshot.profiles.map((p) => p.band))).toEqual(
      new Set(['ok', 'exhausted', 'reserve']),
    )
    expect(new Set(snapshot.profiles.map((p) => pace(p.weekly, NOW)))).toEqual(
      new Set(['even', 'ahead', 'over']),
    )
    expect(snapshot.profiles.some((p) => p.fiveHour === null)).toBe(true)
    expect(snapshot.profiles.some((p) => p.rateLimitedUntil !== null)).toBe(true)
  })

  it('buckets on step boundaries with the end exclusive, as GetMetricData does', async () => {
    const series = await source.series({
      metric: 'requests',
      groupBy: 'client',
      range: day,
      stepSeconds: 300,
    })
    expect(series.map((s) => s.key)).toEqual(DEMO_VALUES.client)
    for (const { points } of series) {
      expect(points.length).toBe(24 * 12)
      expect(points[0]?.[0]).toBe(day.start)
      expect((points.at(-1)?.[0] ?? 0) + 300_000).toBe(day.end)
      for (const [, value] of points) expect(Number.isInteger(value) && value >= 0).toBe(true)
    }
  })

  it('adds up: every split sums to the total, at any step', async () => {
    const totalAt = async (stepSeconds: number) =>
      sum((await source.series({ metric: 'requests', range: day, stepSeconds }))[0]?.points ?? [])
    const total = await totalAt(300)
    expect(await totalAt(60)).toBe(total)
    expect(await totalAt(3600)).toBe(total)
    for (const groupBy of [
      'profile',
      'client',
      'client_account',
      'model',
      'status_class',
    ] as const) {
      const split = await source.series({
        metric: 'requests',
        groupBy,
        range: day,
        stepSeconds: 300,
      })
      expect(
        split.reduce((a, s) => a + sum(s.points), 0),
        groupBy,
      ).toBe(total)
    }
  })

  it('counts an error for every non-2xx request', async () => {
    const errors = sum(
      (await source.series({ metric: 'errors', range: day, stepSeconds: 300 }))[0]?.points ?? [],
    )
    const classes = await source.series({
      metric: 'requests',
      groupBy: 'status_class',
      range: day,
      stepSeconds: 300,
    })
    const non2xx = classes.filter((s) => s.key !== '2xx').reduce((a, s) => a + sum(s.points), 0)
    expect(errors).toBeGreaterThan(0)
    expect(non2xx).toBe(errors)
  })

  it('tells the same story in history as in the snapshot', async () => {
    const snapshot = await source.snapshot()
    const used = await source.series({
      metric: 'weeklyUsed',
      groupBy: 'profile',
      range: { start: NOW - HOUR_MS, end: NOW },
      stepSeconds: 60,
    })
    for (const p of snapshot.profiles) {
      const last = used.find((s) => s.key === p.profile)?.points.at(-1)?.[1]
      expect(last, p.profile).toBeCloseTo(p.weekly.usedFraction ?? -1, 2)
    }
  })

  it('refuses what claude-master does not emit, and queries no source should run', async () => {
    await expect(
      source.series({ metric: 'errors', groupBy: 'model', range: day, stepSeconds: 300 }),
    ).rejects.toThrow(UnsupportedQueryError)
    for (const stepSeconds of [-60, 0, 30, 90, Number.NaN]) {
      await expect(source.series({ metric: 'requests', range: day, stepSeconds })).rejects.toThrow(
        BadQueryError,
      )
    }
  })
})

describe('validateSeriesQuery', () => {
  const ok: SeriesQuery = { metric: 'requests', range: day, stepSeconds: 300 }
  it.each([
    ['a reversed range', { ...ok, range: { start: NOW, end: NOW - 1 } }],
    ['an empty range', { ...ok, range: { start: NOW, end: NOW } }],
    ['a range over 15 days', { ...ok, range: { start: NOW - 16 * 24 * HOUR_MS, end: NOW } }],
    [
      'too many points',
      { ...ok, range: { start: NOW - 14 * 24 * HOUR_MS, end: NOW }, stepSeconds: 60 },
    ],
    ['a fractional bound', { ...ok, range: { start: 0.5, end: NOW } }],
  ])('refuses %s', (_, query) => {
    expect(() => validateSeriesQuery(query)).toThrow(BadQueryError)
  })
})

describe('split', () => {
  it('divides a whole count into whole parts that add up', () => {
    expect(split(10, [0.5, 0.3, 0.2])).toEqual([5, 3, 2])
    expect(split(7, [1, 1, 1])).toEqual([3, 2, 2])
    expect(split(0, [1, 2])).toEqual([0, 0])
    expect(split(5, [0, 0])).toEqual([0, 0])
  })
})
