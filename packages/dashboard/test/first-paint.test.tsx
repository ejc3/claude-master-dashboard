// @vitest-environment jsdom
import { act, type ReactElement } from 'react'
import { hydrateRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  formatWhen,
  HOUR_MS,
  type MetricsSource,
  type ProfileStatus,
  timeZoneOrNull,
} from '../src/core/index'
import { createDemoSource } from '../src/demo/index'
import { DashboardPage, FIRST_QUERIES_BUDGET_MS } from '../src/next/index'
import { RunwayCard } from '../src/react/Runway'

// A moment two minutes into a five-minute step, so a step boundary is near but not crossed.
const NOW = Date.UTC(2026, 9, 9, 18, 2, 0)
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The page measures its charts with a ResizeObserver, which jsdom lacks. This one never reports
// a size, so a chart's plot stays undrawn in both renders; the text around it is what is compared.
class SilentResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let roots: Root[] = []

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
  vi.stubGlobal('ResizeObserver', SilentResizeObserver)
  // Polls never answer: whatever the page shows comes from the server's render.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(() => {})),
  )
})

afterEach(() => {
  for (const root of roots) act(() => root.unmount())
  roots = []
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function serverPage(
  timeZone: string | undefined,
  source: MetricsSource = createDemoSource({ now: () => NOW }),
): Promise<ReactElement> {
  return (await DashboardPage({
    source: () => source,
    authorize: () => true,
    unauthorized: null,
    apiBase: '/api/claude-master',
    timeZone,
  })) as ReactElement
}

/** Renders on the "server", then hydrates that HTML in the "browser". */
async function hydrated(timeZone: string | undefined) {
  const element = await serverPage(timeZone)
  const html = renderToString(element)
  const container = document.createElement('div')
  container.innerHTML = html
  document.body.append(container)
  const serverText = container.textContent ?? ''
  // React reports a text mismatch as recoverable, and an attribute mismatch on the console.
  const recoverable: unknown[] = []
  const consoleErrors = vi.spyOn(console, 'error').mockImplementation(() => {})
  act(() => {
    roots.push(hydrateRoot(container, element, { onRecoverableError: (e) => recoverable.push(e) }))
  })
  recoverable.push(...consoleErrors.mock.calls)
  consoleErrors.mockRestore()
  return { container, serverText, recoverable }
}

const kpiValues = (root: ParentNode) =>
  [...root.querySelectorAll('.cmd-kpi-value')].map((e) => e.textContent)

describe('the first paint', () => {
  it('is complete on the server: numbers, charts, the smoothed forecast and clock times', async () => {
    const container = document.createElement('div')
    container.innerHTML = renderToString(await serverPage(ZONE))
    const text = container.textContent ?? ''
    expect(kpiValues(container)).toHaveLength(4)
    expect(kpiValues(container)).not.toContain('—')
    expect(text).not.toContain('Loading…')
    // Tokens, not requests: the chart, the key number and the table's columns.
    expect(text).toContain('Tokens per 5 minutes, by subscription')
    expect(text).toContain('Tokens, last hour')
    expect(text).not.toContain('No token counts')
    const columns = [
      ...container.querySelectorAll('section[aria-labelledby="cmd-breakdown-title"] thead th'),
    ].map((e) => e.textContent)
    expect(columns).toEqual([
      'Person',
      'Input',
      'Output',
      'Cache read',
      'Cache write',
      'Share',
      'Trend',
    ])
    // The weekly burn rate from the last day's readings, not each window's average.
    expect(text).toContain('smoothed over up to the last 24 hours')
    // The person table, filled.
    expect(
      container.querySelectorAll('section[aria-labelledby="cmd-breakdown-title"] tbody tr').length,
    ).toBeGreaterThan(0)
    // A run-out at a clock time, not "Then".
    expect(text).not.toMatch(/Then[,;]/)
    // Each chart holds its plot's height before the browser measures its width and draws it.
    const charts = [...container.querySelectorAll<HTMLElement>('.cmd-chart')]
    expect(charts).toHaveLength(2)
    for (const chart of charts) expect(chart.style.minHeight).toBe('200px')
  })

  it('does not change when the browser takes over', async () => {
    // At the same instant: a later one would move the countdowns on, as the clock does.
    const { container, serverText, recoverable } = await hydrated(ZONE)
    expect(recoverable).toEqual([])
    expect(container.textContent).toBe(serverText)
  })

  it('answers every query the first screen makes, so the browser asks for none at once', async () => {
    await hydrated(ZONE)
    const asked = vi
      .mocked(fetch)
      .mock.calls.map(([input]) => String(input))
      .filter((url) => url.includes('/series?'))
    expect(asked).toEqual([])
  })

  it('keeps the numbers it has, unchanged, while a range moved on by one step loads', async () => {
    const { container } = await hydrated(ZONE)
    const before = kpiValues(container)
    // Past the next five-minute boundary: the key-number and chart ranges move, and nothing answers.
    act(() => {
      vi.advanceTimersByTime(4 * 60_000)
    })
    expect(container.textContent).not.toContain('Loading…')
    // The same numbers: computed over the hours the kept answer covers, not the new range's.
    expect(kpiValues(container)).toEqual(before)
  })

  it('shows loading, not stale or zero numbers, after the page was away for hours', async () => {
    const { container } = await hydrated(ZONE)
    act(() => {
      vi.setSystemTime(NOW + 3 * HOUR_MS)
      vi.advanceTimersByTime(1000)
    })
    const values = kpiValues(container)
    expect(values.slice(0, 2)).toEqual(['—', '—'])
    expect(container.textContent).toContain('Loading…')
  })

  it('renders clock times in the reported zone, not the server process zone', async () => {
    const far = 'Pacific/Kiritimati' // UTC+14: no test machine runs in it
    expect(far).not.toBe(ZONE)
    const snapshot = await createDemoSource({ now: () => NOW }).snapshot()
    const resetsAt = snapshot.profiles[0]?.weekly.resetsAt
    if (resetsAt == null) throw new Error('the demo has no weekly reset')
    const { serverText, recoverable } = await hydrated(far)
    expect(serverText).toContain(`, ${formatWhen(resetsAt, NOW, far)}`)
    expect(serverText).not.toContain(`, ${formatWhen(resetsAt, NOW, ZONE)}`)
    // The browser then shows its own zone (the viewer moved); that is an update, not a mismatch.
    expect(recoverable).toEqual([])
  })

  it('without a reported time zone, renders countdowns only and adds clock times in the browser', async () => {
    const { container, serverText, recoverable } = await hydrated(undefined)
    expect(serverText).toMatch(/Then[,;]/)
    expect(recoverable).toEqual([])
    expect(container.textContent).not.toMatch(/Then[,;]/)
    // The browser reports its zone for the next visit.
    expect(document.cookie).toContain(`cmd-tz=${encodeURIComponent(ZONE)}`)
  })
})

describe('the server render', () => {
  it('renders the page when a source throws instead of rejecting', async () => {
    const demo = createDemoSource({ now: () => NOW })
    const throwing: MetricsSource = {
      snapshot: () => demo.snapshot(),
      series: () => {
        throw new Error('broken source')
      },
    }
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const container = document.createElement('div')
    container.innerHTML = renderToString(await serverPage(ZONE, throwing))
    errors.mockRestore()
    expect(container.textContent).toContain('Subscriptions')
    expect(kpiValues(container)[0]).toBe('—')
  })

  it('does not wait past its budget for a query; the browser asks for it', async () => {
    const demo = createDemoSource({ now: () => NOW })
    const hanging: MetricsSource = {
      snapshot: () => demo.snapshot(),
      series: () => new Promise(() => {}),
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const page = serverPage(ZONE, hanging)
    await vi.advanceTimersByTimeAsync(FIRST_QUERIES_BUDGET_MS)
    const container = document.createElement('div')
    container.innerHTML = renderToString(await page)
    warn.mockRestore()
    expect(container.textContent).toContain('Subscriptions')
    expect(kpiValues(container)[0]).toBe('—')
  })
})

describe('timeZoneOrNull', () => {
  it('takes an IANA zone the formatter accepts and nothing else', () => {
    expect(timeZoneOrNull('America/Los_Angeles')).toBe('America/Los_Angeles')
    expect(timeZoneOrNull('UTC')).toBe('UTC')
    expect(timeZoneOrNull('Etc/GMT+8')).toBe('Etc/GMT+8')
    expect(timeZoneOrNull('Mars/Olympus_Mons')).toBeNull()
    expect(timeZoneOrNull('UTC; path=/')).toBeNull()
    expect(timeZoneOrNull('')).toBeNull()
    expect(timeZoneOrNull(undefined)).toBeNull()
    expect(timeZoneOrNull('A'.repeat(65))).toBeNull()
  })
})

describe('the login line', () => {
  const profile = (tokenExpiresAt: number | null): ProfileStatus => ({
    profile: 'alpha',
    band: 'ok',
    weekly: { usedFraction: 0.4, resetsAt: NOW + 50 * HOUR_MS, lengthMs: 168 * HOUR_MS },
    fiveHour: null,
    rateLimitedUntil: null,
    tokenExpiresAt,
    latencyMs: { p50: null, p95: null, p99: null },
  })
  const line = (tokenExpiresAt: number | null) => {
    const container = document.createElement('div')
    container.innerHTML = renderToString(<RunwayCard status={profile(tokenExpiresAt)} now={NOW} />)
    return [...container.querySelectorAll('.cmd-row-meta span')]
      .map((e) => e.textContent ?? '')
      .find((t) => t.includes('Login'))
  }

  it('says nothing while the login renews on schedule', () => {
    // claude-master renews with four hours left, so a fresh token reads 4 to 8 hours.
    expect(line(NOW + 4 * HOUR_MS + 8 * 60_000)).toBeUndefined()
    expect(line(NOW + 3 * HOUR_MS + 10 * 60_000)).toBeUndefined()
    expect(line(null)).toBeUndefined()
  })

  it('warns when a renewal is overdue', () => {
    expect(line(NOW + 2 * HOUR_MS + 30 * 60_000)).toBe('Login not renewed; expires in 2h 30m')
  })
})
