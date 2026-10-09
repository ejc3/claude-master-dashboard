'use client'

import type { EpochMs } from '../core/index'

/** A trend without axes, for a key number. The value it belongs to carries the meaning. */
export function Sparkline({ points }: { points: Array<[EpochMs, number]> }) {
  if (points.length < 2) return null
  const max = Math.max(...points.map(([, v]) => v), 1)
  const last = points.length - 1
  const line = points.map(([, v], i) => `${(i / last) * 100},${28 - (v / max) * 24 - 2}`).join(' ')
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
