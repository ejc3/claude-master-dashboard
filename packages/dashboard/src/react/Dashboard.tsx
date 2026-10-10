'use client'

import { useMemo, useState } from 'react'
import {
  burnRate,
  type EpochMs,
  formatCount,
  formatCountdown,
  formatPercent,
  fromFirstBucket,
  HOUR_MS,
  hasHeadroom,
  nextAvailable,
  poolForecast,
  poolGaps,
  type Series,
  type SeriesQuery,
  type Snapshot,
  sumBetween,
  sumSeries,
  TOKEN_CHOICES,
  TOKEN_LABELS,
  TOKEN_TYPES,
  type TokenChoice,
  tokenChoiceLabel,
  tokenCoverage,
  tokensBetween,
  WEEKLY_SMOOTHING_MS,
} from '../core'
import { useSharedAnswers } from './answers'
import { Breakdown } from './Breakdown'
import {
  type FirstPaint,
  FirstPaintContext,
  type Loaded,
  useCountedSeries,
  useLastReady,
  useNow,
  useReadings,
  useReportTimeZone,
  useSeries,
  useSnapshot,
} from './hooks'
import { type ChartSeries, foldSeries, LineChart, seriesColors } from './LineChart'
import { PoolOutlook } from './Pool'
import type { PollFailure } from './poller'
import {
  chartQuery,
  FIRST_RANGE,
  type FirstSeries,
  kpiHourEnd,
  kpiQuery,
  kpiTokensQuery,
  RANGES,
  type RangeName,
  readingsQuery,
} from './queries'
import { RunwayCard } from './Runway'

export interface DashboardProps {
  /** The snapshot rendered on the server, or null when the source did not answer then. */
  initialSnapshot: Snapshot | null
  /** Where the dashboard's route handler is mounted, e.g. "/api/claude-master". */
  apiBase: string
  /** Where a viewer whose session ended signs in again; omitted, no link is shown. */
  signInHref?: string
  title?: string
  /** True when the source is the demo fixture: a label says so, so made-up numbers never pass for real ones. */
  demoData?: boolean
  /**
   * When the server rendered the page. The first render in the browser uses this clock, so it
   * asks for the same ranges and shows the same countdowns as the server's.
   */
  renderedAt?: EpochMs
  /** The server's answers to the first queries (firstQueries), by queryKey. */
  firstSeries?: FirstSeries
  /** The viewer's time zone as the browser last reported it, or null when not yet known. */
  timeZone?: string | null
}

/** Sums points into whole hours. */
function hourly(points: Array<[EpochMs, number]>): Array<[EpochMs, number]> {
  const out = new Map<EpochMs, number>()
  for (const [t, v] of points) {
    const hour = Math.floor(t / HOUR_MS) * HOUR_MS
    out.set(hour, (out.get(hour) ?? 0) + v)
  }
  return [...out.entries()]
}

const data = <T,>(loaded: Loaded<T>): T | null => (loaded.state === 'ready' ? loaded.data : null)
const failureOf = <T,>(loaded: Loaded<T>): PollFailure | null =>
  loaded.state === 'error' ? loaded.failure : loaded.state === 'ready' ? loaded.failure : null

function Kpi(props: { label: string; value: string; note?: string | undefined }) {
  return (
    <div className="cmd-kpi">
      <p className="cmd-kpi-label">{props.label}</p>
      <p className="cmd-kpi-value">{props.value}</p>
      {props.note !== undefined && <p className="cmd-kpi-note">{props.note}</p>}
    </div>
  )
}

export function Dashboard(props: DashboardProps) {
  const { firstSeries = {}, timeZone = null } = props
  const firstPaint = useMemo<FirstPaint>(
    () => ({ series: firstSeries, timeZone }),
    [firstSeries, timeZone],
  )
  return (
    <FirstPaintContext.Provider value={firstPaint}>
      <DashboardBody {...props} />
    </FirstPaintContext.Provider>
  )
}

