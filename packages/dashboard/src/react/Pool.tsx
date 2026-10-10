'use client'

import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import {
  blocked,
  type EpochMs,
  fiveHourAt,
  formatCountdown,
  formatPercent,
  gapsHeadline,
  HOUR_MS,
  hasHeadroom,
  type PoolGaps,
  type PoolTone,
  type ProfileStatus,
  TRACE_STEP_MS,
  type WindowKind,
} from '../core'
import { useWhen } from './hooks'
import { LineChart } from './LineChart'

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

/**
 * An iCalendar file for one moment, as a link a phone's calendar opens: a reminder at a reset.
 * Times are UTC, so it lands right in any zone.
 */
export function calendarHref(title: string, at: EpochMs): string {
  const stamp = (t: EpochMs) =>
    new Date(t)
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '')
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//claude-master//dashboard//EN',
    'BEGIN:VEVENT',
    `UID:${at}-${title.replace(/[^A-Za-z0-9]/g, '')}@claude-master`,
    `DTSTAMP:${stamp(at)}`,
    `DTSTART:${stamp(at)}`,
    `DTEND:${stamp(at + 15 * 60_000)}`,
    `SUMMARY:${title.replace(/[\\;,\n]/g, ' ')}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(ics)}`
}

/** One window of the detail: its use, and when it resets with a link to add that to a calendar. */
function WindowDetail(props: {
  name: string
  who: string
  window: { usedFraction: number | null; resetsAt: EpochMs | null } | null
  closed?: boolean
  now: EpochMs
}) {
  const when = useWhen()
  const { window: w, now } = props
  if (w === null) return <li>{props.name}: no reading</li>
  if (props.closed) return <li>{props.name}: not in use</li>
  const used = share(w.usedFraction)
  const resets = w.resetsAt !== null && w.resetsAt > now ? w.resetsAt : null
  return (
    <li>
      {props.name} {formatPercent(used)} used
      {resets === null ? (
        ' · reset time unknown'
      ) : (
        <>
          {' · resets '}
          <a
            href={calendarHref(`${props.who}: ${props.name.toLowerCase()} limit resets`, resets)}
            download={`${props.who}-${props.name.toLowerCase()}-reset.ics`}
            title="Add to calendar"
          >
            {when === null ? `in ${formatCountdown(resets - now)}` : when(resets, now)}
          </a>
          {when === null ? '' : ` (in ${formatCountdown(resets - now)})`}
        </>
      )}
    </li>
  )
}

/** Whether a subscription can take work, or until when it cannot, in words. */
function availability(p: ProfileStatus, now: EpochMs): string {
  const b = blocked(p, now)
  if (b === null) return 'Available'
  if (b.reason === 'login-expired') return 'Login expired · log in again on the server'
  if (b.reason === 'no-reading') return 'No reading'
  const back = b.until === null ? 'back time unknown' : `back in ${formatCountdown(b.until - now)}`
  return b.reason === 'rate-limited' ? `Rate limited · ${back}` : `Used up · ${back}`
}

/**
 * Each subscription's weekly and 5-hour use, as two tiny bars, and whether it can take work.
 * Hovering (with a mouse) or tapping one shows its detail below the row: when each limit resets,
 * with a link to put that in a calendar. A tap anywhere else, or Escape, closes it.
 */
