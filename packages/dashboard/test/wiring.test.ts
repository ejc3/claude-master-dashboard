import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The dashboard's wiring of the forecast, checked on its source: no test renders the page.
const source = readFileSync(new URL('../src/react/Dashboard.tsx', import.meta.url), 'utf8')

describe('Dashboard wiring', () => {
  it('keeps the last used-share readings while the next range loads', () => {
    expect(source).toMatch(/const usedData = useLastReady\(usedReadings\)/)
    expect(source).toMatch(/failureOf\(usedReadings\)/)
  })

  it('forecasts from the readings time and judges run-outs against the clock', () => {
    // One call per line: everything between `poolForecast(` and the line's closing `)`.
    const calls = [...source.matchAll(/poolForecast\((.*)\),?$/gm)].map((m) => m[1] ?? '')
    expect(calls).toHaveLength(2)
    for (const args of calls) {
      expect(args).toMatch(/snapshot\?\.asOf \?\? now/)
      expect(args.trim().endsWith('now')).toBe(true)
    }
  })
})