function DashboardBody(props: DashboardProps) {
  const { initialSnapshot, apiBase, signInHref, title = 'claude-master', demoData = false } = props
  useReportTimeZone()
  const now = useNow(1000, props.renderedAt ?? initialSnapshot?.asOf ?? 0)
  const snapshotLoaded = useSnapshot(apiBase, initialSnapshot)
  const snapshot = data(snapshotLoaded) ?? initialSnapshot
  const [rangeName, setRangeName] = useState<RangeName>(FIRST_RANGE)
  const [tokenChoice, setTokenChoice] = useState<TokenChoice>('all')
  const chosen = RANGES[rangeName]
  const tokenType = tokenChoice === 'all' ? {} : { tokenType: tokenChoice }

  // The request URLs change once per step, not every second (useSeries keys on the URL).
  const inRange = (q: Omit<SeriesQuery, 'range' | 'stepSeconds'>): SeriesQuery =>
    chartQuery(now, rangeName, q)
  const range = inRange({ metric: 'requests' }).range
  const byProfile = useSeries(apiBase, inRange({ metric: 'requests', groupBy: 'profile' }))
  // Tokens are what matters; requests are the fallback for a range with no token counts yet
  // (before the release that counts them).
  const tokensByProfile = useCountedSeries(
    apiBase,
    inRange({ metric: 'tokens', groupBy: 'profile', ...tokenType }),
  )
  const tokenRangeCoverage =
    tokensByProfile.loaded.state === 'ready'
      ? tokenCoverage(tokensByProfile.firstAt, range, chosen.stepSeconds)
      : null
  const errors = useSeries(apiBase, inRange({ metric: 'errors' }))
  // The paid backup's key number is always the last day's: its controls are further down.
  const backup = useSeries(apiBase, chartQuery(now, '24h', { metric: 'backupRequests' }))

  // Key numbers have their own five-minute queries, whatever the range (kpiRange).
  const kpiRequests = useSeries(apiBase, kpiQuery(now, 'requests'))
  const kpiErrors = useSeries(apiBase, kpiQuery(now, 'errors'))
  const kpiTokens = useCountedSeries(apiBase, kpiTokensQuery(now))
  // Each answer's hours come from the range it answers: while a moved range loads, the last
  // answer stays on show, and its last full hour ends where it did when it arrived.
  const hourEndOf = (loaded: Loaded<unknown>) =>
    loaded.state === 'ready' && loaded.range !== undefined ? kpiHourEnd(loaded.range) : null
  const requestsEnd = hourEndOf(kpiRequests)
  const tokensEnd = hourEndOf(kpiTokens.loaded)
  const kpiTokensData = data(kpiTokens.loaded)
  const tokensLastHour =
    kpiTokensData === null || kpiTokens.firstAt === null || tokensEnd === null
      ? null
      : tokensBetween(kpiTokensData, tokensEnd - HOUR_MS, tokensEnd)
  const tokensLastHourTotal =
    tokensLastHour === null ? null : TOKEN_TYPES.reduce((sum, t) => sum + tokensLastHour[t], 0)
  const total = (series: Series[] | null) => (series === null ? null : sumSeries(series))
  const kpiRequestsTotal = total(data(kpiRequests))
  const lastHour = (points: Array<[EpochMs, number]> | null, end: EpochMs | null, back = 0) =>
    points === null || end === null
      ? null
      : sumBetween(points, end - (back + 1) * HOUR_MS, end - back * HOUR_MS)
  const requestsLastHour = lastHour(kpiRequestsTotal, requestsEnd)
  const requestsHourBefore = lastHour(kpiRequestsTotal, requestsEnd, 1)
  // The error rate needs one hour both answers cover.
  const kpiRate = useSharedAnswers({ requests: kpiRequests, errors: kpiErrors })
  const rateEnd = kpiRate === null ? null : kpiHourEnd(kpiRate.range)
  const errorsLastHour = lastHour(total(kpiRate?.data.errors ?? null), rateEnd)
  const requestsForRate = lastHour(total(kpiRate?.data.requests ?? null), rateEnd)

  const byProfileData = data(byProfile)
  const tokensByProfileData = data(tokensByProfile.loaded)
  const showTokens = tokenRangeCoverage !== null && tokenRangeCoverage !== 'none'
  const chartData = showTokens
    ? fromFirstBucket(tokensByProfileData ?? [], tokensByProfile.firstAt, chosen.stepSeconds)
    : byProfileData
  const knownKey = (snapshot?.profiles ?? []).map((p) => p.profile).join('\n')
  const knownProfiles = useMemo(() => knownKey.split('\n').filter((n) => n !== ''), [knownKey])

  const profileLines: ChartSeries[] = useMemo(() => {
    if (chartData === null) return []
    const folded = foldSeries(chartData)
    // Colors come from every known subscription, so one missing from this range shifts none.
    const colors = seriesColors(
      [...knownProfiles, ...folded.map((s) => s.key)],
      folded.map((s) => s.key),
    )
    return folded.map((s) => ({
      ...s,
      label: s.key,
      color: colors.get(s.key) ?? 'var(--cmd-ink-3)',
    }))
  }, [chartData, knownProfiles])

  // Per hour, not per step: a few requests at night make a five-minute error rate swing wildly.
  // Unknown when either side is unknown: a failed errors query is not a 0% error rate. Only the
  // hours both answers cover.
  const rateAnswers = useSharedAnswers({ requests: byProfile, errors })
  const errorRate: ChartSeries[] = useMemo(() => {
    if (rateAnswers === null) return []
    const requestsHourly = hourly(sumSeries(rateAnswers.data.requests))
    const errorsHourly = new Map(hourly(sumSeries(rateAnswers.data.errors)))
    const points = requestsHourly.map(([t, r]): [EpochMs, number] => [
      t,
      r === 0 ? 0 : (errorsHourly.get(t) ?? 0) / r,
    ])
    return [{ key: 'error-rate', label: 'Error rate', color: 'var(--cmd-series-1)', points }]
  }, [rateAnswers])

  // The weekly burn rate is smoothed over the last day of used-share readings; the 5-hour one is
  // each window's average so far (no history of it is exported yet).
  const usedQuery = readingsQuery(now)
  const smoothingRange = usedQuery.range
  const usedReadings = useReadings(apiBase, usedQuery)
  // The last readings stay in use while the next range loads: the range moves every 10 minutes.
  const usedData = useLastReady(usedReadings)
  const smoothed = useMemo(() => {
    const rates = new Map<string, number | null>()
    for (const s of usedData ?? []) {
      rates.set(s.key, burnRate(s.points, smoothingRange.end, WEEKLY_SMOOTHING_MS))
    }
    return rates
  }, [usedData, smoothingRange.end])
  const profilesNow = snapshot?.profiles ?? null
  const forecasts =
    profilesNow === null
      ? null
      : [
          // From the readings' own time: usage is as of asOf, not as of this second.
          poolForecast(profilesNow, 'weekly', snapshot?.asOf ?? now, smoothed, now),
          poolForecast(profilesNow, 'fiveHour', snapshot?.asOf ?? now, new Map(), now),
        ]
  // When no subscription can take work, from both windows at once: the headline.
  const gaps =
    profilesNow === null ? null : poolGaps(profilesNow, snapshot?.asOf ?? now, smoothed, now)
  const ready = (profilesNow ?? []).filter((p) => hasHeadroom(p, now)).length
  const next = profilesNow === null || ready > 0 ? null : nextAvailable(profilesNow, now)
  const outlookDetail =
    profilesNow === null
      ? 'The metrics source has not answered yet; this page retries every minute'
      : profilesNow.length === 0
        ? 'Readings arrive a few minutes after claude-master starts exporting metrics'
        : `${ready} of ${profilesNow.length} subscriptions can take work now${
            next === null ? '' : `; ${next.profile} again in ${formatCountdown(next.at - now)}`
          }`

  const failures = [
    failureOf(snapshotLoaded),
    failureOf(byProfile),
    failureOf(errors),
    failureOf(backup),
    failureOf(kpiRequests),
    failureOf(kpiErrors),
    failureOf(tokensByProfile.loaded),
    failureOf(kpiTokens.loaded),
    failureOf(usedReadings),
  ].filter((f): f is PollFailure => f !== null)
  const signedOut = failures.some((f) => f.status === 401)
  const snapshotFailure = failureOf(snapshotLoaded)

  const ageMs = snapshot === null ? null : now - snapshot.asOf
  const stale = ageMs !== null && ageMs > 10 * 60_000
  const freshness =
    ageMs === null
      ? 'No reading yet'
      : stale
        ? `No reading for ${formatCountdown(ageMs)}`
        : ageMs < 60_000
          ? 'Updated just now'
          : `Updated ${formatCountdown(ageMs)} ago`
  const backupTotal = data(backup)
  const rangeWords = rangeName === '24h' ? 'last 24 hours' : 'last 7 days'

  const tokenControl = (
    <fieldset className="cmd-segmented">
      <legend className="cmd-visually-hidden">Token type for the chart and table</legend>
      {TOKEN_CHOICES.map((choice) => (
        <button
          type="button"
          key={choice}
          aria-pressed={choice === tokenChoice}
          onClick={() => setTokenChoice(choice)}
        >
          {choice === 'all' ? 'All' : TOKEN_LABELS[choice]}
        </button>
      ))}
    </fieldset>
  )
  const chartNote =
    tokenRangeCoverage === 'none' ? 'No token counts for this range yet; showing requests.' : null
  const chartTitle = showTokens
    ? `${tokenChoice === 'all' ? 'Tokens' : `${tokenChoiceLabel(tokenChoice)} tokens`} ${chosen.per}, by subscription`
    : `Requests ${chosen.per}, by subscription`

  const rangeControl = (
    <fieldset className="cmd-segmented">
      <legend className="cmd-visually-hidden">Time range for the charts and table</legend>
      {(Object.keys(RANGES) as RangeName[]).map((name) => (
        <button
          type="button"
          key={name}
          aria-pressed={name === rangeName}
          onClick={() => setRangeName(name)}
        >
          {RANGES[name].label}
        </button>
      ))}
    </fieldset>
  )

  return (
    <div className="cmd-root">
      <div className="cmd-frame">
        <header className="cmd-header">
          <div className="cmd-header-text">
            <h1 className="cmd-title">
              {title}
              {demoData && (
                <span className="cmd-demo" role="status" title="A fixture, not CloudWatch">
                  Demo data
                </span>
              )}
            </h1>
            <span className="cmd-freshness" data-stale={stale || snapshotFailure !== null}>
              <span className="cmd-pulse" aria-hidden="true" />
              {freshness}
              {snapshotFailure !== null && !signedOut ? '; the last refresh failed' : ''}
            </span>
          </div>
        </header>

        {signedOut && (
          <p className="cmd-banner" role="alert">
            Your session has ended.{' '}
            {signInHref !== undefined && <a href={signInHref}>Sign in again</a>}
          </p>
        )}

        <PoolOutlook
          forecasts={forecasts}
          gaps={gaps}
          profiles={profilesNow}
          now={now}
          detail={outlookDetail}
        />

        <section className="cmd-kpis" aria-label="Traffic">
          {tokensLastHour === null || tokensLastHourTotal === null ? (
            <Kpi
              label="Requests, last hour"
              value={formatCount(requestsLastHour)}
              note={
                kpiTokens.loaded.state === 'ready'
                  ? 'No token counts yet'
                  : requestsHourBefore === null
                    ? undefined
                    : `${formatCount(requestsHourBefore)} the hour before`
              }
            />
          ) : (
            <Kpi
              label="Tokens, last hour"
              value={formatCount(tokensLastHourTotal)}
              note={TOKEN_TYPES.map(
                (t) => `${formatCount(tokensLastHour[t])} ${TOKEN_LABELS[t].toLowerCase()}`,
              ).join(' · ')}
            />
          )}
          <Kpi
            label="Error rate, last hour"
            value={formatPercent(
              requestsForRate === null || errorsLastHour === null || requestsForRate === 0
                ? null
                : errorsLastHour / requestsForRate,
            )}
            note={
              errorsLastHour === null
                ? failureOf(kpiErrors) === null
                  ? undefined
                  : 'Error counts are unavailable'
                : `${formatCount(errorsLastHour)} errors from Anthropic`
            }
          />
          <Kpi
            label="Conversations now"
            value={formatCount(snapshot?.sessions ?? null)}
            note={
              snapshot?.activeConnections == null
                ? undefined
                : `${formatCount(snapshot.activeConnections)} open connections`
            }
          />
          <Kpi
            label="Paid API backup, last 24 hours"
            value={formatCount(
              backupTotal === null ? null : sumBetween(sumSeries(backupTotal), 0, Infinity),
            )}
            note="Requests no subscription could take"
          />
        </section>

        <section className="cmd-panel cmd-stream" aria-labelledby="cmd-subscriptions">
          <div className="cmd-panel-header cmd-stream-columns">
            <h2 className="cmd-panel-label" id="cmd-subscriptions">
              Subscriptions
            </h2>
            <span className="cmd-panel-label cmd-wide-only" aria-hidden="true">
              Weekly allowance
            </span>
            <span className="cmd-panel-label cmd-wide-only" aria-hidden="true">
              5-hour window
            </span>
          </div>
          {(snapshot?.profiles ?? []).map((p) => (
            <RunwayCard key={p.profile} status={p} now={now} />
          ))}
        </section>

        {/* Above what they change: the charts and the table below. */}
        <div className="cmd-controls cmd-toolbar">
          {tokenControl}
          {rangeControl}
        </div>

        <div className="cmd-charts">
          <div>
            {(showTokens ? tokensByProfile.loaded : byProfile).state === 'error' && (
              <p className="cmd-error">
                {
                  (failureOf(showTokens ? tokensByProfile.loaded : byProfile) as PollFailure)
                    .message
                }
              </p>
            )}
            {(tokensByProfile.loaded.state === 'loading' ||
              (!showTokens && byProfile.state === 'loading')) && (
              <p className="cmd-empty">Loading…</p>
            )}
            {chartNote !== null && <p className="cmd-note">{chartNote}</p>}
            {profileLines.length > 0 && (
              <LineChart
                title={chartTitle}
                series={profileLines}
                format={formatCount}
                integer
                now={now}
              />
            )}
          </div>
          <div>
            {errors.state === 'error' && <p className="cmd-error">{errors.failure.message}</p>}
            {errorRate.length > 0 && (
              <LineChart
                title="Error rate per hour"
                series={errorRate}
                format={(v) => formatPercent(v)}
                now={now}
                area
              />
            )}
          </div>
        </div>

        <Breakdown
          apiBase={apiBase}
          range={range}
          stepSeconds={chosen.stepSeconds}
          rangeWords={rangeWords}
          tokenChoice={tokenChoice}
          now={now}
        />
      </div>
    </div>
  )
}
