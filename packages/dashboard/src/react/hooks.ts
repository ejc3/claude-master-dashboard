'use client'

import {
  createContext,
  type RefObject,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  type EpochMs,
  fillSeries,
  formatWhen,
  type Series,
  type SeriesQuery,
  type Snapshot,
  TIME_ZONE_COOKIE,
  type TimeRange,
} from '../core'
import { type PollFailure, type PollState, startPoller } from './poller'
import { type FirstSeries, queryKey, queryShape } from './queries'

/**
 * What the server rendered the page with: the answers to its first queries, and the viewer's
 * time zone when the browser has told it (a cookie). The first render in the browser uses the
 * same, so hydrating the page changes nothing on screen.
 */
export interface FirstPaint {
  series: FirstSeries
  timeZone: string | null
}

export const FirstPaintContext = createContext<FirstPaint>({ series: {}, timeZone: null })

/** The element's content width, tracked as it resizes; 0 before the first measurement. */
export function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const element = ref.current
    if (element === null) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setWidth(Math.floor(entry.contentRect.width))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}

/** True while the page is shown; polling stops while it is hidden. */
export function useVisible(): boolean {
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === 'visible')
    update()
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  return visible
}

const noSubscribe = () => () => {}

/** False during server rendering and hydration, true after. */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  )
}

/**
 * Formats a wall-clock time for the viewer, or null while the time zone is unknown. The server
 * and the hydrating render use the zone the browser reported last time (the same one, unless the
 * viewer has moved); after hydration the browser's own zone applies.
 */
export function useWhen(): ((at: EpochMs, now: EpochMs) => string) | null {
  const { timeZone } = useContext(FirstPaintContext)
  if (useHydrated()) return (at, now) => formatWhen(at, now)
  return timeZone === null ? null : (at, now) => formatWhen(at, now, timeZone)
}

/** Tells the server the viewer's time zone (a cookie) when it does not know it yet. */
export function useReportTimeZone(): void {
  const { timeZone } = useContext(FirstPaintContext)
  useEffect(() => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (zone === timeZone) return
    const secure = window.location.protocol === 'https:' ? '; secure' : ''
    // biome-ignore lint/suspicious/noDocumentCookie: one non-secret preference, read by the server
    document.cookie = `${TIME_ZONE_COOKIE}=${encodeURIComponent(zone)}; path=/; max-age=31536000; samesite=lax${secure}`
  }, [timeZone])
}

/** The current time, advancing every `everyMs` while the page is visible. */
export function useNow(everyMs: number, initial: EpochMs): EpochMs {
  const [now, setNow] = useState(initial)
  const visible = useVisible()
  useEffect(() => {
    if (!visible) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(timer)
  }, [everyMs, visible])
  return now
}

export type Loaded<T> =
  | { state: 'loading' }
  | {
      state: 'ready'
      data: T
      at: EpochMs
      failure: PollFailure | null
      /** For series: the range the data answers, which is the query's own, or an earlier one's. */
      range?: TimeRange
    }
  | { state: 'error'; failure: PollFailure }

/** Polls `url` while visible. Data from another URL never shows under this one. */
function usePolled<T>(url: string | null, everyMs: number, initial?: T): Loaded<T> {
  const [poll, setPoll] = useState<PollState<T> | null>(() =>
    url !== null && initial !== undefined ? { url, data: initial, at: Date.now() } : null,
  )
  // The server rendered `initial`, so the first request waits one period.
  const servedInitial = useRef(initial !== undefined)
  const pollRef = useRef(poll)
  pollRef.current = poll
  const visible = useVisible()
  useEffect(() => {
    if (url === null || !visible) return
    const delayFirst = servedInitial.current
    servedInitial.current = false
    return startPoller<T>({
      url,
      everyMs,
      delayFirst,
      fetch: (input, init) => fetch(input, init),
      previous: pollRef.current ?? undefined,
      onChange: setPoll,
    })
  }, [url, everyMs, visible])

  if (poll === null || poll.url !== url) return { state: 'loading' }
  if (poll.data !== undefined) {
    return { state: 'ready', data: poll.data, at: poll.at ?? 0, failure: poll.failure ?? null }
  }
  return poll.failure === undefined
    ? { state: 'loading' }
    : { state: 'error', failure: poll.failure }
}

