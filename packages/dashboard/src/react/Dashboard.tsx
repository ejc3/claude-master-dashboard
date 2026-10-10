'use client'

import { useMemo, useState } from 'react'
import {
  burnRate,
  type EpochMs,
  formatCount,
  formatCountdown,
  formatPercent,
  HOUR_MS,
  hasHeadroom,
  nextAvailable,
  poolForecast,
  type SeriesQuery,
  type Snapshot,
  sumBetween,
  sumSeries,
  type TimeRange,
  WEEKLY_SMOOTHING_MS,
} from '../core'
import { Breakdown } from './Breakdown'
import { type Loaded, useLastReady, useNow, useReadings, useSeries, useSnapshot } from './hooks'
import { type ChartSeries, foldSeries, LineChart, seriesColors } from './LineChart'
import { PoolOutlook } from './Pool'
import type { PollFailure } from './poller'
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
}

type RangeName = '24h' | '7d'

const RANGES: Record<RangeName, { label: string; ms: number; stepSeconds: number; per: string }> = {
  '24h': { label: 'Last 24 hours', ms: 24 * HOUR_MS, stepSeconds: 300, per: 'per 5 minutes' },
  '7d': { label: 'Last 7 days', ms: 7 * 24 * HOUR_MS, stepSeconds: 3600, per: 'per hour' },
}

const KPI_STEP_SECONDS = 300
const STEP_MS = KPI_STEP_SECONDS * 1000

