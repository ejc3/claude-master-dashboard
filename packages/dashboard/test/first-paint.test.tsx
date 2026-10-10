// @vitest-environment jsdom
import { act, type ReactElement } from 'react'
import { createRoot, hydrateRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  formatCount,
  formatWhen,
  HOUR_MS,
  type MetricsSource,
  type ProfileStatus,
  poolGaps,
  seriesQueryFromParams,
  timeZoneOrNull,
} from '../src/core/index'
import { createDemoSource } from '../src/demo/index'
import { DashboardPage, FIRST_QUERIES_BUDGET_MS } from '../src/next/index'
import { keepWhileLoading, type Loaded } from '../src/react/hooks'
import { CapacityOutlook, PoolAccounts, shortNames } from '../src/react/Pool'
import { chartQuery, firstQueries } from '../src/react/queries'
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
  keepAlive: (work: Promise<unknown>) => void = () => {},
): Promise<ReactElement> {
  return (await DashboardPage({
    source: () => source,
    authorize: () => true,
    unauthorized: null,
    apiBase: '/api/claude-master',
    timeZone,
    keepAlive,
  })) as ReactElement
}

/** Renders on the "server", then hydrates that HTML in the "browser". */
async function hydrated(timeZone: string | undefined, browserClock?: number) {
  const element = await serverPage(timeZone)
  const html = renderToString(element)
  if (browserClock !== undefined) vi.setSystemTime(browserClock)
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
    // The two capacity charts at the top, then the two traffic charts.
    expect(charts).toHaveLength(4)
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

  it('changes nothing when the browser clock is behind the server, across a step boundary', async () => {
    // The server renders a second after a five-minute boundary; the browser's clock reads a
    // second before it, so its ranges would end a step earlier than the server's answers.
    const serverAt = Date.UTC(2026, 9, 9, 18, 5, 1)
    vi.setSystemTime(serverAt)
    const element = await serverPage(ZONE, createDemoSource({ now: () => serverAt }))
    const container = document.createElement('div')
    container.innerHTML = renderToString(element)
    document.body.append(container)
    const serverText = container.textContent ?? ''
    vi.setSystemTime(serverAt - 2000)
    act(() => {
      roots.push(hydrateRoot(container, element))
    })
    expect(container.textContent).toBe(serverText)
    const asked = vi
      .mocked(fetch)
      .mock.calls.filter(([input]) => String(input).includes('/series?'))
    expect(asked).toEqual([])
  })

  it('follows the browser clock again once it catches up with the server', async () => {
    // Ten minutes behind at first; then the browser's clock is corrected, a minute later.
    const serverAt = Date.UTC(2026, 9, 9, 18, 5, 1)
    vi.setSystemTime(serverAt)
    const element = await serverPage(ZONE, createDemoSource({ now: () => serverAt }))
    const container = document.createElement('div')
    container.innerHTML = renderToString(element)
    document.body.append(container)
    vi.setSystemTime(serverAt - 10 * 60_000)
    act(() => {
      roots.push(hydrateRoot(container, element))
    })
    await act(async () => {
      vi.setSystemTime(serverAt + 60_000)
      await vi.advanceTimersByTimeAsync(1000)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    // At 18:06 every range still ends at 18:05: none asks for buckets from the future.
    const ends = vi
      .mocked(fetch)
      .mock.calls.map(([input]) => new URL(String(input), 'http://localhost'))
      .filter((url) => url.pathname.endsWith('/series'))
      .map((url) => Number(url.searchParams.get('end')))
    expect(Math.max(0, ...ends)).toBeLessThanOrEqual(Date.UTC(2026, 9, 9, 18, 5))
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
    const kept: Array<Promise<unknown>> = []
    const page = serverPage(ZONE, hanging, (work) => kept.push(work))
    await vi.advanceTimersByTimeAsync(FIRST_QUERIES_BUDGET_MS)
    const container = document.createElement('div')
    container.innerHTML = renderToString(await page)
    warn.mockRestore()
    expect(container.textContent).toContain('Subscriptions')
    expect(kpiValues(container)[0]).toBe('—')
    // Each query it stopped waiting for keeps running after the page is sent, so a runtime does
    // not cancel it while a shared cache holds it for the browser's request.
    expect(kept).toHaveLength(firstQueries(NOW).length)
  })

  it('keeps nothing alive when every query answers in time', async () => {
    const kept: Array<Promise<unknown>> = []
    await serverPage(ZONE, createDemoSource({ now: () => NOW }), (work) => kept.push(work))
    expect(kept).toEqual([])
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

describe('keepWhileLoading', () => {
  const ready = (data: string[]): Loaded<string[]> => ({
    state: 'ready',
    data,
    at: 0,
    failure: null,
  })
  const at = Date.UTC(2026, 9, 10, 12, 4, 59)

  it('keeps an answer while the same query, a step on, loads', () => {
    const kept = { current: null }
    keepWhileLoading(
      kept,
      chartQuery(at, '24h', { metric: 'tokens', groupBy: 'profile' }),
      ready(['all']),
    )
    const next = chartQuery(at + 2000, '24h', { metric: 'tokens', groupBy: 'profile' })
    expect(keepWhileLoading(kept, next, { state: 'loading' })).toMatchObject({ data: ['all'] })
  })

  it('never shows the answer for one token type as another', () => {
    const kept = { current: null }
    keepWhileLoading(
      kept,
      chartQuery(at, '24h', { metric: 'tokens', groupBy: 'profile' }),
      ready(['all']),
    )
    // The viewer picks Input, and the step boundary passes before it answers.
    const input = chartQuery(at + 2000, '24h', {
      metric: 'tokens',
      groupBy: 'profile',
      tokenType: 'input',
    })
    expect(keepWhileLoading(kept, input, { state: 'loading' })).toEqual({ state: 'loading' })
  })
})

describe('answers shown together, while a moved range loads', () => {
  // Hydrated at 18:02 (ranges end 18:00), then past 18:05: one query answers its moved range, the
  // others keep their answer from the range before.
  const STEP_ON = NOW + 3.5 * 60_000
  const demo = createDemoSource({ now: () => STEP_ON })

  /** Answers the series requests `fresh` picks from the demo source; the rest never answer. */
  function answer(fresh: (params: URLSearchParams) => boolean) {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://localhost')
      if (!url.pathname.endsWith('/series') || !fresh(url.searchParams)) {
        return new Promise<Response>(() => {})
      }
      return Response.json(await demo.series(seriesQueryFromParams(url.searchParams)))
    })
  }

  async function stepOn(fresh: (params: URLSearchParams) => boolean) {
    const page = await hydrated(ZONE)
    answer(fresh)
    await act(async () => {
      vi.setSystemTime(STEP_ON)
      await vi.advanceTimersByTimeAsync(1000)
    })
    // The moved queries' polls start, and the fresh ones answer.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    return page
  }

  it('the error-rate chart has only hours both answers cover', async () => {
    const { container } = await stepOn(
      (p) => p.get('metric') === 'requests' && p.get('groupBy') === 'profile',
    )
    const figure = [...container.querySelectorAll('figure')].find((f) =>
      f.textContent?.includes('Error rate per hour'),
    )
    const toggle = figure?.querySelector('button')
    if (figure === undefined || toggle == null) throw new Error('no error-rate chart')
    act(() => toggle.click())
    const hours = [...figure.querySelectorAll('tbody tr td:first-child')].map((e) => e.textContent)
    // 18:00 is in the new requests answer only; the kept errors answer ends there.
    const sixPm = formatWhen(Date.UTC(2026, 9, 9, 18), STEP_ON)
    expect(hours.length).toBeGreaterThan(0)
    expect(hours).not.toContain(sixPm)
  })

  it('the key error rate keeps to an hour both answers cover', async () => {
    const rateTile = (root: ParentNode) => root.querySelectorAll('.cmd-kpi')[1]?.textContent
    const before = rateTile((await hydrated(ZONE)).container)
    for (const root of roots) act(() => root.unmount())
    roots = []
    document.body.innerHTML = ''
    vi.setSystemTime(NOW)
    const { container } = await stepOn(
      (p) => p.get('metric') === 'requests' && p.get('groupBy') === null,
    )
    // The rate and its error count, over the same hour as before the step.
    expect(rateTile(container)).toBe(before)
  })

  it('the table adds token types over the range all four answers cover', async () => {
    const { container } = await stepOn((p) => p.get('type') === 'input')
    const rows = [
      ...container.querySelectorAll('section[aria-labelledby="cmd-breakdown-title"] tbody tr'),
    ]
    const first = rows[0]
    const person = first?.querySelector('th')?.textContent
    const input = first?.querySelector('td')?.textContent
    if (person == null || input == null) throw new Error('no table row')
    // Input over the range every type covers: from the new start to the kept answers' end.
    const newEnd = Date.UTC(2026, 9, 9, 18, 5)
    const oldEnd = Date.UTC(2026, 9, 9, 18, 0)
    const [inputSeries] = (
      await demo.series({
        metric: 'tokens',
        tokenType: 'input',
        groupBy: 'client_account',
        range: { start: newEnd - 24 * HOUR_MS, end: newEnd },
        stepSeconds: 300,
      })
    ).filter((s) => s.key === person)
    const shared = (inputSeries?.points ?? [])
      .filter(([t]) => t >= newEnd - 24 * HOUR_MS && t < oldEnd)
      .reduce((sum, [, v]) => sum + v, 0)
    expect(input).toBe(formatCount(shared))
  })
})

describe('the status badge', () => {
  it('says a subscription Anthropic is rate-limiting is rate limited, and when it takes work again', () => {
    const status: ProfileStatus = {
      profile: 'alpha',
      band: 'ok',
      weekly: { usedFraction: 0.3, resetsAt: NOW + 50 * HOUR_MS, lengthMs: 168 * HOUR_MS },
      fiveHour: null,
      rateLimitedUntil: NOW + 106 * 60_000,
      tokenExpiresAt: null,
      latencyMs: { p50: null, p95: null, p99: null },
    }
    const container = document.createElement('div')
    container.innerHTML = renderToString(<RunwayCard status={status} now={NOW} />)
    const badge = container.querySelector('.cmd-status')
    expect(badge?.textContent).toBe('Rate limited')
    expect(badge?.getAttribute('data-status')).toBe('rate-limited')
    expect(container.textContent).toContain('Takes work again in 1h 46m')
    expect(container.textContent).not.toMatch(/cool/i)
  })
})

describe('the 5-hour row', () => {
  it('says no window is open once the read window has reset, not its old use', () => {
    const status: ProfileStatus = {
      profile: 'alpha',
      band: 'ok',
      weekly: { usedFraction: 0.3, resetsAt: NOW + 50 * HOUR_MS, lengthMs: 168 * HOUR_MS },
      fiveHour: { usedFraction: 1, resetsAt: NOW - HOUR_MS, lengthMs: 5 * HOUR_MS },
      rateLimitedUntil: null,
      tokenExpiresAt: null,
      latencyMs: { p50: null, p95: null, p99: null },
    }
    const container = document.createElement('div')
    container.innerHTML = renderToString(<RunwayCard status={status} now={NOW} />)
    expect(container.textContent).toContain('No window open')
    expect(container.textContent).not.toContain('100%')
  })

  it('says the reset time is unknown, not that no window is open, when none was read', () => {
    const status: ProfileStatus = {
      profile: 'alpha',
      band: 'ok',
      weekly: { usedFraction: 0, resetsAt: null, lengthMs: 168 * HOUR_MS },
      fiveHour: { usedFraction: 0, resetsAt: null, lengthMs: 5 * HOUR_MS },
      rateLimitedUntil: null,
      tokenExpiresAt: null,
      latencyMs: { p50: null, p95: null, p99: null },
    }
    const container = document.createElement('div')
    container.innerHTML = renderToString(<RunwayCard status={status} now={NOW} />)
    expect(container.textContent).not.toContain('No window open')
    expect(container.textContent?.match(/Reset time unknown/g)).toHaveLength(2)
  })
})

describe('the account bars', () => {
  const sub = (
    profile: string,
    weekly: number,
    five: number | null,
    extra: Partial<ProfileStatus> = {},
  ): ProfileStatus => ({
    profile,
    band: 'ok',
    weekly: { usedFraction: weekly, resetsAt: NOW + 50 * HOUR_MS, lengthMs: 168 * HOUR_MS },
    fiveHour:
      five === null ? null : { usedFraction: five, resetsAt: NOW + HOUR_MS, lengthMs: 5 * HOUR_MS },
    rateLimitedUntil: null,
    tokenExpiresAt: null,
    latencyMs: { p50: null, p95: null, p99: null },
    ...extra,
  })

  it('shows each subscription by short name, its week and 5-hour use, and whether it can work', () => {
    const container = document.createElement('div')
    container.innerHTML = renderToString(
      <PoolAccounts
        profiles={[
          sub('team-alpha', 0.52, 0.96),
          sub('team-bravo', 1, null),
          sub('team-charlie', 0.27, null, { rateLimitedUntil: NOW + HOUR_MS }),
          // Full when read, but its window has reset since.
          sub('team-delta', 0.4, 1, {
            fiveHour: { usedFraction: 1, resetsAt: NOW - 1, lengthMs: 5 * HOUR_MS },
          }),
        ]}
        now={NOW}
      />,
    )
    const items = [...container.querySelectorAll('.cmd-account')]
    expect(items.map((e) => e.querySelector('.cmd-account-name')?.textContent)).toEqual([
      'alpha',
      'bravo',
      'charlie',
      'delta',
    ])
    expect(items.map((e) => e.getAttribute('data-open'))).toEqual([
      'true',
      'false',
      'false',
      'true',
    ])
    const levels = (e: Element) =>
      [...e.querySelectorAll('.cmd-account-bar')].map((b) => b.getAttribute('data-level'))
    expect(items.map(levels)).toEqual([
      ['ok', 'high'],
      ['full', 'unknown'],
      ['ok', 'unknown'],
      ['ok', 'ok'],
    ])
    // Read out in full for a screen reader.
    expect(items[0]?.textContent).toContain('team-alpha: week 52%, 5-hour 96%')
    expect(items[1]?.textContent).toContain(
      'team-bravo: week 100%, 5-hour no reading, cannot take work now',
    )
  })

  it('shortens names only by a shared prefix ending at a separator', () => {
    expect([...shortNames(['claude-a', 'claude-b']).values()]).toEqual(['a', 'b'])
    expect([...shortNames(['alpha', 'alpine']).values()]).toEqual(['alpha', 'alpine'])
    expect([...shortNames(['solo-one']).values()]).toEqual(['solo-one'])
  })
})

describe('the capacity charts', () => {
  it('show what is left of each window, weekly to the furthest reset and 5-hour over a day', () => {
    const profile = (name: string, weeklyResetIn: number): ProfileStatus => ({
      profile: name,
      band: 'ok',
      weekly: { usedFraction: 0.5, resetsAt: NOW + weeklyResetIn, lengthMs: 168 * HOUR_MS },
      fiveHour: { usedFraction: 0.2, resetsAt: NOW + HOUR_MS, lengthMs: 5 * HOUR_MS },
      rateLimitedUntil: null,
      tokenExpiresAt: null,
      latencyMs: { p50: null, p95: null, p99: null },
    })
    const profiles = [profile('a', 30 * HOUR_MS), profile('b', 60 * HOUR_MS)]
    const gaps = poolGaps(
      profiles,
      NOW,
      new Map([
        ['a', 0.01],
        ['b', 0.01],
      ]),
      NOW,
    )
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    act(() => root.render(<CapacityOutlook gaps={gaps} profiles={profiles} now={NOW} />))
    const figures = [...container.querySelectorAll('figure')]
    expect(figures.map((f) => f.querySelector('figcaption')?.textContent)).toEqual([
      'Weekly allowance left, at this pace',
      '5-hour capacity left, next 24 hours',
    ])
    const rows = (figure: Element) => {
      act(() => (figure.querySelector('button') as HTMLButtonElement).click())
      return [...figure.querySelectorAll('tbody tr')].map(
        (r) => r.querySelector('td:last-child')?.textContent,
      )
    }
    const weekly = rows(figures[0] as Element)
    const five = rows(figures[1] as Element)
    // Every ten minutes from now: to the reset 60 hours out, and over the next 24 hours.
    expect(weekly).toHaveLength(60 * 6 + 1)
    expect(five).toHaveLength(24 * 6 + 1)
    // Newest last in time, listed first: the weekly line starts at what is left now, 100%.
    expect(weekly.at(-1)).toBe('100%')
    expect(five.at(-1)).toBe('160%')
  })
})
