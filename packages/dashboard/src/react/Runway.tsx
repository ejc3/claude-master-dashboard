'use client'

import type { ReactNode } from 'react'
import {
  blocked,
  type EpochMs,
  elapsedFraction,
  fiveHourAt,
  formatCountdown,
  formatDuration,
  formatPercent,
  loginOverdue,
  type ProfileStatus,
  pace,
  projectedExhaustion,
  type QuotaWindow,
} from '../core'
import { useWhen } from './hooks'

/** What the card's badge says: the band, overridden by anything that stops work right now. */
export type CardStatus = 'ok' | 'low' | 'used-up' | 'rate-limited' | 'login' | 'unknown'

const STATUS_LABEL: Record<CardStatus, string> = {
  ok: 'Has headroom',
  low: 'Running low',
  'used-up': 'Used up',
  'rate-limited': 'Rate limited',
  login: 'Login expired',
  unknown: 'No reading',
}

export function cardStatus(profile: ProfileStatus, now: EpochMs): CardStatus {
  const b = blocked(profile, now)
  if (b?.reason === 'no-reading') return 'unknown'
  if (b?.reason === 'login-expired') return 'login'
  if (b?.reason === 'used-up') return 'used-up'
  if (b?.reason === 'rate-limited') return 'rate-limited'
  return profile.band === 'reserve' ? 'low' : 'ok'
}

// Shape as well as color: check, half-full circle, cross, pause, key, dash.
const ICON: Record<CardStatus, ReactNode> = {
  ok: <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" />,
  low: (
    <>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor" />
    </>
  ),
  'used-up': <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" />,
  'rate-limited': <path d="M5.5 3.5v9M10.5 3.5v9" stroke="currentColor" strokeWidth="2" />,
  login: (
    <>
      <circle cx="5.5" cy="8" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M8.5 8h6M12.5 8v3" stroke="currentColor" strokeWidth="2" />
    </>
  ),
  unknown: <path d="M4 8h8" stroke="currentColor" strokeWidth="2" />,
}

export function StatusBadge({ status }: { status: CardStatus }) {
  return (
    <span className="cmd-status" data-status={status}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        {ICON[status]}
      </svg>
      {STATUS_LABEL[status]}
    </span>
  )
}

// Said only when it changes what to do: a used-up window, or one that runs out before its reset.
function paceNote(window: QuotaWindow, now: EpochMs): string | null {
  if (window.usedFraction !== null && window.usedFraction >= 1) return 'Used up until the reset.'
  const runOut = projectedExhaustion(window, now)
  return runOut === null ? null : `Runs out in ${formatCountdown(runOut - now)} at this pace.`
}

function WindowRow(props: { name: string; window: QuotaWindow; now: EpochMs }) {
  const { name, window, now } = props
  const when = useWhen()
  const elapsed = elapsedFraction(window, now)
  const used = window.usedFraction === null ? null : Math.min(1, Math.max(0, window.usedFraction))
  const p = pace(window, now)
  const note = paceNote(window, now)
  const resetsAt = window.resetsAt
  // The wall-clock time needs the viewer's time zone; without it, only the countdown shows.
  const reset =
    resetsAt === null && window.usedFraction === 0
      ? 'No window open'
      : resetsAt === null || resetsAt <= now
        ? 'Reset time unknown'
        : `Resets in ${formatCountdown(resetsAt - now)}${when === null ? '' : `, ${when(resetsAt, now)}`}`
  const description = `${name}: ${formatPercent(used)} used, ${elapsed === null ? 'time elapsed unknown' : `${formatPercent(elapsed)} of the window elapsed`}. ${reset}.`
  return (
    <div className="cmd-window">
      <div className="cmd-window-labels">
        <span>
          <span className="cmd-window-name">{name} </span>
          <span className="cmd-window-used">{formatPercent(used)}</span>
        </span>
        <span className="cmd-window-reset">{reset}</span>
      </div>
      <div className="cmd-runway" role="img" aria-label={description}>
        {elapsed !== null && (
          <div className="cmd-runway-elapsed" style={{ width: `${elapsed * 100}%` }} />
        )}
        {used !== null && <div className="cmd-runway-used" style={{ width: `${used * 100}%` }} />}
        {elapsed !== null && (
          <div className="cmd-runway-now" style={{ left: `${elapsed * 100}%` }} />
        )}
      </div>
      {note !== null && (
        <p className="cmd-window-note" data-pace={p}>
          {note}
        </p>
      )}
    </div>
  )
}

/**
 * One subscription as a row of the subscriptions panel: its name, state and details, then a
 * runway per quota window. The panel lays rows out as columns on wide screens and stacks them on
 * narrow ones.
 */
export function RunwayCard({ status, now }: { status: ProfileStatus; now: EpochMs }) {
  const card = cardStatus(status, now)
  const b = blocked(status, now)
  return (
    <article className="cmd-row" data-status={card} aria-label={`Subscription ${status.profile}`}>
      <div className="cmd-row-main">
        <div className="cmd-row-title">
          <h3 className="cmd-profile">{status.profile}</h3>
          <StatusBadge status={card} />
        </div>
        <p className="cmd-row-meta">
          {b?.until != null && (
            <span data-warn="true">Takes work again in {formatCountdown(b.until - now)}</span>
          )}
          {card === 'login' && <span data-warn="true">Log the profile in again on the server</span>}
          {loginOverdue(status, now) && status.tokenExpiresAt !== null && (
            <span data-warn="true">
              Login not renewed; expires in {formatCountdown(status.tokenExpiresAt - now)}
            </span>
          )}
          <span>p95 {formatDuration(status.latencyMs.p95)}</span>
        </p>
      </div>
      <WindowRow name="Weekly" window={status.weekly} now={now} />
      {status.fiveHour === null ? (
        <p className="cmd-window cmd-window-none">No 5-hour reading</p>
      ) : (
        <WindowRow
          name="5-hour"
          window={fiveHourAt(status.fiveHour, now) ?? status.fiveHour}
          now={now}
        />
      )}
    </article>
  )
}
