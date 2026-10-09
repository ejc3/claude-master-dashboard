'use client'

import { type RefObject, useEffect, useRef, useState } from 'react'
import {
  type EpochMs,
  type Series,
  type SeriesQuery,
  type Snapshot,
  seriesQueryToParams,
} from '../core/index'

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
  | { state: 'ready'; data: T; at: EpochMs }
  | { state: 'error'; message: string }

async function getJSON<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, headers: { accept: 'application/json' } })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `The dashboard server answered ${response.status}.`)
  }
  return (await response.json()) as T
}

/** Fetches `url` now and every `everyMs` while visible; keeps the last good data on failure. */
function usePolled<T>(url: string | null, everyMs: number, initial?: T): Loaded<T> {
  const [loaded, setLoaded] = useState<Loaded<T>>(
    initial === undefined
      ? { state: 'loading' }
      : { state: 'ready', data: initial, at: Date.now() },
  )
  const visible = useVisible()
  useEffect(() => {
    if (url === null || !visible) return
    const controller = new AbortController()
    const load = () =>
      getJSON<T>(url, controller.signal).then(
        (data) => setLoaded({ state: 'ready', data, at: Date.now() }),
        (error: unknown) => {
          if (controller.signal.aborted) return
          const message = error instanceof Error ? error.message : 'The request failed.'
          setLoaded((previous) =>
            previous.state === 'ready' ? previous : { state: 'error', message },
          )
        },
      )
    void load()
    const timer = setInterval(load, everyMs)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [url, everyMs, visible])
  return loaded
}

export function useSnapshot(apiBase: string, initial: Snapshot): Loaded<Snapshot> {
  return usePolled<Snapshot>(`${apiBase}/snapshot`, 60_000, initial)
}

export function useSeries(apiBase: string, query: SeriesQuery | null): Loaded<Series[]> {
  const url = query === null ? null : `${apiBase}/series?${seriesQueryToParams(query)}`
  return usePolled<Series[]>(url, 5 * 60_000)
}
