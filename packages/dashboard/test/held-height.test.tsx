// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { useHeldHeight } from '../src/react/hooks'

// jsdom lays nothing out: each row is given a height of 40px here.
const ROW = 40

function Body(props: { loading: boolean; rows: number }) {
  const [ref, held] = useHeldHeight<HTMLDivElement>(props.loading)
  return (
    <div ref={ref} data-testid="body" style={held === undefined ? undefined : { minHeight: held }}>
      {props.loading ? (
        <p>Loading…</p>
      ) : (
        Array.from({ length: props.rows }, (_, i) => `row-${i}`).map((k) => <p key={k}>{k}</p>)
      )}
    </div>
  )
}

const roots: Root[] = []
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount())
  document.body.innerHTML = ''
})

describe('useHeldHeight', () => {
  it('keeps the last loaded height while the next view loads, and lets go after', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    Object.defineProperty(HTMLDivElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLDivElement) {
        return this.querySelectorAll('p').length * ROW
      },
    })
    const body = () => container.querySelector<HTMLElement>('[data-testid="body"]') as HTMLElement
    // The first load has no height to keep.
    act(() => root.render(<Body loading rows={0} />))
    expect(body().style.minHeight).toBe('')
    // Five rows load: 200px.
    act(() => root.render(<Body loading={false} rows={5} />))
    expect(body().style.minHeight).toBe('')
    // Another tab: while it loads, the body keeps those 200px instead of shrinking to one line.
    act(() => root.render(<Body loading rows={0} />))
    expect(body().style.minHeight).toBe(`${5 * ROW}px`)
    // It loads two rows: the body takes their height again.
    act(() => root.render(<Body loading={false} rows={2} />))
    expect(body().style.minHeight).toBe('')
    act(() => root.render(<Body loading rows={0} />))
    expect(body().style.minHeight).toBe(`${2 * ROW}px`)
    Reflect.deleteProperty(HTMLDivElement.prototype, 'offsetHeight')
  })
})
