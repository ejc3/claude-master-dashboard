import { describe, expect, it } from 'vitest'
import { createCloudWatchSource } from '../src/cloudwatch/index'
import {
  BadQueryError,
  firstPointAt,
  fromFirstBucket,
  HOUR_MS,
  insightsQuery,
  resolveMetric,
  type Series,
  type SeriesQuery,
  seriesQueryFromParams,
  seriesQueryToParams,
  TOKEN_TYPES,
  tokenCoverage,
  tokenRows,
  tokensBetween,
  UnsupportedQueryError,
} from '../src/core/index'
import { createDemoSource } from '../src/demo/index'
import { requestTable, tableRangeWords } from '../src/react/Breakdown'

const NOW = Date.UTC(2026, 9, 10, 6)
const STEP = 300
const range = { start: NOW - 2 * HOUR_MS, end: NOW }
const at = (minutesAgo: number) => NOW - minutesAgo * 60_000

describe('tokens in the catalog', () => {
  it('reads the token counters, filtered by type and split by subscription, person or machine', () => {
    expect(insightsQuery('ClaudeMaster', resolveMetric('tokens', 'profile'))).toBe(
      'SELECT SUM("claude_master.inference.tokens") FROM "ClaudeMaster" GROUP BY profile',
    )
    expect(insightsQuery('ClaudeMaster', resolveMetric('tokens', 'type'))).toBe(
      'SELECT SUM("claude_master.inference.tokens") FROM "ClaudeMaster" GROUP BY "type"',
    )
    expect(
      insightsQuery('ClaudeMaster', resolveMetric('tokens', 'client_account', 'cache_read')),
    ).toBe(
      `SELECT SUM("claude_master.inference.tokens.by_client_account") FROM "ClaudeMaster" WHERE "type" = 'cache_read' GROUP BY client_account`,
    )
    expect(insightsQuery('ClaudeMaster', resolveMetric('tokens', 'client', 'input'))).toBe(
      `SELECT SUM("claude_master.inference.tokens.by_client") FROM "ClaudeMaster" WHERE "type" = 'input' GROUP BY client`,
    )
  })

  it('has no token split by model, and no token type on another metric', () => {
    expect(() => resolveMetric('tokens', 'model')).toThrow(UnsupportedQueryError)
    expect(() => resolveMetric('requests', 'profile', 'input')).toThrow(UnsupportedQueryError)
  })
})

describe('the token type on the wire', () => {
  const query: SeriesQuery = {
    metric: 'tokens',
    groupBy: 'client',
    tokenType: 'cache_creation',
    range,
    stepSeconds: STEP,
  }

  it('round-trips', () => {
    expect(seriesQueryFromParams(seriesQueryToParams(query))).toEqual(query)
  })

  it('is refused on another metric, when unknown, or together with a split by type', () => {
    const params = (extra: Record<string, string>) =>
      new URLSearchParams({ ...Object.fromEntries(seriesQueryToParams(query)), ...extra })
    expect(() => seriesQueryFromParams(params({ metric: 'requests' }))).toThrow(BadQueryError)
    expect(() => seriesQueryFromParams(params({ type: "input' OR 1=1" }))).toThrow(BadQueryError)
    expect(() => seriesQueryFromParams(params({ groupBy: 'type' }))).toThrow(BadQueryError)
  })
})

describe('the CloudWatch source asks for one token type', () => {
  it('sends the filtered query and folds account codes into names', async () => {
    const expressions: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const body = JSON.parse(await (input as Request).clone().text()) as {
        MetricDataQueries: Array<{ Expression: string }>
      }
      expressions.push(body.MetricDataQueries[0]?.Expression ?? '')
      const point = (label: string, v: number) => ({
        Id: 'q',
        Label: label,
        Timestamps: [Math.floor(at(10) / 1000)],
        Values: [v],
        StatusCode: 'Complete',
      })
      return Response.json({
        MetricDataResults: [point('alpha', 1000), point('acct-0000aaaa', 500)],
      })
    }) as typeof fetch
    const src = createCloudWatchSource({
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'example-secret',
      region: 'us-test-1',
      fetch: fetchImpl,
      now: () => NOW,
      accountAliases: new Map([['acct-0000aaaa', 'alpha']]),
    })
    const series = await src.series({
      metric: 'tokens',
      groupBy: 'client_account',
      tokenType: 'output',
      range,
      stepSeconds: STEP,
    })
    expect(expressions).toEqual([
      `SELECT SUM("claude_master.inference.tokens.by_client_account") FROM "ClaudeMaster" WHERE "type" = 'output' GROUP BY client_account`,
    ])
    expect(series).toEqual([{ key: 'alpha', points: [[at(10), 1500]] }])
  })
})

