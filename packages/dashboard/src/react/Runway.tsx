'use client'

import {
  type Band,
  type EpochMs,
  elapsedFraction,
  formatCountdown,
  formatDuration,
  formatPercent,
  formatWhen,
  type ProfileStatus,
  pace,
  projectedExhaustion,
  type QuotaWindow,
} from '../core/index'

const BAND_LABEL: Record<Band, string> = {
  ok: 'Has headroom',
  reserve: 'In reserve',
  exhausted: 'Used up',
  unknown: 'No reading',
}

function BandIcon({ band }: { band: Band }) {
  // Shape as well as color: a check, a half-full circle, a cross, a dash.
  switch (band) {
    case 'ok':
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
      )
    case 'reserve':
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor" />
        </svg>
      )
    case 'exhausted':
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" />
        </svg>
      )
    case 'unknown':
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 8h8" stroke="currentColor" strokeWidth="2" />
        </svg>
      )
  }
}

export function StatusBadge({ band }: { band: Band }) {
  return (
    <span className="cmd-status" data-band={band}>
      <BandIcon band={band} />
      {BAND_LABEL[band]}
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
  const elapsed = elapsedFraction(window, now)
  const used = window.usedFraction === null ? null : Math.min(1, Math.max(0, window.usedFraction))
  const p = pace(window, now)
  const note = paceNote(window, now)
  const reset =
    window.resetsAt === null
      ? 'Reset time unknown'
      : `Resets in ${formatCountdown(window.resetsAt - now)}, ${formatWhen(window.resetsAt, now)}`
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

export function RunwayCard({ status, now }: { status: ProfileStatus; now: EpochMs }) {
  const cooling = status.rateLimitedUntil !== null && status.rateLimitedUntil > now
  return (
    <article
      className="cmd-card"
      data-band={status.band}
      aria-label={`Subscription ${status.profile}`}
    >
      <div className="cmd-card-head">
        <h3 className="cmd-profile">{status.profile}</h3>
        <StatusBadge band={status.band} />
      </div>
      <WindowRow name="Weekly" window={status.weekly} now={now} />
      {status.fiveHour !== null && <WindowRow name="5-hour" window={status.fiveHour} now={now} />}
      <div className="cmd-card-foot">
        {cooling && status.rateLimitedUntil !== null && (
          <span data-warn="true">
            Cooling down after a rate limit for {formatCountdown(status.rateLimitedUntil - now)}
          </span>
        )}
        {status.tokenExpiresAt !== null && (
          // Access tokens renew on their own; only one that has run out needs attention.
          <span data-warn={status.tokenExpiresAt <= now}>
            {status.tokenExpiresAt > now
              ? `Login renews in ${formatCountdown(status.tokenExpiresAt - now)}`
              : 'Login expired: check the profile'}
          </span>
        )}
        <span>p95 {formatDuration(status.latencyMs.p95)}</span>
      </div>
    </article>
  )
}