// Step-aligned, so every viewer and every refresh within a step asks for the same range.
function rangeEnding(now: EpochMs, ms: number, stepSeconds: number): TimeRange {
  const end = Math.floor(now / (stepSeconds * 1000)) * stepSeconds * 1000
  return { start: end - ms, end }
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
  const { initialSnapshot, apiBase, signInHref, title = 'claude-master', demoData = false } = props
  const now = useNow(1000, initialSnapshot?.asOf ?? 0)
  const snapshotLoaded = useSnapshot(apiBase, initialSnapshot)
  const snapshot = data(snapshotLoaded) ?? initialSnapshot
  const [rangeName, setRangeName] = useState<RangeName>('24h')
  const chosen = RANGES[rangeName]

  // The request URLs change once per step, not every second (useSeries keys on the URL).
  const range = rangeEnding(now, chosen.ms, chosen.stepSeconds)
  const inRange = (q: Omit<SeriesQuery, 'range' | 'stepSeconds'>): SeriesQuery => ({
    ...q,
    range,
    stepSeconds: chosen.stepSeconds,
  })
  const byProfile = useSeries(apiBase, inRange({ metric: 'requests', groupBy: 'profile' }))
  const errors = useSeries(apiBase, inRange({ metric: 'errors' }))
  const backup = useSeries(apiBase, inRange({ metric: 'backupRequests' }))

  // Key numbers have their own five-minute queries, whatever the range: the last full hour
  // ends one bucket ago, because the newest bucket is still filling (CloudWatch runs minutes
  // behind), and "the hour before" is the hour before that.
  const kpiRange = rangeEnding(now, 2 * HOUR_MS + STEP_MS, KPI_STEP_SECONDS)
  const kpiQuery = (metric: 'requests' | 'errors'): SeriesQuery => ({
    metric,
    range: kpiRange,
    stepSeconds: KPI_STEP_SECONDS,
  })
  const kpiRequests = useSeries(apiBase, kpiQuery('requests'))
  const kpiErrors = useSeries(apiBase, kpiQuery('errors'))
  const hourEnd = kpiRange.end - STEP_MS
  const kpiRequestsTotal = data(kpiRequests)
  const kpiErrorsTotal = data(kpiErrors)
  const requestsLastHour =
    kpiRequestsTotal === null
      ? null
      : sumBetween(sumSeries(kpiRequestsTotal), hourEnd - HOUR_MS, hourEnd)
  const requestsHourBefore =
    kpiRequestsTotal === null
      ? null
      : sumBetween(sumSeries(kpiRequestsTotal), hourEnd - 2 * HOUR_MS, hourEnd - HOUR_MS)
  const errorsLastHour =
    kpiErrorsTotal === null
      ? null
      : sumBetween(sumSeries(kpiErrorsTotal), hourEnd - HOUR_MS, hourEnd)

  const byProfileData = data(byProfile)
  const errorsData = data(errors)
  const knownKey = (snapshot?.profiles ?? []).map((p) => p.profile).join('\n')
  const knownProfiles = useMemo(() => knownKey.split('\n').filter((n) => n !== ''), [knownKey])

  const requestsTotal = useMemo(
    () => (byProfileData === null ? null : sumSeries(byProfileData)),
    [byProfileData],
  )
  const profileLines: ChartSeries[] = useMemo(() => {
    if (byProfileData === null) return []
    const folded = foldSeries(byProfileData)
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
  }, [byProfileData, knownProfiles])

  // Per hour, not per step: a few requests at night make a five-minute error rate swing wildly.
  // Unknown when either side is unknown: a failed errors query is not a 0% error rate.
  const errorRate: ChartSeries[] = useMemo(() => {
    if (requestsTotal === null || errorsData === null) return []
    const requestsHourly = hourly(requestsTotal)
    const errorsHourly = new Map(hourly(sumSeries(errorsData)))
    const points = requestsHourly.map(([t, r]): [EpochMs, number] => [
      t,
      r === 0 ? 0 : (errorsHourly.get(t) ?? 0) / r,
    ])
    return [{ key: 'error-rate', label: 'Error rate', color: 'var(--cmd-series-1)', points }]
  }, [requestsTotal, errorsData])

  // The weekly burn rate is smoothed over the last day of used-share readings; the 5-hour one is
  // each window's average so far (no history of it is exported yet).
  const smoothingRange = rangeEnding(now, WEEKLY_SMOOTHING_MS, 600)
  const usedReadings = useReadings(apiBase, {
    metric: 'weeklyUsed',
    groupBy: 'profile',
    range: smoothingRange,
    stepSeconds: 600,
  })
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
  const ready = (profilesNow ?? []).filter((p) => hasHeadroom(p, now)).length
  const next = profilesNow === null || ready > 0 ? null : nextAvailable(profilesNow, now)
  const outlookDetail =
    profilesNow === null
      ? 'The metrics source did not answer yet; this page retries every minute.'
      : profilesNow.length === 0
        ? 'Readings arrive a few minutes after claude-master starts exporting metrics.'
        : `${ready} of ${profilesNow.length} subscriptions can take work now${
            next === null ? '' : `; ${next.profile} again in ${formatCountdown(next.at - now)}`
          }.`

  const failures = [
    failureOf(snapshotLoaded),
    failureOf(byProfile),
    failureOf(errors),
    failureOf(backup),
    failureOf(kpiRequests),
    failureOf(kpiErrors),
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
          <div className="cmd-controls">{rangeControl}</div>
        </header>

        {signedOut && (
          <p className="cmd-banner" role="alert">
            Your session has ended.{' '}
            {signInHref !== undefined && <a href={signInHref}>Sign in again</a>}
          </p>
        )}

        <PoolOutlook forecasts={forecasts} now={now} detail={outlookDetail} />

        <section className="cmd-kpis" aria-label="Traffic">
          <Kpi
            label="Requests, last hour"
            value={formatCount(requestsLastHour)}
            note={
              requestsHourBefore === null
                ? undefined
                : `${formatCount(requestsHourBefore)} the hour before`
            }
          />
          <Kpi
            label="Error rate, last hour"
            value={formatPercent(
              requestsLastHour === null || errorsLastHour === null || requestsLastHour === 0
                ? null
                : errorsLastHour / requestsLastHour,
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
            label={`Paid API backup, ${rangeWords}`}
            value={formatCount(
              backupTotal === null ? null : sumBetween(sumSeries(backupTotal), 0, Infinity),
            )}
            note="Requests no subscription could take"
          />
        </section>

        <div className="cmd-charts">
          <div>
            {byProfile.state === 'error' && (
              <p className="cmd-error">{byProfile.failure.message}</p>
            )}
            {byProfile.state === 'loading' && <p className="cmd-empty">Loading…</p>}
            {profileLines.length > 0 && (
              <LineChart
                title={`Requests ${chosen.per}, by subscription`}
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

        <Breakdown
          apiBase={apiBase}
          range={range}
          stepSeconds={chosen.stepSeconds}
          rangeWords={rangeWords}
        />
      </div>
    </div>
  )
}
