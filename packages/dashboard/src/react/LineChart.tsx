'use client'

import { type KeyboardEvent, memo, type PointerEvent, useId, useRef, useState } from 'react'
import { type EpochMs, formatWhen } from '../core/index'
import { useWidth } from './hooks'

export interface ChartSeries {
  key: string
  label: string
  /** A CSS color, normally var(--cmd-series-N) chosen by seriesColors. */
  color: string
  points: Array<[EpochMs, number]>
}

interface Props {
  title: string
  series: ChartSeries[]
  format: (value: number) => string
  height?: number
  /** Clock for axis and tooltip labels. */
  now: EpochMs
}

const PAD = { top: 8, right: 8, bottom: 22, left: 44 }
const LABEL_GUTTER = 72

function niceMax(max: number): number {
  if (max <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(max))
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (step * magnitude >= max) return step * magnitude
  }
  return 10 * magnitude
}

/** Line chart with a crosshair tooltip (pointer, touch or arrow keys), legend and table view. */
export const LineChart = memo(function LineChart({
  title,
  series,
  format,
  height = 180,
  now,
}: Props) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [active, setActive] = useState<number | null>(null)
  const [showTable, setShowTable] = useState(false)
  const tableId = useId()
  const svgRef = useRef<SVGSVGElement>(null)

  const times = series[0]?.points.map(([t]) => t) ?? []
  const directLabels = series.length > 1 && series.length <= 4 && width >= 480
  const right = PAD.right + (directLabels ? LABEL_GUTTER : 0)
  const plotWidth = Math.max(0, width - PAD.left - right)
  const plotHeight = height - PAD.top - PAD.bottom
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.points.map(([, v]) => v))))
  const first = times[0] ?? 0
  const last = times[times.length - 1] ?? 1
  const x = (t: EpochMs) =>
    PAD.left + (last === first ? 0 : ((t - first) / (last - first)) * plotWidth)
  const y = (v: number) => PAD.top + plotHeight - (v / max) * plotHeight

  const pick = (clientX: number) => {
    const box = svgRef.current?.getBoundingClientRect()
    if (box === undefined || times.length === 0) return
    const t = first + ((clientX - box.left - PAD.left) / Math.max(1, plotWidth)) * (last - first)
    let best = 0
    for (let i = 1; i < times.length; i++) {
      if (Math.abs((times[i] ?? 0) - t) < Math.abs((times[best] ?? 0) - t)) best = i
    }
    setActive(best)
  }
  const onPointer = (event: PointerEvent<SVGRectElement>) => pick(event.clientX)
  const onKey = (event: KeyboardEvent<SVGRectElement>) => {
    if (times.length === 0) return
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const step = event.key === 'ArrowLeft' ? -1 : 1
      setActive((i) => Math.min(times.length - 1, Math.max(0, (i ?? times.length - 1) + step)))
    } else if (event.key === 'Escape') {
      setActive(null)
    }
  }

  const ticksY = [0, max / 2, max]
  const ticksX = timeTicks(first, last, width < 480 ? 3 : 6)

  // Direct labels at each line's end, nudged apart so they never overlap.
  const ends = directLabels
    ? series
        .map((s) => ({ s, y: y(s.points[s.points.length - 1]?.[1] ?? 0) }))
        .sort((a, b) => a.y - b.y)
        .map((e, i, all) => {
          const previous = all[i - 1]
          if (previous !== undefined && e.y - previous.y < 13) e.y = previous.y + 13
          return e
        })
    : []

  const activeTime = active === null ? null : (times[active] ?? null)
  const readIndex = active ?? times.length - 1
  const readTime = times[readIndex]
  const valueText =
    readTime === undefined
      ? 'No data'
      : `${formatWhen(readTime, now)}: ${series.map((s) => `${s.label} ${format(s.points[readIndex]?.[1] ?? 0)}`).join(', ')}`
  const tooltipLeft = activeTime === null ? 0 : x(activeTime)
  const flip = tooltipLeft > width / 2

  return (
    <figure className="cmd-panel" style={{ margin: 0 }}>
      <div className="cmd-panel-head">
        <figcaption className="cmd-panel-title">{title}</figcaption>
        <button
          type="button"
          className="cmd-toggle"
          aria-expanded={showTable}
          aria-controls={tableId}
          onClick={() => setShowTable((v) => !v)}
        >
          {showTable ? 'Show chart' : 'Show table'}
        </button>
      </div>
      {series.length > 1 && (
        <ul className="cmd-legend">
          {series.map((s) => (
            <li key={s.key}>
              <span className="cmd-swatch" style={{ color: s.color }} />
              {s.label}
            </li>
          ))}
        </ul>
      )}
      {showTable ? (
        <div className="cmd-table-wrap" id={tableId} style={{ maxHeight: 320 }}>
          <table className="cmd-table">
            <thead>
              <tr>
                <th scope="col">Time</th>
                {series.map((s) => (
                  <th scope="col" className="cmd-num" key={s.key}>
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {times
                .map((t, i) => ({ t, i }))
                .reverse()
                .map(({ t, i }) => (
                  <tr key={t}>
                    <td>{formatWhen(t, now)}</td>
                    {series.map((s) => (
                      <td className="cmd-num" key={s.key}>
                        {format(s.points[i]?.[1] ?? 0)}
                      </td>
                    ))}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="cmd-chart" ref={ref}>
          {width > 0 && (
            <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} height={height} aria-hidden="true">
              {ticksY.map((v) => (
                <g key={v}>
                  <line
                    className="cmd-grid"
                    x1={PAD.left}
                    x2={PAD.left + plotWidth}
                    y1={y(v)}
                    y2={y(v)}
                  />
                  <text className="cmd-axis" x={PAD.left - 6} y={y(v) + 4} textAnchor="end">
                    {format(v)}
                  </text>
                </g>
              ))}
              {ticksX.map((t) => (
                <text
                  key={t}
                  className="cmd-axis"
                  x={x(t)}
                  y={height - 4}
                  textAnchor={
                    x(t) - PAD.left < 30
                      ? 'start'
                      : PAD.left + plotWidth - x(t) < 30
                        ? 'end'
                        : 'middle'
                  }
                >
                  {formatWhen(t, now)}
                </text>
              ))}
              {series.map((s) => (
                <polyline
                  key={s.key}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  points={s.points.map(([t, v]) => `${x(t)},${y(v)}`).join(' ')}
                />
              ))}
              {ends.map(({ s, y: labelY }) => (
                <text
                  key={s.key}
                  x={PAD.left + plotWidth + 6}
                  y={labelY + 4}
                  style={{ fontSize: 12, fill: 'var(--cmd-ink-2)' }}
                >
                  {s.label}
                </text>
              ))}
              {activeTime !== null && (
                <g>
                  <line
                    x1={x(activeTime)}
                    x2={x(activeTime)}
                    y1={PAD.top}
                    y2={PAD.top + plotHeight}
                    stroke="var(--cmd-ink-3)"
                    strokeWidth={1}
                  />
                  {series.map((s) => {
                    const v = s.points[active ?? 0]?.[1]
                    return v === undefined ? null : (
                      <circle
                        key={s.key}
                        cx={x(activeTime)}
                        cy={y(v)}
                        r={4}
                        fill={s.color}
                        stroke="var(--cmd-surface)"
                        strokeWidth={2}
                      />
                    )
                  })}
                </g>
              )}
              <rect
                x={PAD.left}
                y={PAD.top}
                width={plotWidth}
                height={plotHeight}
                fill="transparent"
                tabIndex={0}
                role="slider"
                aria-label={`${title}: arrow keys move through time`}
                aria-valuemin={0}
                aria-valuemax={Math.max(0, times.length - 1)}
                aria-valuenow={active ?? Math.max(0, times.length - 1)}
                aria-valuetext={valueText}
                onPointerMove={onPointer}
                onPointerDown={onPointer}
                onPointerLeave={() => setActive(null)}
                onKeyDown={onKey}
                onBlur={() => setActive(null)}
              />
            </svg>
          )}
          {activeTime !== null && (
            <div
              className="cmd-tooltip"
              role="status"
              style={flip ? { right: width - tooltipLeft + 10 } : { left: tooltipLeft + 10 }}
            >
              <div className="cmd-tooltip-time">{formatWhen(activeTime, now)}</div>
              {series.map((s) => (
                <div className="cmd-tooltip-row" key={s.key}>
                  <span className="cmd-swatch" style={{ color: s.color }} />
                  {s.label}
                  <b>{format(s.points[active ?? 0]?.[1] ?? 0)}</b>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </figure>
  )
})

const TICK_STEPS = [1, 2, 3, 6, 12, 24, 48].map((h) => h * 60 * 60 * 1000)

/** Ticks on round local hours (every 1, 2, 3, 6, 12 or 24 hours), at most `most` of them. */
export function timeTicks(first: EpochMs, last: EpochMs, most: number): EpochMs[] {
  if (last <= first) return []
  const step = TICK_STEPS.find((s) => (last - first) / s <= most) ?? (TICK_STEPS.at(-1) as number)
  // Align to the viewer's local hour boundaries, so 6-hour ticks fall on 00:00, 06:00, ...
  const offset = new Date(first).getTimezoneOffset() * 60_000
  const ticks: EpochMs[] = []
  for (let t = Math.ceil((first - offset) / step) * step + offset; t <= last; t += step)
    ticks.push(t)
  return ticks
}

/** A fixed color per entity, by its name, so a filter never repaints the series that remain. */
export function seriesColors(keys: string[]): Map<string, string> {
  const sorted = [...new Set(keys)].sort()
  return new Map(sorted.map((key, i) => [key, `var(--cmd-series-${(i % 8) + 1})`]))
}

/** At most `limit` series; the smallest of the rest fold into one "Other" line. */
export function foldSeries<T extends { key: string; points: Array<[EpochMs, number]> }>(
  series: T[],
  limit = 8,
): Array<{ key: string; points: Array<[EpochMs, number]> }> {
  if (series.length <= limit) return series
  const total = (s: T) => s.points.reduce((sum, [, v]) => sum + v, 0)
  const ranked = [...series].sort((a, b) => total(b) - total(a))
  const kept = ranked.slice(0, limit - 1)
  const rest = ranked.slice(limit - 1)
  const points = (rest[0]?.points ?? []).map(([t], i): [EpochMs, number] => [
    t,
    rest.reduce((sum, s) => sum + (s.points[i]?.[1] ?? 0), 0),
  ])
  return [...kept, { key: 'Other', points }]
}
