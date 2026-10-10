import { describe, expect, it } from 'vitest'
import type { EpochMs } from '../src/core/index'
import { stackedRows } from '../src/react/Breakdown'
import { accountColors } from '../src/react/Pool'

const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)
const STEP = 3_600_000
const grid = (values: number[]): Array<[EpochMs, number]> =>
  values.map((v, i) => [T0 + i * STEP, v])
const row = (key: string, values: number[]) => ({ key, points: grid(values) })
const NO_LABELS = new Map<string, string>()

describe('stackedRows', () => {
  it('puts every row on one grid, so the bands add up to the total at each time', () => {
    // A row with no point of the chosen type (an empty trend), one last, one missing a time.
    const rows = [
      row('a', [5, 6, 7]),
      { key: 'b', points: [grid([1, 2, 3])[0], grid([1, 2, 3])[2]] as Array<[EpochMs, number]> },
      { key: 'c', points: [] as Array<[EpochMs, number]> },
    ]
    const series = stackedRows(rows, NO_LABELS)
    expect(series.map((s) => s.points.map(([t]) => t))).toEqual([
      grid([0, 0, 0]).map(([t]) => t),
      grid([0, 0, 0]).map(([t]) => t),
      grid([0, 0, 0]).map(([t]) => t),
    ])
    expect(series.map((s) => s.points.map(([, v]) => v))).toEqual([
      [5, 6, 7],
      [1, 0, 3],
      [0, 0, 0],
    ])
  })

  it('folds the smallest beyond eight into Other, which carries their sum', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(`k${i}`, [10 - i, 20 - i]))
    const series = stackedRows(rows, NO_LABELS)
    expect(series.map((s) => s.key)).toEqual(['k0', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'Other'])
    expect(series.at(-1)?.points.map(([, v]) => v)).toEqual([3 + 2 + 1, 13 + 12 + 11])
  })

  it('does not repaint a row when a different one folds into Other', () => {
    // The same nine keys; first the earliest names are the smallest, then the latest.
    const keys = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']
    const smallFirst = stackedRows(
      keys.map((k, i) => row(k, [i + 1])),
      NO_LABELS,
    )
    const smallLast = stackedRows(
      keys.map((k, i) => row(k, [100 - i])),
      NO_LABELS,
    )
    const colorOf = (series: ReturnType<typeof stackedRows>, key: string) =>
      series.find((s) => s.key === key)?.color
    // c through g are shown both times.
    for (const key of ['c', 'd', 'e', 'f', 'g']) {
      expect(colorOf(smallLast, key)).toBe(colorOf(smallFirst, key))
    }
  })

  it("keeps each subscription's color from the page, and gives any other key a free one", () => {
    // Nine subscriptions: the ninth shares a slot on the page, which a chart of two would not.
    const known = accountColors(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'])
    const series = stackedRows(
      [row('a', [3]), row('i', [2]), row('api-backup', [1])],
      new Map([['api-backup', 'paid API']]),
      known,
    )
    expect(series.find((s) => s.key === 'a')?.color).toBe(known.get('a'))
    expect(series.find((s) => s.key === 'i')?.color).toBe(known.get('i'))
    const paid = series.find((s) => s.key === 'api-backup')
    expect(paid?.label).toBe('paid API')
    expect(paid?.color).toMatch(/^var\(--cmd-series-\d\)$/)
    expect(paid?.color).not.toBe(known.get('a'))
  })
})
