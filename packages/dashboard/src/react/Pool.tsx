'use client'

import type { ReactNode } from 'react'
import {
  among,
  type EpochMs,
  FORECAST_HORIZON_MS,
  fiveHourAt,
  forecastState,
  formatCountdown,
  formatPercent,
  gapsHeadline,
  hasHeadroom,
  type PoolForecast,
  type PoolGaps,
  type PoolTone,
  type ProfileStatus,
  reportingAll,
  type WindowKind,
} from '../core'
import { useWhen } from './hooks'

const WINDOW_NAME: Record<WindowKind, string> = {
  weekly: 'Weekly allowance',
  fiveHour: '5-hour capacity',
}

const HORIZON_WORDS: Record<WindowKind, string> = {
  weekly: 'the next 7 days',
  fiveHour: 'the next 24 hours',
}

// Shape as well as color: check, triangle, cross, circle.
const TONE_ICON: Record<PoolTone, ReactNode> = {
  success: <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" />,
  warning: (
    <path
      d="M8 2.5L14 13.5H2zM8 6.5v3.5M8 11.5v.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
  ),
  error: <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" />,
  info: <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.6" />,
}

/** How the demand was measured, in words. */
export function rateNote(f: PoolForecast): string {
  const average =
    f.window === 'weekly' ? 'the average since each reset' : "each window's average so far"
  if (f.smoothedCount === 0) return average
  if (f.smoothedCount === f.counted) return 'smoothed over up to the last 24 hours'
  return `smoothed over up to the last 24 hours for ${f.smoothedCount} of ${f.counted}, else ${average}`
}

/**
 * The cell's look: 'out' (an error) when the pool is out or every login has expired, 'partial'
 * (a warning) when that holds only among the subscriptions reporting the window.
 */
export function forecastCellState(
  f: PoolForecast,
  now: EpochMs,
): 'out' | 'partial' | 'clips' | 'lasts' | 'unknown' {
  const { state, partial } = forecastState(f, now)
  if (state === 'logins' || state === 'out') return partial ? 'partial' : 'out'
  return state
}

function ForecastCell(props: { forecast: PoolForecast; now: EpochMs }) {
  const { forecast: f, now } = props
  const when = useWhen()
  const at = (t: EpochMs) => (when === null ? '' : `, ${when(t, now)}`)
  let value: string
  let detail: string
  const state = forecastCellState(f, now)
  const { state: kind } = forecastState(f, now)
  if (kind === 'logins') {
    value = 'Logins expired'
    detail = reportingAll(f)
      ? 'Log the subscriptions in again on the server.'
      : `Every subscription reporting this window${among(f)} needs logging in again.`
  } else if (kind === 'out') {
    value = 'Out now'
    detail =
      f.recoversAt === null
        ? 'No reset time is known.'
        : `Work resumes in ${formatCountdown(f.recoversAt - now)}${at(f.recoversAt)}.`
  } else if (kind === 'clips' && f.clipsAt !== null) {
    const clipsAt = f.clipsAt
    value = `Runs out in ${formatCountdown(clipsAt - now)}`
    const then = when === null ? 'Then' : when(clipsAt, now)
    detail =
      f.recoversAt === null
        ? `${then}; no reset time is known.`
        : `${then}, for ${formatCountdown(f.recoversAt - clipsAt)} until the first reset.`
  } else if (kind === 'unknown') {
    value = 'No reading'
    detail = 'No subscription reports this window yet.'
  } else {
    value = f.lasts === 'idle' ? 'Not in use' : "Won't run out"
    detail = `No run-out in ${HORIZON_WORDS[f.window]} at this pace.`
  }
  const used = f.used === null ? null : Math.min(1, Math.max(0, f.used))
  const horizonHours = FORECAST_HORIZON_MS[f.window] / 3_600_000
  return (
    <div className="cmd-forecast" data-state={state}>
      <h3 className="cmd-panel-label">{WINDOW_NAME[f.window]}</h3>
      <p className="cmd-forecast-value">{value}</p>
      <p className="cmd-forecast-detail">{detail}</p>
      <div className="cmd-forecast-usage">
        <span>
          Pool used <b>{formatPercent(used)}</b>
        </span>
        <span>
          {f.unreported === 0
            ? `${f.counted} ${f.counted === 1 ? 'subscription' : 'subscriptions'}`
            : `${f.counted} of ${f.counted + f.unreported} report this`}
        </span>
      </div>
      <div
        className="cmd-pool-bar"
        role="img"
        aria-label={`${WINDOW_NAME[f.window]}: ${formatPercent(used)} used across the pool`}
      >
        {used !== null && <span className="cmd-pool-fill" style={{ width: `${used * 100}%` }} />}
      </div>
      <p className="cmd-forecast-note">
        Using {formatPercent(f.burnPerHour)} of one subscription's allowance per hour ({rateNote(f)}
        ); looks {horizonHours >= 48 ? `${horizonHours / 24} days` : `${horizonHours} hours`} ahead.
      </p>
    </div>
  )
}