export function useSnapshot(apiBase: string, initial: Snapshot | null): Loaded<Snapshot> {
  return usePolled<Snapshot>(`${apiBase}/snapshot`, 60_000, initial ?? undefined)
}

type Kept<T> = { shape: string; end: EpochMs; loaded: Loaded<T> } | null

/**
 * The last answer stays on show while the same query, its range moved on by one step, loads: the
 * range moves every few minutes, and nothing should blank while it does. The answer carries the
 * range it covers (`range`), so what is computed from it uses that range, not the new one. A
 * different query (a new range or split), or a range that moved further (a page hidden for a
 * while), shows as loading: an old answer never passes for another query's or for the present.
 */
export function keepWhileLoading<T>(
  kept: { current: Kept<T> },
  query: SeriesQuery,
  loaded: Loaded<T>,
): Loaded<T> {
  const shape = queryShape(query)
  if (loaded.state === 'ready') {
    const answered = { ...loaded, range: query.range }
    kept.current = { shape, end: query.range.end, loaded: answered }
    return answered
  }
  const moved = query.range.end - (kept.current?.end ?? Number.NaN)
  if (
    loaded.state === 'loading' &&
    kept.current?.shape === shape &&
    moved > 0 &&
    moved <= query.stepSeconds * 1000
  ) {
    return kept.current.loaded
  }
  return loaded
}

function useSeriesPoll(apiBase: string, query: SeriesQuery | null): Loaded<Series[]> {
  const { series } = useContext(FirstPaintContext)
  const key = query === null ? null : queryKey(query)
  const url = key === null ? null : `${apiBase}/series?${key}`
  return usePolled<Series[]>(url, 5 * 60_000, key === null ? undefined : series[key])
}

/** Series for `query`, filled onto its step grid so a missing bucket counts as zero. */
export function useSeries(apiBase: string, query: SeriesQuery | null): Loaded<Series[]> {
  const loaded = useSeriesPoll(apiBase, query)
  const filled = useRef<{ from: Series[]; to: Series[] } | null>(null)
  const kept = useRef<Kept<Series[]>>(null)
  if (query === null) return loaded
  if (loaded.state !== 'ready') return keepWhileLoading(kept, query, loaded)
  if (filled.current?.from !== loaded.data) {
    filled.current = { from: loaded.data, to: fillSeries(loaded.data, query) }
  }
  return keepWhileLoading(kept, query, { ...loaded, data: filled.current.to })
}

/**
 * Readings of a gauge for `query`, as the source returned them: a missing bucket stays missing,
 * because a zero would read as a reset.
 */
export function useReadings(apiBase: string, query: SeriesQuery | null): Loaded<Series[]> {
  const loaded = useSeriesPoll(apiBase, query)
  const kept = useRef<Kept<Series[]>>(null)
  return query === null ? loaded : keepWhileLoading(kept, query, loaded)
}

/**
 * Series for `query` filled onto its step grid, plus when the raw data starts: the earliest point
 * the source returned, before filling turns missing buckets into zeros. The token charts use it
 * to tell "no tokens counted yet" from "no traffic".
 */
export function useCountedSeries(
  apiBase: string,
  query: SeriesQuery | null,
): { loaded: Loaded<Series[]>; firstAt: EpochMs | null } {
  const raw = useReadings(apiBase, query)
  const filled = useRef<{ from: Series[]; to: Series[]; firstAt: EpochMs | null } | null>(null)
  if (raw.state !== 'ready' || query === null) return { loaded: raw, firstAt: null }
  if (filled.current?.from !== raw.data) {
    let firstAt: EpochMs | null = null
    for (const s of raw.data)
      for (const [t] of s.points) if (firstAt === null || t < firstAt) firstAt = t
    filled.current = { from: raw.data, to: fillSeries(raw.data, query), firstAt }
  }
  return { loaded: { ...raw, data: filled.current.to }, firstAt: filled.current.firstAt }
}

/**
 * The newest data a query has delivered, kept while a changed query loads or fails, so what
 * depends on it does not drop to a fallback every time its range moves on.
 */
export function lastReady<T>(previous: T | null, loaded: Loaded<T>): T | null {
  return loaded.state === 'ready' ? loaded.data : previous
}

export function useLastReady<T>(loaded: Loaded<T>): T | null {
  const kept = useRef<T | null>(null)
  kept.current = lastReady(kept.current, loaded)
  return kept.current
}
