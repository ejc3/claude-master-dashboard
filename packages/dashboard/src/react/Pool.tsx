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
export function PoolAccounts(props: {
  profiles: ProfileStatus[]
  now: EpochMs
  /** What each weekly reset will leave unused at this pace (PoolGaps.unusedAtReset). */
  unusedAtReset?: PoolGaps['unusedAtReset']
}) {
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
            {(() => {
              const next = props.unusedAtReset?.find((r) => r.profile === shown.profile)
              return next === undefined ? null : (
                <li>
                  At this pace {formatPercent(next.unused)} of the week goes unused at its reset
                </li>
              )
            })()}
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
/** One forecast's charts: what is left of each limit as a share of the pool, and its gaps. */
function capacitySeries(gaps: PoolGaps | null, now: EpochMs, resets: EpochMs[]) {
  if (gaps === null || gaps.trace.length === 0 || gaps.capacity === 0) return null
  const horizonEnd = gaps.trace.at(-1)?.at ?? now
  // The weekly chart to the furthest weekly reset and the hour after it (so its step up shows),
  // hourly; the 5-hour one over the next day, every sample, where its windows' cycles show.
  const weeklyUntil = Math.min(horizonEnd, Math.max(now + 24 * HOUR_MS, ...resets) + HOUR_MS)
  const fiveUntil = Math.min(horizonEnd, now + 24 * HOUR_MS)
  const start = gaps.trace[0]?.at ?? now
  const points = (key: 'weekly' | 'fiveHour', until: EpochMs, every: number) =>
    gaps.trace
      .filter((p) => p.at >= now - every && p.at <= until && (p.at - start) % every === 0)
      .map((p): [EpochMs, number] => [p.at, p[key]])
  return {
    weekly: points('weekly', weeklyUntil, HOUR_MS),
    fiveHour: points('fiveHour', fiveUntil, TRACE_STEP_MS),
    bands: gaps.gaps.map((g) => ({ start: g.start, end: g.end ?? horizonEnd })),
    capacity: gaps.capacity,
  }
}

/**
 * What is left of each limit across the pool, from now to the furthest weekly reset, in one
 * subscription's limit (100% each, so five unused subscriptions are 500% and more subscriptions
 * show as more). The weekly chart has two tabs: projected
 * at the recent pace (the same simulation as the headline), and if use stops, when what is left
 * only comes back as limits reset. Shaded where no subscription is available.
 */
export function CapacityOutlook(props: {
  gaps: PoolGaps | null
  /** The same forecast with no more use, for the weekly chart's "If use stops" tab. */
  gapsIfStopped?: PoolGaps | null
  profiles: ProfileStatus[] | null
  now: EpochMs
}) {
  const [weeklyView, setWeeklyView] = useState<'projected' | 'stopped'>('projected')
  // Moves on a sample at a time, so the charts redraw when the data does, not every second.
  const now = Math.floor(props.now / TRACE_STEP_MS) * TRACE_STEP_MS
  const resetKey = (props.profiles ?? []).map((p) => p.weekly.resetsAt ?? '').join(',')
  const resets = useMemo(
    () =>
      resetKey
        .split(',')
        .map(Number)
        .filter((t) => t > now),
    [resetKey, now],
  )
  const projected = useMemo(
    () => capacitySeries(props.gaps, now, resets),
    [props.gaps, now, resets],
  )
  const stopped = useMemo(
    () => capacitySeries(props.gapsIfStopped ?? null, now, resets),
    [props.gapsIfStopped, now, resets],
  )
  if (projected === null) return null
  const weekly = weeklyView === 'stopped' && stopped !== null ? stopped : projected
  const chart = (
    key: 'weekly' | 'fiveHour',
    series: NonNullable<typeof projected>,
    title: string,
    color: string,
  ) => {
    const points = series[key]
    // The title carries what is left now: the point at or before now.
    const current = points.filter(([t]) => t <= props.now).at(-1)?.[1] ?? points[0]?.[1]
    const label = current === undefined ? title : `${title} · ${asPercent(current)}`
    return points.length < 2 ? null : (
      <LineChart
        title={label}
        series={[{ key, label: title, color, points }]}
        format={asPercent}
        max={series.capacity}
        bands={series.bands}
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
      <div className="cmd-capacity-weekly">
        {stopped !== null && (
          <fieldset className="cmd-segmented cmd-capacity-tabs">
            <legend className="cmd-visually-hidden">Weekly limit forecast</legend>
            <button
              type="button"
              aria-pressed={weeklyView === 'projected'}
              onClick={() => setWeeklyView('projected')}
            >
              Projected
            </button>
            <button
              type="button"
              aria-pressed={weeklyView === 'stopped'}
              onClick={() => setWeeklyView('stopped')}
            >
              Subscription resets
            </button>
          </fieldset>
        )}
        {chart('weekly', weekly, 'Weekly limit left', 'var(--cmd-series-1)')}
      </div>
      {chart('fiveHour', projected, '5-hour limit left, next 24h', 'var(--cmd-series-2)')}
      <p className="cmd-capacity-note">
        100% = one subscription's limit · {projected.capacity * 100}% = all {projected.capacity}{' '}
        unused · shaded: none available
      </p>
    </div>
  )
}

/**
 * The top of the dashboard: when the pool runs out and for how long, the pace that assumes, each
 * subscription's use at a glance, and what is left over time.
 */
export function PoolOutlook(props: {
  gaps: PoolGaps | null
  /** The same forecast with no more use (poolGaps' noMoreUse), for the weekly chart's other tab. */
  gapsIfStopped?: PoolGaps | null
  profiles: ProfileStatus[] | null
  now: EpochMs
  detail?: string | null
}) {
  const { now } = props
  const when = useWhen()
  // No clock times in the banner: the countdowns say it.
  const { tone, headline, facts } = gapsHeadline(props.gaps, now)
  const forecasting =
    props.gaps !== null && props.gaps.lasts !== 'unknown' && props.gaps.lasts !== 'logins'
  // The formula, briefly: the pace carried forward.
  const pace =
    forecasting && props.gaps !== null
      ? [
          `At ${formatPercent(props.gaps.pace.weekly)} of a weekly limit and ${formatPercent(
            props.gaps.pace.fiveHour,
          )} of a 5-hour limit an hour`,
        ]
      : []
  // Tokens left on the table: what weekly resets will throw away at this pace.
  const lost = props.gaps?.unusedAtReset ?? []
  const names = shortNames((props.profiles ?? []).map((p) => p.profile))
  const unused =
    forecasting && lost.length > 0
      ? [
          `Unused at weekly resets: ${formatPercent(lost.reduce((sum, r) => sum + r.unused, 0))} · ${[
            ...lost,
          ]
            .sort((a, b) => b.unused - a.unused)
            .slice(0, 2)
            .map(
              (r) =>
                `${names.get(r.profile) ?? r.profile} ${formatPercent(r.unused)}${
                  when === null ? '' : ` ${when(r.at, now)}`
                }`,
            )
            .join(', ')}`,
        ]
      : []
  const lines = [...facts, ...(props.detail == null ? [] : [props.detail]), ...pace, ...unused]
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
        {props.profiles !== null && (
          <PoolAccounts
            profiles={props.profiles}
            now={now}
            unusedAtReset={props.gaps?.unusedAtReset ?? []}
          />
        )}
      </div>
      <CapacityOutlook
        gaps={props.gaps}
        gapsIfStopped={props.gapsIfStopped ?? null}
        profiles={props.profiles}
        now={now}
      />
    </section>
  )
}
