import { describe, expect, it, vi } from 'vitest'
import { HOUR_MS, type MetricsSource, seriesQueryToParams } from '../src/core/index'
import { createDemoSource } from '../src/demo/index'
import { createDashboardHandler } from '../src/next/index'

const NOW = Date.UTC(2026, 9, 9, 12)
const demo = createDemoSource({ now: () => NOW })
const base = 'https://example.test/api/claude-master'
const series = (params: Record<string, string>) => `${base}/series?${new URLSearchParams(params)}`
const ok = seriesQueryToParams({
  metric: 'requests',
  groupBy: 'profile',
  range: { start: NOW - HOUR_MS, end: NOW },
  stepSeconds: 300,
})

function handler(authorized: boolean, source: MetricsSource = demo) {
  return createDashboardHandler({ source: () => source, authorize: () => authorized }).GET
}

describe('createDashboardHandler', () => {
  it('serves the snapshot and series to an authorized request, never cached', async () => {
    const GET = handler(true)
    const snapshot = await GET(new Request(`${base}/snapshot`))
    expect(snapshot.status).toBe(200)
    expect(snapshot.headers.get('cache-control')).toBe('private, no-store')
    expect((await snapshot.json()).profiles).toHaveLength(4)
    const response = await GET(new Request(`${base}/series?${ok}`))
    expect(response.status).toBe(200)
    expect((await response.json()).map((s: { key: string }) => s.key)).toContain('alpha')
  })

  it('refuses an unauthorized request before touching the source', async () => {
    const source = { snapshot: vi.fn(), series: vi.fn() }
    const response = await handler(false, source)(new Request(`${base}/snapshot`))
    expect(response.status).toBe(401)
    expect(source.snapshot).not.toHaveBeenCalled()
  })

  it('answers 400 with the reason for a query no source should run', async () => {
    const GET = handler(true)
    for (const url of [
      series({ metric: 'secrets', start: '0', end: '60000', step: '60' }),
      series({
        metric: 'errors',
        groupBy: 'model',
        start: String(NOW - HOUR_MS),
        end: String(NOW),
        step: '300',
      }),
      series({ metric: 'requests', start: String(NOW - HOUR_MS), end: String(NOW), step: '-60' }),
    ]) {
      const response = await GET(new Request(url))
      expect(response.status, url).toBe(400)
      expect(typeof (await response.json()).error).toBe('string')
    }
  })

  it('answers 502 without passing on what the source said', async () => {
    const failing: MetricsSource = {
      snapshot: () =>
        Promise.reject(new Error('AccessDenied for arn:aws:iam::000000000000:role/x')),
      series: () => Promise.reject(new Error('throttled')),
    }
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = await handler(true, failing)(new Request(`${base}/snapshot`))
    expect(response.status).toBe(502)
    expect(JSON.stringify(await response.json())).not.toContain('arn:aws')
    log.mockRestore()
  })

  it('answers 404 for anything else', async () => {
    expect((await handler(true)(new Request(`${base}/secrets`))).status).toBe(404)
  })
})

describe('DashboardPage', () => {
  it('renders without a first snapshot when the source fails, so the browser can retry', async () => {
    const { DashboardPage } = await import('../src/next/index')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing: MetricsSource = {
      snapshot: () => Promise.reject(new Error('throttled')),
      series: () => Promise.reject(new Error('throttled')),
    }
    const element = (await DashboardPage({
      source: () => failing,
      authorize: () => true,
      unauthorized: 'sign in',
      apiBase: '/api/claude-master',
    })) as { props: { initialSnapshot: unknown } }
    expect(element.props.initialSnapshot).toBeNull()
    log.mockRestore()
  })

  it('shows the unauthorized content and never asks the source', async () => {
    const { DashboardPage } = await import('../src/next/index')
    const source = { snapshot: vi.fn(), series: vi.fn() }
    const element = await DashboardPage({
      source: () => source,
      authorize: () => false,
      unauthorized: 'sign in',
      apiBase: '/api/claude-master',
    })
    expect(element).toBe('sign in')
    expect(source.snapshot).not.toHaveBeenCalled()
  })
})