/** The names without what they all start with ("claude-colin", "claude-thao" → "colin", "thao"). */
export function shortNames(names: string[]): Map<string, string> {
  let prefix = names[0] ?? ''
  for (const n of names) while (!n.startsWith(prefix)) prefix = prefix.slice(0, -1)
  // Only up to a separator, and never the whole of a name.
  const cut =
    Math.max(prefix.lastIndexOf('-'), prefix.lastIndexOf('_'), prefix.lastIndexOf('.')) + 1
  return new Map(
    names.map((n) => [n, names.length > 1 && cut > 0 && cut < n.length ? n.slice(cut) : n]),
  )
}

const share = (f: number | null | undefined) =>
  f === null || f === undefined || !Number.isFinite(f) ? null : Math.min(1, Math.max(0, f))

/** A tiny bar: how much of a window is used; dashed and empty when there is no reading. */
function UsedBar(props: { used: number | null; window: WindowKind }) {
  const { used } = props
  const level = used === null ? 'unknown' : used >= 1 ? 'full' : used >= 0.9 ? 'high' : 'ok'
  return (
    <span className="cmd-account-bar" data-window={props.window} data-level={level}>
      {used !== null && <span style={{ height: `${used * 100}%` }} />}
    </span>
  )
}

/** Each subscription's weekly and 5-hour use, as two tiny bars, and whether it can take work. */
export function PoolAccounts(props: { profiles: ProfileStatus[]; now: EpochMs }) {
  const names = shortNames(props.profiles.map((p) => p.profile))
  if (props.profiles.length === 0) return null
  return (
    <div className="cmd-accounts">
      <p className="cmd-accounts-key" aria-hidden="true">
        Week, 5-hour
      </p>
      <ul aria-label="Each subscription's weekly and 5-hour use">
        {props.profiles.map((p) => {
          const weekly = share(p.weekly.usedFraction)
          // As of now: a read window whose reset has passed is no window open.
          const five = share(fiveHourAt(p.fiveHour, props.now)?.usedFraction)
          const words = `${p.profile}: week ${formatPercent(weekly)}, 5-hour ${
            five === null ? 'no reading' : formatPercent(five)
          }${hasHeadroom(p, props.now) ? '' : ', cannot take work now'}`
          return (
            <li
              key={p.profile}
              className="cmd-account"
              data-open={hasHeadroom(p, props.now)}
              title={words}
            >
              <span className="cmd-account-bars" aria-hidden="true">
                <UsedBar used={weekly} window="weekly" />
                <UsedBar used={five} window="fiveHour" />
              </span>
              <span className="cmd-account-name" aria-hidden="true">
                {names.get(p.profile)}
              </span>
              <span className="cmd-visually-hidden">{words}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * The top of the dashboard: will the pool run out, as a status line and the facts behind it,
 * each subscription's use at a glance, and one cell per window with its own forecast.
 */
export function PoolOutlook(props: {
  forecasts: PoolForecast[] | null
  gaps: PoolGaps | null
  profiles: ProfileStatus[] | null
  now: EpochMs
  detail?: string | null
}) {
  const { forecasts, now } = props
  const { tone, headline, facts } = gapsHeadline(props.gaps, now)
  const lines = props.detail == null ? facts : [...facts, props.detail]
  return (
    <section className="cmd-pool" data-tone={tone} aria-labelledby="cmd-pool-headline">
      <div className="cmd-pool-head">
        <svg className="cmd-alert-icon" viewBox="0 0 16 16" aria-hidden="true">
          {TONE_ICON[tone]}
        </svg>
        <div>
          <h2 className="cmd-headline" id="cmd-pool-headline">
            {headline}
          </h2>
          {lines.length > 0 && (
            <ul className="cmd-facts">
              {lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </div>
        {props.profiles !== null && <PoolAccounts profiles={props.profiles} now={now} />}
      </div>
      {forecasts !== null && (
        <div className="cmd-forecasts">
          {forecasts.map((f) => (
            <ForecastCell key={f.window} forecast={f} now={now} />
          ))}
        </div>
      )}
    </section>
  )
}
