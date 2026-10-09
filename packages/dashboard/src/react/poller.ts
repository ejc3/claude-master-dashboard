import type { EpochMs } from '../core'

export interface PollFailure {
  message: string
  /** The HTTP status, or null when the request never got an answer. */
  status: number | null
}

/** What one URL has produced so far: the last good data, and the last failure if newer. */
export interface PollState<T> {
  url: string
  data?: T
  at?: EpochMs
  failure?: PollFailure
}

export interface PollerOptions<T> {
  url: string
  everyMs: number
  /** Wait one period before the first request (the page already rendered this data). */
  delayFirst: boolean
  fetch: (url: string, init: RequestInit) => Promise<Response>
  onChange: (state: PollState<T>) => void
  /** The state to build on, when it belongs to the same URL. */
  previous?: PollState<T> | undefined
  now?: () => EpochMs
}

async function readFailure(response: Response): Promise<PollFailure> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null
  const message =
    typeof body?.error === 'string'
      ? body.error
      : `The dashboard server answered ${response.status}.`
  return { message, status: response.status }
}

/**
 * Fetches `url` and then again `everyMs` after each answer: one request at a time, so an old
 * answer can never land after a newer one. A failure keeps the last good data and reports
 * itself beside it.
 */
export function startPoller<T>(options: PollerOptions<T>): () => void {
  const now = options.now ?? Date.now
  let state: PollState<T> =
    options.previous?.url === options.url ? options.previous : { url: options.url }
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const controller = new AbortController()

  const commit = (next: PollState<T>) => {
    if (stopped) return
    state = next
    options.onChange(state)
  }

  const schedule = (ms: number) => {
    if (!stopped) timer = setTimeout(run, ms)
  }

  async function run() {
    try {
      const response = await options.fetch(options.url, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      })
      if (!response.ok) {
        commit({ ...state, failure: await readFailure(response) })
      } else {
        const data = (await response.json()) as T
        commit({ url: options.url, data, at: now() })
      }
    } catch (error) {
      if (stopped) return
      const message = error instanceof Error ? error.message : 'The request failed.'
      commit({ ...state, failure: { message, status: null } })
    }
    schedule(options.everyMs)
  }

  schedule(options.delayFirst ? options.everyMs : 0)
  return () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    controller.abort()
  }
}
