'use client'

import { useMemo, useState } from 'react'
import {
  type EpochMs,
  formatCount,
  formatCountdown,
  formatPercent,
  formatWhen,
  HOUR_MS,
  hasHeadroom,
  nextReset,
  nextRunOut,
  type Series,
  type SeriesQuery,
  type Snapshot,
  type TimeRange,
} from '../core/index'
import { Breakdown } from './Breakdown'
import { useNow, useSeries, useSnapshot } from './hooks'
import { type ChartSeries, foldSeries, LineChart, seriesColors } from './LineChart'
import { RunwayCard } from './Runway'
import { Sparkline } from './Sparkline'

export interface DashboardProps {
  /** The snapshot rendered on the server, so the first paint has data. */
  initialSnapshot: Snapshot
  /** Where the dashboard's route handler is mounted, e.g. "/api/claude-master". */
  apiBase: string
  title?: string
}

type RangeName = '24h' | '7d'

const RANGES: Record<RangeName, { label: string; ms: number; stepSeconds: number }> = {
  '24h': { label: 'Last 24 hours', ms: 24 * HOUR_MS, stepSeconds: 300 },
  '7d': { label: 'Last 7 days', ms: 7 * 24 * HOUR_MS, stepSeconds: 3600 },
}

// Step-aligned so every viewer and every refresh within a step asks for the same range.
function rangeEnding(now: EpochMs, name: RangeName): TimeRange {
  const { ms, stepSeconds } = RANGES[name]
  const end = Math.floor(now / (stepSeconds * 1000)) * stepSeconds * 1000
  return { start: end - ms, end }
}

const total = (series: Series[] | undefined): Array<[EpochMs, number]> => {
  const first = series?.[0]
  if (first === undefined) return []
  return first.points.map(([t], i) => [
    t,
    (series ?? []).reduce((sum, s) => sum + (s.points[i]?.[1] ?? 0), 0),
  ])
}

/** Sums points into whole hours (already-hourly points pass through). */
function hourly(points: Array<[EpochMs, number]>): Array<[EpochMs, number]> {
  const out = new Map<EpochMs, number>()
  for (const [t, v] of points) {
    const hour = Math.floor(t / HOUR_MS) * HOUR_MS
    out.set(hour, (out.get(hour) ?? 0) + v)
  }
  return [...out.entries()]
}

const sumLast = (points: Array<[EpochMs, number]>, n: number) =>
  points.slice(-n).reduce((sum, [, v]) => sum + v, 0)

function Headline({ snapshot, now }: { snapshot: Snapshot; now: EpochMs }) {
  const { profiles } = snapshot
  const ready = profiles.filter((p) => hasHeadroom(p, now)).length
  const runOut = nextRunOut(profiles, now)
  const reset = nextReset(profiles, now)
  let headline: string
  let detail: string | null = null
  if (profiles.length === 0) {
    headline = 'No subscription has reported yet.'
    detail = 'Readings arrive a few minutes after claude-master starts exporting metrics.'
  } else if (ready === 0) {
    headline = 'No subscription can take work right now.'
    if (reset !== null) {
      detail = `The next window resets in ${formatCountdown(reset - now)}, at ${formatWhen(reset, now)}.`
    }
  } else {
    headline =
      ready === profiles.length
        ? `All ${profiles.length} subscriptions have headroom.`
        : `${ready} of ${profiles.length} subscriptions have headroom.`
    detail =
      runOut === null
        ? 'At the current pace every subscription lasts until its window resets.'
        : `${runOut.profile} runs out of its ${runOut.window === 'weekly' ? 'weekly allowance' : '5-hour window'} in ${formatCountdown(runOut.at - now)} at this pace.`
  }
  return (
    <div>
      <p className="cmd-headline">{headline}</p>
      {detail !== null && <p className="cmd-subline">{detail}</p>}
    </div>
  )
}

function Kpi(props: {
  label: string
  value: string
  note?: string | undefined
  trend?: Array<[EpochMs, number]> | undefined
}) {
  return (
    <div className="cmd-kpi">
      <p className="cmd-kpi-label">{props.label}</p>
      <p className="cmd-kpi-value">{props.value}</p>
      {props.note !== undefined && <p className="cmd-kpi-note">{props.note}</p>}
      {props.trend !== undefined && <Sparkline points={props.trend} />}
    </div>
  )
}

