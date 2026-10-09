import type { EpochMs, Series, SeriesQuery } from './types'

/**
 * Puts every series on the query's full step grid, oldest first, with 0 for a bucket the source
 * left out. CloudWatch omits empty buckets; anything that adds series together, compares them
 * point by point or sums "the last hour" must work on filled series.
 */
export function fillSeries(series: Series[], query: SeriesQuery): Series[] {
  const stepMs = query.stepSeconds * 1000
  const grid: EpochMs[] = []
  for (
    let at = Math.ceil(query.range.start / stepMs) * stepMs;
    at < query.range.end;
    at += stepMs
  ) {
    grid.push(at)
  }
  return series.map(({ key, points }) => {
    const byTime = new Map<EpochMs, number>()
    for (const [t, v] of points) {
      if (Number.isFinite(v)) byTime.set(t, (byTime.get(t) ?? 0) + v)
    }
    return { key, points: grid.map((t): [EpochMs, number] => [t, byTime.get(t) ?? 0]) }
  })
}

/** Point-by-point sum of series already on one grid (see fillSeries). */
export function sumSeries(series: Series[]): Array<[EpochMs, number]> {
  const first = series[0]
  if (first === undefined) return []
  return first.points.map(([t], i) => [
    t,
    series.reduce((sum, s) => sum + (s.points[i]?.[1] ?? 0), 0),
  ])
}

/** The sum of the points whose bucket starts in [from, to). */
export function sumBetween(points: Array<[EpochMs, number]>, from: EpochMs, to: EpochMs): number {
  let sum = 0
  for (const [t, v] of points) if (t >= from && t < to) sum += v
  return sum
}
