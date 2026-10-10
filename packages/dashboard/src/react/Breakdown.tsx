'use client'

import { useState } from 'react'
import {
  type Dimension,
  type EpochMs,
  formatCount,
  formatPercent,
  formatWhen,
  fromFirstBucket,
  type Series,
  type SeriesQuery,
  type TimeRange,
  TOKEN_LABELS,
  TOKEN_TYPES,
  type TokenChoice,
  type TokenType,
  tokenChoiceLabel,
  tokenCoverage,
  tokenRows,
} from '../core/index'
import { useCountedSeries, useSeries } from './hooks'
import { Sparkline, sharedPeak } from './Sparkline'

const SPLITS: Array<{
  dimension: Dimension
  label: string
  noun: string
  column: string
  /** claude-master counts tokens by this split; models have no token projection. */
  tokens: boolean
}> = [
  { dimension: 'client_account', label: 'People', noun: 'person', column: 'Person', tokens: true },
  { dimension: 'client', label: 'Machines', noun: 'machine', column: 'Machine', tokens: true },
  {
    dimension: 'profile',
    label: 'Subscriptions',
    noun: 'subscription',
    column: 'Subscription',
    tokens: true,
  },
  { dimension: 'model', label: 'Models', noun: 'model', column: 'Model', tokens: false },
]

function ShareCell(props: { share: number }) {
  return (
    <td>
      <span className="cmd-share-cell">
        <span className="cmd-share">
          <span style={{ width: `${props.share * 100}%` }} />
        </span>
        <span className="cmd-share-value">{formatPercent(props.share)}</span>
      </span>
    </td>
  )
}

