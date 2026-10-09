import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type PollState, startPoller } from '../src/react/poller'

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('startPoller', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('runs one request at a time, so a slow old answer never replaces a newer one', async () => {
    const states: Array<PollState<{ n: number }>> = []
    const pending: Array<(r: Response) => void> = []
    const fetch = vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve)))
    const stop = startPoller<{ n: number }>({
      url: '/x',
      everyMs: 1000,
      delayFirst: false,
      fetch,
      onChange: (s) => states.push(s),
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(1)
    // The first answer is slow; no second request starts while it is outstanding.
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetch).toHaveBeenCalledTimes(1)
    pending[0]?.(reply({ n: 1 }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetch).toHaveBeenCalledTimes(2)
    pending[1]?.(reply({ n: 2 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(states.map((s) => s.data?.n)).toEqual([1, 2])
    stop()
  })

  it('keeps the last good data beside a failure, and reports the status', async () => {
    const answers = [reply({ n: 1 }), reply({ error: 'Sign in again.' }, 401)]
    const states: Array<PollState<{ n: number }>> = []
    const stop = startPoller<{ n: number }>({
      url: '/x',
      everyMs: 1000,
      delayFirst: false,
      fetch: async () => answers.shift() ?? reply({ n: 3 }),
      onChange: (s) => states.push(s),
    })
    await vi.advanceTimersByTimeAsync(1000)
    const last = states.at(-1)
    expect(last?.data).toEqual({ n: 1 })
    expect(last?.failure).toEqual({ message: 'Sign in again.', status: 401 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(states.at(-1)).toMatchObject({ data: { n: 3 } })
    expect(states.at(-1)?.failure).toBeUndefined()
    stop()
  })

  it('waits one period first when the page already has the data, and stops cleanly', async () => {
    const fetch = vi.fn(async () => reply({ n: 1 }))
    const onChange = vi.fn()
    const stop = startPoller({ url: '/x', everyMs: 1000, delayFirst: true, fetch, onChange })
    await vi.advanceTimersByTimeAsync(999)
    expect(fetch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('reports nothing after it is stopped, even for an answer already on its way', async () => {
    let resolve: (r: Response) => void = () => {}
    const onChange = vi.fn()
    const stop = startPoller({
      url: '/x',
      everyMs: 1000,
      delayFirst: false,
      fetch: () => new Promise<Response>((r) => (resolve = r)),
      onChange,
    })
    await vi.advanceTimersByTimeAsync(0)
    stop()
    resolve(reply({ n: 1 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(onChange).not.toHaveBeenCalled()
  })
})
