'use client'

import type { EpochMs } from '../core'

const BARS = 24
const HEIGHT = 26

/** The points summed into at most 24 bars of (nearly) equal numbers of points, oldest first. */
export function sparkBars(points: Array<[EpochMs, number]>): number[] {
  const count = Math.min(BARS, points.length)
  return Array.from({ length: count }, (_, i) => {
    const from = Math.floor((i * points.length) / count)
    const to = Math.floor(((i + 1) * points.length) / count)
    return points.slice(from, to).reduce((sum, [, v]) => sum + v, 0)
  })
}

/**
 * Bar heights out of 26: `maxBar` (the tallest bar of any row in a table, from sparkBars) sets a
 * shared scale, so rows compare by height; by default the tallest bar here fills the height. A
 * bar with anything in it stays visible.
 */
export function sparkHeights(bars: number[], maxBar?: number): number[] {
  const top = Math.max(maxBar ?? 0, ...bars, Number.MIN_VALUE)
  return bars.map((v) => (v <= 0 ? 0 : Math.max(1.5, (v / top) * HEIGHT)))
}

/** A trend without axes, as a row of small bars. */
export function Sparkline({
  points,
  maxBar,
}: {
  points: Array<[EpochMs, number]>
  maxBar?: number
}) {
  if (points.length < 2) return null
  const heights = sparkHeights(sparkBars(points), maxBar)
  const width = 100 / heights.length
  return (
    <svg className="cmd-spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
      {heights.map((h, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: bars are positional
        <rect key={i} x={i * width + 0.6} y={28 - h} width={width - 1.2} height={h} rx={0.6} />
      ))}
    </svg>
  )
}
