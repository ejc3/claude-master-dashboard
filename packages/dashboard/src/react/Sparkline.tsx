'use client'

import type { EpochMs } from '../core'

const BARS = 24

/**
 * A trend without axes, as a row of small bars (each the sum of an equal share of the points).
 * `max` sets a shared scale for the bars, so rows in one table compare by height; by default the
 * tallest bar fills the height.
 */
export function Sparkline({ points, max }: { points: Array<[EpochMs, number]>; max?: number }) {
  if (points.length < 2) return null
  const count = Math.min(BARS, points.length)
  const bars = Array.from({ length: count }, (_, i) => {
    const from = Math.floor((i * points.length) / count)
    const to = Math.floor(((i + 1) * points.length) / count)
    return points.slice(from, to).reduce((sum, [, v]) => sum + v, 0)
  })
  // A shared scale is per point; a bar sums several points.
  const perBar = points.length / count
  const top = Math.max(max === undefined ? 0 : max * perBar, ...bars, 1)
  const width = 100 / count
  return (
    <svg className="cmd-spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
      {bars.map((v, i) => {
        const h = v <= 0 ? 0 : Math.max(1.5, (v / top) * 26)
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: bars are positional
          <rect key={i} x={i * width + 0.6} y={28 - h} width={width - 1.2} height={h} rx={0.6} />
        )
      })}
    </svg>
  )
}