export function PoolAccounts(props: { profiles: ProfileStatus[]; now: EpochMs }) {
  const names = shortNames(props.profiles.map((p) => p.profile))
  const [open, setOpen] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open === null) return
    const away = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(null)
    }
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(null)
    }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', onEscape)
    }
  }, [open])
  if (props.profiles.length === 0) return null
  const shown = props.profiles.find((p) => p.profile === open) ?? null
  return (
    <div className="cmd-accounts" ref={ref}>
      <p className="cmd-accounts-key" aria-hidden="true">
        Used: week · 5-hour
      </p>
      <ul aria-label="Each subscription's weekly and 5-hour use">
        {props.profiles.map((p) => {
          const weekly = share(p.weekly.usedFraction)
          // As of now: a read window whose reset has passed is no window open.
          const five = share(fiveHourAt(p.fiveHour, props.now)?.usedFraction)
          const available = hasHeadroom(p, props.now)
          return (
            <li key={p.profile} className="cmd-account" data-open={available}>
              <button
                type="button"
                aria-expanded={open === p.profile}
                aria-controls="cmd-account-detail"
                onClick={() => setOpen((o) => (o === p.profile ? null : p.profile))}
                onPointerEnter={(event) => {
                  if (event.pointerType === 'mouse') setOpen(p.profile)
                }}
              >
                <span className="cmd-account-bars" aria-hidden="true">
                  <UsedBar used={weekly} window="weekly" />
                  <UsedBar used={five} window="fiveHour" />
                </span>
                <span className="cmd-account-name">{names.get(p.profile)}</span>
                <span className="cmd-visually-hidden">
                  {`: week ${formatPercent(weekly)} used, 5-hour ${
                    five === null ? 'no reading' : `${formatPercent(five)} used`
                  }${available ? '' : ', not available'}`}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {shown !== null && (
        <div id="cmd-account-detail" className="cmd-account-detail" role="status">
          <p>
            <b>{shown.profile}</b> · {availability(shown, props.now)}
          </p>
          <ul>
            <WindowDetail name="Weekly" who={shown.profile} window={shown.weekly} now={props.now} />
            <WindowDetail
              name="5-hour"
              who={shown.profile}
              window={fiveHourAt(shown.fiveHour, props.now)}
              closed={shown.fiveHour?.resetsAt != null && shown.fiveHour.resetsAt <= props.now}
              now={props.now}
            />
          </ul>
        </div>
      )}
    </div>
  )
}

const asPercent = (v: number) => `${Math.round(v * 100)}%`

/**
 * What is left of each limit across the pool, from now to the furthest weekly reset, if recent use
 * goes on (the same simulation as the headline), as a share of the whole pool: 100% is every
 * subscription unused. Shaded where no subscription is available.
 */
export function CapacityOutlook(props: {
  gaps: PoolGaps | null
  profiles: ProfileStatus[] | null
  now: EpochMs
}) {
  const { gaps } = props
  // Moves on a sample at a time, so the charts (and an open table) redraw when the data does,
  // not every second.
  const now = Math.floor(props.now / TRACE_STEP_MS) * TRACE_STEP_MS
  const resetKey = (props.profiles ?? []).map((p) => p.weekly.resetsAt ?? '').join(',')
  const charts = useMemo(() => {
    if (gaps === null || gaps.trace.length === 0 || gaps.capacity === 0) return null
    const resets = resetKey
      .split(',')
      .map(Number)
      .filter((t) => t > now)
    const horizonEnd = gaps.trace.at(-1)?.at ?? now
    // The weekly chart to the furthest weekly reset and the hour after it (so its step up
    // shows), hourly; the 5-hour one over the next day, every sample, where its windows' cycles
    // can be read.
    const weeklyUntil = Math.min(horizonEnd, Math.max(now + 24 * HOUR_MS, ...resets) + HOUR_MS)
    const fiveUntil = Math.min(horizonEnd, now + 24 * HOUR_MS)
    const start = gaps.trace[0]?.at ?? now
    const points = (key: 'weekly' | 'fiveHour', until: EpochMs, every: number) =>
      gaps.trace
        .filter((p) => p.at >= now - every && p.at <= until && (p.at - start) % every === 0)
        .map((p): [EpochMs, number] => [p.at, p[key] / gaps.capacity])
    return {
      weekly: points('weekly', weeklyUntil, HOUR_MS),
      fiveHour: points('fiveHour', fiveUntil, TRACE_STEP_MS),
      bands: gaps.gaps.map((g) => ({ start: g.start, end: g.end ?? horizonEnd })),
      capacity: gaps.capacity,
    }
  }, [gaps, now, resetKey])
  if (charts === null) return null
  const chart = (
    key: 'weekly' | 'fiveHour',
    points: Array<[EpochMs, number]>,
    title: string,
    color: string,
  ) => {
    // The title carries what is left now: the point at or before now.
    const current = points.filter(([t]) => t <= props.now).at(-1)?.[1] ?? points[0]?.[1]
    const label = current === undefined ? title : `${title} · ${asPercent(current)}`
    return points.length < 2 ? null : (
      <LineChart
        title={label}
        series={[{ key, label: title, color, points }]}
        format={asPercent}
        max={1}
        bands={charts.bands}
        bandLabel="None available"
        table={false}
        height={160}
        now={now}
        area
      />
    )
  }
  return (
    <div className="cmd-capacity">
      {chart('weekly', charts.weekly, 'Weekly limit left', 'var(--cmd-series-1)')}
      {chart('fiveHour', charts.fiveHour, '5-hour limit left, next 24h', 'var(--cmd-series-2)')}
      <p className="cmd-capacity-note">
        100% = all {charts.capacity} subscriptions unused · shaded: none available
      </p>
    </div>
  )
}

/**
 * The top of the dashboard: when the pool runs out, as a status line and the facts behind it,
 * how it is worked out, each subscription's use at a glance, and what is left over time.
 */
export function PoolOutlook(props: {
  gaps: PoolGaps | null
  profiles: ProfileStatus[] | null
  now: EpochMs
  detail?: string | null
}) {
  const { now } = props
  const when = useWhen()
  const { tone, headline, facts } = gapsHeadline(
    props.gaps,
    now,
    when === null ? null : (at) => when(at, now),
  )
  const lines = props.detail == null ? facts : [...facts, props.detail]
  const forecasting =
    props.gaps !== null && props.gaps.lasts !== 'unknown' && props.gaps.lasts !== 'logins'
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
          {forecasting && (
            <details className="cmd-method">
              <summary>How this is worked out</summary>
              <ul>
                <li>
                  Pace is how fast the pool has been using each limit: the weekly one over the last
                  24 hours, the 5-hour one since each window opened.
                </li>
                <li>
                  That pace is carried forward for 7 days, sending work to the subscriptions in
                  claude-master's order; each limit resets on its own schedule.
                </li>
                <li>
                  Running out means no subscription can take work, until the first one resets;
                  requests go to the paid backup meanwhile.
                </li>
              </ul>
            </details>
          )}
        </div>
        {props.profiles !== null && <PoolAccounts profiles={props.profiles} now={now} />}
      </div>
      <CapacityOutlook gaps={props.gaps} profiles={props.profiles} now={now} />
    </section>
  )
}
