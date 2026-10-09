import { describe, expect, it } from 'vitest'
import { HOUR_MS } from '../src/core'
import { foldSeries, seriesColors, timeTicks } from '../src/react/LineChart'

const NOW = Date.UTC(2026, 9, 9, 12, 7)

describe('timeTicks', () => {
  it('puts at most the asked number of ticks on round local hours', () => {
    const first = NOW - 24 * HOUR_MS
    for (const most of [3, 6]) {
      const ticks = timeTicks(first, NOW, most)
      expect(ticks.length).toBeGreaterThan(0)
      expect(ticks.length).toBeLessThanOrEqual(most + 1)
      const offset = new Date(first).getTimezoneOffset() * 60_000
      for (const t of ticks) {
        expect((t - offset) % HOUR_MS).toBe(0)
        expect(t >= first && t <= NOW).toBe(true)
      }
    }
  })

  it('is empty for an empty range', () => {
    expect(timeTicks(NOW, NOW, 5)).toEqual([])
  })
})

describe('series helpers', () => {
  const s = (key: string, v: number) => ({
    key,
    points: [[0, v] as [number, number], [1, v] as [number, number]],
  })

  it('folds the smallest series past the limit into Other, keeping the total', () => {
    const series = ['a', 'b', 'c', 'd'].map((k, i) => s(k, i + 1))
    const folded = foldSeries(series, 3)
    expect(folded.map((x) => x.key)).toEqual(['d', 'c', 'Other'])
    expect(folded.at(-1)?.points).toEqual([
      [0, 3],
      [1, 3],
    ])
    expect(foldSeries(series, 4)).toBe(series)
  })

  it('colors by name across the known set, so a missing series repaints no other', () => {
    const known = ['alpha', 'bravo', 'charlie']
    const everything = seriesColors(known)
    // charlie has no data in this range; the chart still colors from the known set.
    const withoutCharlie = seriesColors([...known, 'alpha', 'bravo'])
    expect(withoutCharlie.get('bravo')).toBe(everything.get('bravo'))
    expect(everything.get('alpha')).toBe('var(--cmd-series-1)')
    expect(seriesColors(['charlie', 'bravo', 'alpha'])).toEqual(everything)
  })
})