describe('the demo source counts tokens', () => {
  const demo = createDemoSource({ now: () => NOW })

  it('splits by type, with cache reads the largest, and agrees with each filtered query', async () => {
    const byType = await demo.series({
      metric: 'tokens',
      groupBy: 'type',
      range,
      stepSeconds: STEP,
    })
    expect(byType.map((s) => s.key)).toEqual([...TOKEN_TYPES])
    const totals = Object.fromEntries(
      byType.map((s) => [s.key, s.points.reduce((sum, [, v]) => sum + v, 0)]),
    )
    expect(totals.cache_read).toBeGreaterThan(totals.input as number)
    const input = await demo.series({
      metric: 'tokens',
      tokenType: 'input',
      range,
      stepSeconds: STEP,
    })
    expect(input[0]?.points.reduce((sum, [, v]) => sum + v, 0)).toBe(totals.input)
  })
})

describe('token helpers', () => {
  const series = (key: string, points: Array<[number, number]>): Series => ({ key, points })

  it('finds where the counters start and how much of a range they cover', () => {
    expect(firstPointAt([])).toBeNull()
    expect(firstPointAt([series('a', [[at(30), 1]]), series('b', [[at(50), 1]])])).toBe(at(50))
    expect(tokenCoverage(null, range, STEP)).toBe('none')
    expect(tokenCoverage(range.start, range, STEP)).toBe('full')
    expect(tokenCoverage(range.start + 60_000, range, STEP)).toBe('full')
    expect(tokenCoverage(at(30), range, STEP)).toBe('partial')
  })

  it('drops the buckets before the counters started, never after', () => {
    const filled = [
      series('a', [
        [at(20), 0],
        [at(15), 0],
        [at(10), 7],
        [at(5), 3],
      ]),
    ]
    expect(fromFirstBucket(filled, at(10) + 30_000, STEP)[0]?.points).toEqual([
      [at(10), 7],
      [at(5), 3],
    ])
    expect(fromFirstBucket(filled, null, STEP)).toBe(filled)
  })

  it('makes one row per key across the types, ordered by the chosen total', () => {
    const byType = {
      input: [series('alpha', [[at(10), 10]]), series('bravo', [[at(10), 50]])],
      output: [series('alpha', [[at(10), 20]])],
      cache_read: [series('alpha', [[at(10), 900]])],
      cache_creation: [series('charlie', [[at(10), 5]])],
    }
    const all = tokenRows(byType, 'all')
    expect(all.map((r) => [r.key, r.total])).toEqual([
      ['alpha', 930],
      ['bravo', 50],
      ['charlie', 5],
    ])
    expect(all[0]?.byType).toEqual({ input: 10, output: 20, cache_read: 900, cache_creation: 0 })
    expect(all[0]?.points).toEqual([[at(10), 930]])
    const inputOnly = tokenRows(byType, 'input')
    expect(inputOnly.map((r) => [r.key, r.total])).toEqual([
      ['bravo', 50],
      ['alpha', 10],
      ['charlie', 0],
    ])
    expect(inputOnly[1]?.points).toEqual([[at(10), 10]])
  })

  it('has no row for a key with no tokens of any type in the range', () => {
    const byType = {
      input: [series('alpha', [[at(10), 10]]), series('acct-0', [[at(10), 0]])],
      output: [series('acct-0', []), series('bravo', [[at(10), 4]])],
    }
    expect(tokenRows(byType, 'all').map((r) => r.key)).toEqual(['alpha', 'bravo'])
    // A row with other types' tokens stays, at 0, when one type is chosen.
    expect(tokenRows(byType, 'input').map((r) => [r.key, r.total])).toEqual([
      ['alpha', 10],
      ['bravo', 0],
    ])
  })

  it('has no request row for a key with no requests in the range', () => {
    expect(
      requestTable([
        series('alpha', [[at(10), 3]]),
        series('acct-0', [[at(10), 0]]),
        series('bravo', [[at(10), 5]]),
      ]).map((r) => [r.key, r.total]),
    ).toEqual([
      ['bravo', 5],
      ['alpha', 3],
    ])
  })

  it("names the table's range from when token counts start, when that is partway through", () => {
    const clock = () => '02:15'
    expect(tableRangeWords('partial', NOW - HOUR_MS, 'last 7 days', clock)).toBe('since 02:15')
    expect(tableRangeWords('partial', NOW - HOUR_MS, 'last 7 days', null)).toBe(
      'since token counting began',
    )
    expect(tableRangeWords('full', NOW - HOUR_MS, 'last 7 days', clock)).toBe('last 7 days')
    expect(tableRangeWords(null, NOW - HOUR_MS, 'last 7 days', clock)).toBe('last 7 days')
  })

  it('sums each type over a window from a query split by type', () => {
    const byType = [
      series('input', [
        [at(70), 1],
        [at(30), 2],
      ]),
      series('cache_read', [[at(30), 40]]),
      series('unknown', [[at(30), 99]]),
    ]
    expect(tokensBetween(byType, at(60), NOW)).toEqual({
      input: 2,
      output: 0,
      cache_read: 40,
      cache_creation: 0,
    })
  })
})
