// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PREFETCH_PATIENCE_MS, usePrefetch } from '../src/react/hooks'
import { createPollStore, type PollStore, PollStoreContext } from '../src/react/pollStore'

const MINUTE = 60_000

beforeEach(() => {
  vi.useFakeTimers()
})

const roots: Root[] = []
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount())
  document.body.innerHTML = ''
  vi.useRealTimers()
})

/** A fetch that answers each URL when the test says so, and records the order it was asked in. */
function gatedFetch() {
  const asked: string[] = []
  const pending = new Map<string, (r: Response) => void>()
  const fetchFn = (url: string) => {
    asked.push(url)
    return new Promise<Response>((resolve) => pending.set(url, resolve))
  }
  const release = async (url: string) => {
    pending.get(url)?.(Response.json({ url }))
    pending.delete(url)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
  }
  return { asked, fetchFn, release }
}

describe('the poll store', () => {
  it('runs one poller per URL for every reader, and stops it with the last one', async () => {
    const { asked, fetchFn, release } = gatedFetch()
    const store = createPollStore(fetchFn)
    const seen: string[] = []
    const stopA = store.subscribe('/a', () => seen.push('a1'), 5 * MINUTE)
    const stopB = store.subscribe('/a', () => seen.push('a2'), 5 * MINUTE)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(asked).toEqual(['/a'])
    await release('/a')
    expect(seen).toEqual(['a1', 'a2'])
    expect(store.get('/a')?.data).toEqual({ url: '/a' })
    stopA()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * MINUTE)
    })
    // Still read and polled by the other reader.
    expect(asked).toEqual(['/a', '/a'])
    stopB()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20 * MINUTE)
    })
    expect(asked).toEqual(['/a', '/a'])
    // Nothing reads or polls it: forgotten.
    expect(store.get('/a')).toBeUndefined()
  })

  it('keeps an answer when its reader resubscribes in the same update', async () => {
    const { fetchFn, release } = gatedFetch()
    const store = createPollStore(fetchFn)
    const stop = store.subscribe('/a', () => {}, 5 * MINUTE)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    await release('/a')
    // React swaps a subscription by unsubscribing first (the page hidden or shown again).
    stop()
    const again = store.subscribe('/a', () => {})
    // After the update has settled, the answer is still there for the new subscription.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(store.get('/a')?.data).toEqual({ url: '/a' })
    again()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(store.get('/a')).toBeUndefined()
  })

  it('waits a period before fetching an answer the server rendered', async () => {
    const { asked, fetchFn } = gatedFetch()
    const store = createPollStore(fetchFn)
    store.seed('/a', { served: true }, Date.now())
    const stop = store.subscribe('/a', () => {}, 5 * MINUTE)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MINUTE)
    })
    expect(asked).toEqual([])
    expect(store.get('/a')?.data).toEqual({ served: true })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * MINUTE)
    })
    expect(asked).toEqual(['/a'])
    stop()
  })
})

function Prefetcher(props: { urls: string[]; enabled: boolean }) {
  usePrefetch(props.urls, 5 * MINUTE, props.enabled)
  return null
}

function mount(store: PollStore, urls: string[], enabled: boolean) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  const render = (on: boolean) =>
    act(() =>
      root.render(
        <PollStoreContext.Provider value={store}>
          <Prefetcher urls={urls} enabled={on} />
        </PollStoreContext.Provider>,
      ),
    )
  render(enabled)
  return render
}

describe('loading in the background', () => {
  it('moves on from a URL that does not answer', async () => {
    const { asked, fetchFn } = gatedFetch()
    const store = createPollStore(fetchFn)
    mount(store, ['/stuck', '/next'], true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(asked).toEqual(['/stuck'])
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREFETCH_PATIENCE_MS + 1)
    })
    expect(asked).toEqual(['/stuck', '/next'])
  })

  it('advances once per URL, even when one answers after the queue moved on', async () => {
    const { asked, fetchFn, release } = gatedFetch()
    const store = createPollStore(fetchFn)
    mount(store, ['/slow', '/b', '/c'], true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREFETCH_PATIENCE_MS + 1)
    })
    expect(asked).toEqual(['/slow', '/b'])
    // The slow one answers late: it must not start /c while /b is still waiting.
    await release('/slow')
    expect(asked).toEqual(['/slow', '/b'])
    await release('/b')
    expect(asked).toEqual(['/slow', '/b', '/c'])
  })

  it('starts only once enabled, then loads one URL at a time in order, and keeps them fresh', async () => {
    const { asked, fetchFn, release } = gatedFetch()
    const store = createPollStore(fetchFn)
    const render = mount(store, ['/1', '/2', '/3'], false)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MINUTE)
    })
    expect(asked).toEqual([])
    render(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(asked).toEqual(['/1'])
    await release('/1')
    expect(asked).toEqual(['/1', '/2'])
    await release('/2')
    await release('/3')
    expect(asked).toEqual(['/1', '/2', '/3'])
    expect(store.get('/3')?.data).toEqual({ url: '/3' })
    // Each one again, five minutes after its answer.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * MINUTE)
    })
    expect([...asked].sort()).toEqual(['/1', '/1', '/2', '/2', '/3', '/3'])
  })
})