/** Who and what used the pool in the range, one split at a time: tokens, or requests for models. */
export function Breakdown(props: {
  apiBase: string
  range: TimeRange
  stepSeconds: number
  /** The range in words, for the title ("last 24 hours"). */
  rangeWords: string
  /** Which token type the share and trend columns use. */
  tokenChoice: TokenChoice
  now: EpochMs
}) {
  const [split, setSplit] = useState(SPLITS[0] as (typeof SPLITS)[number])
  const base = { range: props.range, stepSeconds: props.stepSeconds, groupBy: split.dimension }
  const requests = useSeries(props.apiBase, { ...base, metric: 'requests' })
  // One query per token type, each split the same way; none for models.
  const tokenQuery = (tokenType: TokenType): SeriesQuery | null =>
    split.tokens ? { ...base, metric: 'tokens', tokenType } : null
  const input = useCountedSeries(props.apiBase, tokenQuery('input'))
  const output = useCountedSeries(props.apiBase, tokenQuery('output'))
  const cacheRead = useCountedSeries(props.apiBase, tokenQuery('cache_read'))
  const cacheWrite = useCountedSeries(props.apiBase, tokenQuery('cache_creation'))
  const byTypeLoaded = { input, output, cache_read: cacheRead, cache_creation: cacheWrite }

  const typesReady = TOKEN_TYPES.every((t) => byTypeLoaded[t].loaded.state === 'ready')
  const typeFailure = TOKEN_TYPES.map((t) => byTypeLoaded[t].loaded).find(
    (l) => l.state === 'error',
  )
  const starts = TOKEN_TYPES.map((t) => byTypeLoaded[t].firstAt).filter(
    (at): at is EpochMs => at !== null,
  )
  const firstAt = starts.length === 0 ? null : Math.min(...starts)
  const coverage = typesReady ? tokenCoverage(firstAt, props.range, props.stepSeconds) : null
  const showTokens = split.tokens && coverage !== null && coverage !== 'none'

  const tokenTable = showTokens
    ? tokenRows(
        Object.fromEntries(
          TOKEN_TYPES.map((t) => {
            const loaded = byTypeLoaded[t].loaded
            const series: Series[] = loaded.state === 'ready' ? loaded.data : []
            return [t, fromFirstBucket(series, firstAt, props.stepSeconds)]
          }),
        ) as Record<TokenType, Series[]>,
        props.tokenChoice,
      )
    : []
  const requestRows =
    requests.state === 'ready'
      ? requests.data
          .map((s) => ({ ...s, total: s.points.reduce((sum, [, v]) => sum + v, 0) }))
          .sort((a, b) => b.total - a.total)
      : []
  // A token query that failed shows its error, never a quiet switch to requests.
  const tokenError =
    split.tokens && typeFailure !== undefined && typeFailure.state === 'error'
      ? typeFailure.failure
      : null
  const tokensPending = split.tokens && !typesReady && tokenError === null
  const rows = showTokens ? tokenTable : tokensPending || tokenError !== null ? [] : requestRows
  const all = rows.reduce((sum, r) => sum + r.total, 0)
  // One scale for every row's trend (the tallest bar of any row), so a small series does not
  // look as busy as a large one and the busiest row's peak fills its height.
  const peak = sharedPeak(rows)

  const what = showTokens
    ? props.tokenChoice === 'all'
      ? 'Tokens'
      : `${tokenChoiceLabel(props.tokenChoice)} tokens`
    : 'Requests'
  const note = !split.tokens
    ? 'claude-master does not count tokens by model; this view counts requests.'
    : coverage === 'none'
      ? 'No token counts for this range yet; showing requests.'
      : coverage === 'partial' && firstAt !== null
        ? `Token counts start ${formatWhen(firstAt, props.now)}; nothing was counted before.`
        : null
  const loading = tokensPending || (!showTokens && requests.state === 'loading')
  const requestsFailure =
    !showTokens && tokenError === null && requests.state === 'error' ? requests.failure : null
  const failure = tokenError ?? requestsFailure

  return (
    <section className="cmd-panel cmd-panel-flush" aria-labelledby="cmd-breakdown-title">
      <div className="cmd-panel-head cmd-panel-pad">
        <h2 className="cmd-panel-title" id="cmd-breakdown-title">
          {what} by {split.noun}, {props.rangeWords}
        </h2>
      </div>
      <div className="cmd-panel-pad">
        <fieldset className="cmd-tabs">
          <legend className="cmd-visually-hidden">Split by</legend>
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
        {note !== null && <p className="cmd-note">{note}</p>}
      </div>
      {loading && <p className="cmd-empty cmd-panel-pad">Loading…</p>}
      {failure !== null && <p className="cmd-error cmd-panel-pad">{failure.message}</p>}
      {!loading && rows.length === 0 && failure === null && (
        <p className="cmd-empty cmd-panel-pad">Nothing in this range.</p>
      )}
      {rows.length > 0 && (
        <div className="cmd-table-wrap">
          <table className="cmd-table">
            <thead>
              <tr>
                <th scope="col">{split.column}</th>
                {showTokens ? (
                  TOKEN_TYPES.map((t) => (
                    <th scope="col" className="cmd-num" key={t}>
                      {TOKEN_LABELS[t]}
                    </th>
                  ))
                ) : (
                  <th scope="col" className="cmd-num">
                    Requests
                  </th>
                )}
                <th scope="col">Share</th>
                <th scope="col">Trend</th>
              </tr>
            </thead>
            <tbody>
              {showTokens
                ? tokenTable.map((r) => (
                    <tr key={r.key}>
                      <th scope="row" className="cmd-row-head">
                        {r.key}
                      </th>
                      {TOKEN_TYPES.map((t) => (
                        <td className="cmd-num" key={t}>
                          {formatCount(r.byType[t])}
                        </td>
                      ))}
                      <ShareCell share={all === 0 ? 0 : r.total / all} />
                      <td className="cmd-trend">
                        <Sparkline points={r.points} maxBar={peak} />
                      </td>
                    </tr>
                  ))
                : requestRows.map((r) => (
                    <tr key={r.key}>
                      <th scope="row" className="cmd-row-head">
                        {r.key}
                      </th>
                      <td className="cmd-num">{formatCount(r.total)}</td>
                      <ShareCell share={all === 0 ? 0 : r.total / all} />
                      <td className="cmd-trend">
                        <Sparkline points={r.points} maxBar={peak} />
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
