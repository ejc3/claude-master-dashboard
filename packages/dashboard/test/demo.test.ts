import { describe, expect, it } from 'vitest'
import { HOUR_MS, pace, UnsupportedQueryError } from '../src/core/index.js'
import { createDemoSource, DEMO_VALUES } from '../src/demo/index.js'

const NOW = Date.UTC(2026, 9, 9, 12)
const source = createDemoSource({ now: () => NOW })
const range = { start: NOW - 24 * HOUR_MS, end: NOW }

describe('demo source', () => {
  it('is reproducible', async () => {
    const again = createDemoSource({ now: () => NOW })
    expect(await again.snapshot()).toEqual(await source.snapshot())
    const query = {
      metric: 'requests' as const,
      groupBy: 'profile' as const,
      range,
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

  it('buckets each series on step boundaries inside the range', async () => {
    const series = await source.series({
      metric: 'requests',
      groupBy: 'client',
      range,
      stepSeconds: 300,
    })
    expect(series.map((s) => s.key)).toEqual(DEMO_VALUES.client)
    for (const { points } of series) {
      expect(points.length).toBe(24 * 12 + 1)
      for (const [at, value] of points) {
        expect(at % 300_000).toBe(0)
        expect(at).toBeGreaterThanOrEqual(range.start)
        expect(at).toBeLessThanOrEqual(range.end)
        expect(Number.isFinite(value) && value >= 0).toBe(true)
      }
    }
  })

  it('refuses what claude-master does not emit, as a real source does', async () => {
    await expect(
      source.series({ metric: 'errors', groupBy: 'model', range, stepSeconds: 300 }),
    ).rejects.toThrow(UnsupportedQueryError)
  })
})
