import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The dashboard's wiring of the forecast, checked on its source: no test renders the page.
const source = readFileSync(new URL('../src/react/Dashboard.tsx', import.meta.url), 'utf8')

describe('Dashboard wiring', () => {
  it('keeps the last used-share readings while the next range loads', () => {
    expect(source).toMatch(/const usedData = useLastReady\(usedReadings\)/)
    expect(source).toMatch(/failureOf\(usedReadings\)/)
  })

  it('shows one forecast: no per-window forecast beside the joint one', () => {
    // Two models on one page gave two different run-out times.
    expect(source).not.toMatch(/poolForecast\(/)
  })
})

const pool = readFileSync(new URL('../src/react/Pool.tsx', import.meta.url), 'utf8')

describe('Headline wiring', () => {
  it('reads the headline from one simulation of both windows, from the readings time', () => {
    expect(source).toMatch(/const asOf = snapshot\?\.asOf \?\? gapsAt/)
    expect(source).toMatch(/poolGaps\(profilesNow, asOf, smoothed, gapsAt\)/)
    expect(source).toMatch(
      /<PoolOutlook\s+gaps=\{gaps\}\s+gapsIfStopped=\{gapsIfStopped\}\s+profiles=\{profilesNow\}/,
    )
    // The other tab: the same forecast with no more use.
    expect(source).toMatch(/poolGaps\(profilesNow, asOf, smoothed, gapsAt, true\)/)
    expect(pool).toMatch(/gapsHeadline\(props\.gaps, now\)/)
    expect(pool).not.toMatch(/forecastHeadline\(/)
  })

  it('puts the token and range controls just above the charts and table, not in the header', () => {
    const header = source.slice(source.indexOf('<header'), source.indexOf('</header>'))
    expect(header).not.toMatch(/tokenControl|rangeControl/)
    const toolbar = source.indexOf('cmd-toolbar')
    expect(toolbar).toBeGreaterThan(source.indexOf('aria-labelledby="cmd-subscriptions"'))
    expect(toolbar).toBeLessThan(source.indexOf('<div className="cmd-charts">'))
  })
})

const breakdown = readFileSync(new URL('../src/react/Breakdown.tsx', import.meta.url), 'utf8')
const queries = readFileSync(new URL('../src/react/queries.ts', import.meta.url), 'utf8')

describe('Token wiring', () => {
  it('charts tokens by subscription, and requests only when the range has no token counts', () => {
    expect(source).toMatch(/metric: 'tokens', groupBy: 'profile', \.\.\.tokenType/)
    expect(source).toMatch(
      /const showTokens = tokenRangeCoverage !== null && tokenRangeCoverage !== 'none'/,
    )
    expect(source).toMatch(/No token counts for this range yet; showing requests\./)
  })

  it('keeps models on requests, and shows a failed token query as an error', () => {
    expect(queries).toMatch(/dimension: 'model',\s+label: 'Models'.*tokens: false/s)
    // Projects count tokens only: no requests fallback to ask for.
    expect(queries).toMatch(/dimension: 'project',[^}]*tokens: true,\s+requests: false/s)
    expect(breakdown).toMatch(/does not count tokens by model; this view counts requests/)
    expect(breakdown).toMatch(/tokensPending \|\| tokenError !== null \? \[\] : requestRows/)
    // The title names the range the token totals cover.
    expect(breakdown).toMatch(/\{tableRangeWords\(\s*showTokens \? coverage : null,/)
  })
})
