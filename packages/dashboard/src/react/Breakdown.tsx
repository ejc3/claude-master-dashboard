'use client'

import { useState } from 'react'
import {
  type Dimension,
  formatCount,
  formatPercent,
  type SeriesQuery,
  type TimeRange,
} from '../core/index'
import { useSeries } from './hooks'
import { Sparkline } from './Sparkline'

const SPLITS: Array<{ dimension: Dimension; label: string; noun: string; column: string }> = [
  { dimension: 'client_account', label: 'People', noun: 'person', column: 'Person' },
  { dimension: 'client', label: 'Machines', noun: 'machine', column: 'Machine' },
  { dimension: 'profile', label: 'Subscriptions', noun: 'subscription', column: 'Subscription' },
  { dimension: 'model', label: 'Models', noun: 'model', column: 'Model' },
]

/** Who and what the requests in the range came from, one split at a time. */
export function Breakdown(props: { apiBase: string; range: TimeRange; stepSeconds: number }) {
  const [split, setSplit] = useState(SPLITS[0] as (typeof SPLITS)[number])
  const query: SeriesQuery = {
    metric: 'requests',
    groupBy: split.dimension,
    range: props.range,
    stepSeconds: props.stepSeconds,
  }
  const loaded = useSeries(props.apiBase, query)
  const rows =
    loaded.state === 'ready'
      ? loaded.data
          .map((s) => ({ ...s, total: s.points.reduce((sum, [, v]) => sum + v, 0) }))
          .sort((a, b) => b.total - a.total)
      : []
  const all = rows.reduce((sum, r) => sum + r.total, 0)

  return (
    <section className="cmd-panel" aria-labelledby="cmd-breakdown-title">
      <div className="cmd-panel-head">
        <h2 className="cmd-panel-title" id="cmd-breakdown-title">
          Requests by {split.noun}
        </h2>
        <fieldset className="cmd-segmented">
          <legend className="cmd-visually-hidden">Split requests by</legend>
          {SPLITS.map((s) => (
            <button
              type="button"
              key={s.dimension}
              aria-pressed={s.dimension === split.dimension}
              onClick={() => setSplit(s)}
            >
              {s.label}
            </button>
          ))}
        </fieldset>
      </div>
      {loaded.state === 'loading' && <p className="cmd-empty">Loading…</p>}
      {loaded.state === 'error' && <p className="cmd-error">{loaded.message}</p>}
      {loaded.state === 'ready' && rows.length === 0 && (
        <p className="cmd-empty">No requests in this range.</p>
      )}
      {rows.length > 0 && (
        <div className="cmd-table-wrap">
          <table className="cmd-table">
            <thead>
              <tr>
                <th scope="col">{split.column}</th>
                <th scope="col" className="cmd-num">
                  Requests
                </th>
                <th scope="col">Share</th>
                <th scope="col">Trend</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const share = all === 0 ? 0 : r.total / all
                return (
                  <tr key={r.key}>
                    <th scope="row" style={{ fontWeight: 500, color: 'inherit' }}>
                      {r.key}
                    </th>
                    <td className="cmd-num">{formatCount(r.total)}</td>
                    <td>
                      <span className="cmd-share" title={formatPercent(share)}>
                        <span style={{ width: `${share * 100}%` }} />
                      </span>
                      <span className="cmd-visually-hidden">{formatPercent(share)}</span>
                    </td>
                    <td style={{ width: 96 }}>
                      <Sparkline points={r.points} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
