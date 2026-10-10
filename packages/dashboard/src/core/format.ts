import type { EpochMs } from './types'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** A countdown such as "3d 2h", "2h 12m", "12m" or "40s"; "now" when it has passed. */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return 'now'
  if (ms >= DAY) {
    const days = Math.floor(ms / DAY)
    const hours = Math.floor((ms % DAY) / HOUR)
    return hours === 0 ? `${days}d` : `${days}d ${hours}h`
  }
  if (ms >= HOUR) {
    const hours = Math.floor(ms / HOUR)
    const minutes = Math.floor((ms % HOUR) / MINUTE)
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
  }
  if (ms >= MINUTE) return `${Math.floor(ms / MINUTE)}m`
  return `${Math.ceil(ms / 1000)}s`
}

/** A share as a percentage: whole from 10% ("42%"), one decimal below ("2.5%"); a dash if unknown. */
export function formatPercent(fraction: number | null): string {
  if (fraction === null || !Number.isFinite(fraction)) return '—'
  const percent = fraction * 100
  // One decimal where rounding would mislead: under 10%, and just short of 100%.
  if (percent !== 0 && (Math.abs(percent) < 10 || (percent >= 99.5 && percent < 100))) {
    return `${(Math.floor(percent * 10) / 10).toFixed(1)}%`
  }
  return `${Math.round(percent)}%`
}

/** A count with thousands grouped, or compacted past 10,000 ("12.4k"). */
export function formatCount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  if (Math.abs(value) >= 10_000) {
    return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(
      value,
    )
  }
  return new Intl.NumberFormat('en').format(Math.round(value))
}

/** Milliseconds as "840 ms" or "14.2 s". */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

/** A wall-clock time in the viewer's zone: "14:05" today, "Thu 14:05" within a week, else a date. */
export function formatWhen(at: EpochMs, now: EpochMs, timeZone?: string): string {
  const options: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }
  if (timeZone !== undefined) options.timeZone = timeZone
  const day = (t: EpochMs) =>
    new Intl.DateTimeFormat('en-CA', {
      ...options,
      hour: undefined,
      minute: undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(t)
  if (day(at) === day(now)) return new Intl.DateTimeFormat('en', options).format(at)
  if (Math.abs(at - now) < 6 * DAY) {
    return new Intl.DateTimeFormat('en', { ...options, weekday: 'short' }).format(at)
  }
  return new Intl.DateTimeFormat('en', { ...options, month: 'short', day: 'numeric' }).format(at)
}

/** The cookie in which the browser tells the server the viewer's time zone. */
export const TIME_ZONE_COOKIE = 'cmd-tz'

/**
 * An IANA time zone name the formatter accepts, or null: a cookie value is the viewer's to set,
 * so anything else is ignored rather than trusted.
 */
export function timeZoneOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return null
  if (!/^[A-Za-z0-9_+\-/]+$/.test(value)) return null
  try {
    new Intl.DateTimeFormat('en', { timeZone: value })
    return value
  } catch {
    return null
  }
}
