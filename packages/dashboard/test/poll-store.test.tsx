// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePrefetch } from '../src/react/hooks'
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

describe('loading in the background', () => {
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
