'use client'

import { type RefObject, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  type EpochMs,
  fillSeries,
  type Series,
  type SeriesQuery,
  type Snapshot,
  seriesQueryToParams,
} from '../core'
import { type PollFailure, type PollState, startPoller } from './poller'

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

/**
 * False during server rendering and hydration, true after. Wall-clock text depends on the
 * viewer's time zone, which the server does not know, so it renders only once this is true.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  )
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
  | { state: 'ready'; data: T; at: EpochMs; failure: PollFailure | null }
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

/** Series for `query`, filled onto its step grid so a missing bucket counts as zero. */
export function useSeries(apiBase: string, query: SeriesQuery | null): Loaded<Series[]> {
  const url = query === null ? null : `${apiBase}/series?${seriesQueryToParams(query)}`
  const loaded = usePolled<Series[]>(url, 5 * 60_000)
  const filled = useRef<{ from: Series[]; to: Series[] } | null>(null)
  if (loaded.state !== 'ready' || query === null) return loaded
  if (filled.current?.from !== loaded.data) {
    filled.current = { from: loaded.data, to: fillSeries(loaded.data, query) }
  }
  return { ...loaded, data: filled.current.to }
}

/**
 * Readings of a gauge for `query`, as the source returned them: a missing bucket stays missing,
 * because a zero would read as a reset.
 */
export function useReadings(apiBase: string, query: SeriesQuery | null): Loaded<Series[]> {
  const url = query === null ? null : `${apiBase}/series?${seriesQueryToParams(query)}`
  return usePolled<Series[]>(url, 5 * 60_000)
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
