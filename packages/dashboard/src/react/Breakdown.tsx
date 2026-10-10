'use client'

import { useState } from 'react'
import {
  type EpochMs,
  formatCount,
  formatPercent,
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
import { useSharedAnswers } from './answers'
import { useCountedSeries, useSeries, useWhen } from './hooks'
import { breakdownQueries, SPLITS } from './queries'
import { Sparkline, sharedPeak } from './Sparkline'

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

/**
 * The range the table's title names: the chosen one, or "since 02:15" when the token counts start
 * partway through it, so the totals are not read as covering the whole range.
 */
export function tableRangeWords(
  coverage: 'none' | 'partial' | 'full' | null,
  firstAt: EpochMs | null,
  rangeWords: string,
  clock: ((at: EpochMs) => string) | null,
): string {
  if (coverage !== 'partial' || firstAt === null) return rangeWords
  return `since ${clock === null ? 'token counting began' : clock(firstAt)}`
}

/** One row per key with any requests in the range, most first. */
export function requestTable(series: Series[]): Array<Series & { total: number }> {
  return series
    .map((s) => ({ ...s, total: s.points.reduce((sum, [, v]) => sum + v, 0) }))
    .filter((s) => s.total > 0)
    .sort((a, b) => b.total - a.total)
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
  const when = useWhen()
  const [split, setSplit] = useState(SPLITS[0] as (typeof SPLITS)[number])
  const queries = breakdownQueries(props.range, props.stepSeconds, split)
  const requests = useSeries(props.apiBase, queries.requests)
  // One query per token type, each split the same way; none for models.
  const tokenQuery = (tokenType: TokenType): SeriesQuery | null =>
    queries.tokens?.[tokenType] ?? null
  const input = useCountedSeries(props.apiBase, tokenQuery('input'))
  const output = useCountedSeries(props.apiBase, tokenQuery('output'))
  const cacheRead = useCountedSeries(props.apiBase, tokenQuery('cache_read'))
  const cacheWrite = useCountedSeries(props.apiBase, tokenQuery('cache_creation'))
  const byTypeLoaded = { input, output, cache_read: cacheRead, cache_creation: cacheWrite }
  // The rows add the types together: only the range all four answers cover.
  const byType = useSharedAnswers({
    input: input.loaded,
    output: output.loaded,
    cache_read: cacheRead.loaded,
    cache_creation: cacheWrite.loaded,
  })

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
            const series: Series[] = byType?.data[t] ?? []
            return [t, fromFirstBucket(series, firstAt, props.stepSeconds)]
          }),
        ) as Record<TokenType, Series[]>,
        props.tokenChoice,
      )
    : []
  const requestRows = requests.state === 'ready' ? requestTable(requests.data) : []
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
      ? split.requests
        ? 'No token counts for this range yet; showing requests.'
        : `No token counts by ${split.noun} yet: claude-master releases that count them send them.`
      : null
  const loading = tokensPending || (!showTokens && split.requests && requests.state === 'loading')
  const requestsFailure =
    !showTokens && tokenError === null && requests.state === 'error' ? requests.failure : null
  const failure = tokenError ?? requestsFailure

  return (
    <section className="cmd-panel cmd-panel-flush" aria-labelledby="cmd-breakdown-title">
      <div className="cmd-panel-head cmd-panel-pad">
        <h2 className="cmd-panel-title" id="cmd-breakdown-title">
          {what} by {split.noun},{' '}
          {tableRangeWords(
            showTokens ? coverage : null,
            firstAt,
            props.rangeWords,
            when === null ? null : (at) => when(at, props.now),
          )}
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