export function Dashboard({ initialSnapshot, apiBase, title = 'claude-master' }: DashboardProps) {
  const now = useNow(1000, initialSnapshot.asOf)
  const loaded = useSnapshot(apiBase, initialSnapshot)
  const snapshot = loaded.state === 'ready' ? loaded.data : initialSnapshot
  const [rangeName, setRangeName] = useState<RangeName>('24h')
  const { stepSeconds } = RANGES[rangeName]

  // Step-aligned: the request URLs change once per step, not every second, so the charts
  // refetch only when a new bucket can exist (useSeries keys on the URL).
  const range = rangeEnding(now, rangeName)
  const query = (q: Omit<SeriesQuery, 'range' | 'stepSeconds'>): SeriesQuery => ({
    ...q,
    range,
    stepSeconds,
  })

  const byProfile = useSeries(apiBase, query({ metric: 'requests', groupBy: 'profile' }))
  const errors = useSeries(apiBase, query({ metric: 'errors' }))
  const backup = useSeries(apiBase, query({ metric: 'backupRequests' }))

  const requestsTotal = total(byProfile.state === 'ready' ? byProfile.data : undefined)
  const errorsTotal = total(errors.state === 'ready' ? errors.data : undefined)
  const perHour = Math.round(HOUR_MS / (stepSeconds * 1000))
  const lastHour = sumLast(requestsTotal, perHour)
  const hourBefore = sumLast(requestsTotal.slice(0, -perHour), perHour)
  const lastHourErrors = sumLast(errorsTotal, perHour)

  // Stable across refreshes: a new array only when the set of subscriptions changes.
  const knownKey = snapshot.profiles.map((p) => p.profile).join('\n')
  const knownProfiles = useMemo(() => knownKey.split('\n').filter((n) => n !== ''), [knownKey])
  const profileLines: ChartSeries[] = useMemo(() => {
    if (byProfile.state !== 'ready') return []
    const folded = foldSeries(byProfile.data)
    // Colors come from every known subscription, so one missing from this range keeps no
    // other's color from shifting.
    const colors = seriesColors([...knownProfiles, ...folded.map((s) => s.key)])
    return folded.map((s) => ({
      ...s,
      label: s.key,
      color: colors.get(s.key) ?? 'var(--cmd-series-1)',
    }))
  }, [byProfile, knownProfiles])

  // Per hour, not per step: a few requests at night make a five-minute error rate swing wildly.
  const errorRate: ChartSeries[] = useMemo(() => {
    if (requestsTotal.length === 0) return []
    const requestsHourly = hourly(requestsTotal)
    const errorsHourly = hourly(errorsTotal)
    const points = requestsHourly.map(([t, r], i): [EpochMs, number] => [
      t,
      r === 0 ? 0 : (errorsHourly[i]?.[1] ?? 0) / r,
    ])
    return [{ key: 'error-rate', label: 'Error rate', color: 'var(--cmd-series-8)', points }]
  }, [requestsTotal, errorsTotal])

  const ageMs = now - snapshot.asOf
  const stale = ageMs > 10 * 60_000

  return (
    <div className="cmd-root">
      <div className="cmd-frame">
        <header className="cmd-header">
          <h1 className="cmd-title">{title}</h1>
          <span className="cmd-freshness" data-stale={stale}>
            {stale
              ? `No reading for ${formatCountdown(ageMs)}`
              : `Updated ${formatCountdown(ageMs)} ago`}
          </span>
        </header>

        <Headline snapshot={snapshot} now={now} />

        <div className="cmd-layout">
          <section aria-labelledby="cmd-subscriptions">
            <h2 className="cmd-section-title" id="cmd-subscriptions">
              Subscriptions
            </h2>
            <div className="cmd-runways">
              {snapshot.profiles.map((p) => (
                <RunwayCard key={p.profile} status={p} now={now} />
              ))}
            </div>
          </section>

          <div>
            <h2 className="cmd-section-title">Traffic</h2>
            <div className="cmd-controls">
              <fieldset className="cmd-segmented">
                <legend className="cmd-visually-hidden">Time range</legend>
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
            </div>
            <div className="cmd-kpis">
              <Kpi
                label="Requests, last hour"
                value={formatCount(lastHour)}
                note={hourBefore === 0 ? undefined : `${formatCount(hourBefore)} the hour before`}
                trend={requestsTotal}
              />
              <Kpi
                label="Error rate, last hour"
                value={formatPercent(lastHour === 0 ? null : lastHourErrors / lastHour)}
                note={`${formatCount(lastHourErrors)} errors from Anthropic`}
              />
              <Kpi
                label="Conversations"
                value={formatCount(snapshot.sessions)}
                note={
                  snapshot.activeConnections === null
                    ? undefined
                    : `${formatCount(snapshot.activeConnections)} open connections`
                }
              />
              <Kpi
                label={`Paid API backup, ${rangeName === '24h' ? '24 hours' : '7 days'}`}
                value={formatCount(
                  backup.state === 'ready'
                    ? sumLast(total(backup.data), Number.MAX_SAFE_INTEGER)
                    : null,
                )}
                note="Requests no subscription could take"
              />
            </div>
            <div style={{ marginTop: 12 }}>
              {byProfile.state === 'error' && <p className="cmd-error">{byProfile.message}</p>}
              {profileLines.length > 0 && (
                <LineChart
                  title="Requests by subscription"
                  series={profileLines}
                  format={formatCount}
                  now={now}
                />
              )}
              {errorRate.length > 0 && (
                <LineChart
                  title="Error rate"
                  series={errorRate}
                  format={(v) => formatPercent(v)}
                  now={now}
                  height={140}
                />
              )}
            </div>
          </div>
        </div>

        <Breakdown apiBase={apiBase} range={range} stepSeconds={stepSeconds} />
      </div>
    </div>
  )
}
