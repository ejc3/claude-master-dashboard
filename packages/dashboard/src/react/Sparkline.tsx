'use client'

import type { EpochMs } from '../core'

/**
 * A trend without axes. `max` sets a shared scale, so rows in one table compare by height; by
 * default the line fills its own height.
 */
export function Sparkline({ points, max }: { points: Array<[EpochMs, number]>; max?: number }) {
  if (points.length < 2) return null
  const top = Math.max(max ?? 0, ...points.map(([, v]) => v), 1)
  const last = points.length - 1
  const line = points.map(([, v], i) => `${(i / last) * 100},${28 - (v / top) * 24 - 2}`).join(' ')
  return (
    <svg className="cmd-spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
      <polyline
        points={line}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
      />
    </svg>
  )
}
