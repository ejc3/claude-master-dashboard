import { describe, expect, it } from 'vitest'
import {
  EVEN_MARGIN,
  elapsedFraction,
  HOUR_MS,
  OVER_MARGIN,
  pace,
  projectedExhaustion,
  type QuotaWindow,
  WEEK_MS,
} from '../src/core/index.js'

const NOW = Date.UTC(2026, 9, 9, 12)

// A weekly window with `elapsed` of it gone and `used` of the allowance spent.
function week(elapsed: number, used: number | null): QuotaWindow {
  return { usedFraction: used, resetsAt: NOW + (1 - elapsed) * WEEK_MS, lengthMs: WEEK_MS }
}

describe('elapsedFraction', () => {
  it('is the share of the window already past, clamped to 0..1', () => {
    expect(elapsedFraction(week(0.25, 0), NOW)).toBeCloseTo(0.25)
    expect(
      elapsedFraction({ usedFraction: 0, resetsAt: NOW - HOUR_MS, lengthMs: WEEK_MS }, NOW),
    ).toBe(1)
    expect(
      elapsedFraction({ usedFraction: 0, resetsAt: NOW + 2 * WEEK_MS, lengthMs: WEEK_MS }, NOW),
    ).toBe(0)
  })

  it('is unknown without a reset time', () => {
    expect(
      elapsedFraction({ usedFraction: 0.5, resetsAt: null, lengthMs: WEEK_MS }, NOW),
    ).toBeNull()
  })
})

describe('pace', () => {
  it('compares usage with elapsed time, with the even and over margins', () => {
    expect(pace(week(0.5, 0.5), NOW)).toBe('even')
    expect(pace(week(0.5, 0.2), NOW)).toBe('even')
    expect(pace(week(0.5, 0.5 + EVEN_MARGIN - 0.001), NOW)).toBe('even')
    expect(pace(week(0.5, 0.5 + EVEN_MARGIN + 0.001), NOW)).toBe('ahead')
    expect(pace(week(0.5, 0.5 + OVER_MARGIN - 0.001), NOW)).toBe('ahead')
    expect(pace(week(0.5, 0.5 + OVER_MARGIN + 0.001), NOW)).toBe('over')
  })

  it('is unknown when usage or the reset is unknown', () => {
    expect(pace(week(0.5, null), NOW)).toBe('unknown')
    expect(pace({ usedFraction: 0.5, resetsAt: null, lengthMs: WEEK_MS }, NOW)).toBe('unknown')
  })
})

describe('projectedExhaustion', () => {
  it('extrapolates the average rate so far', () => {
    // Half the allowance in a quarter of the week: the rest lasts another quarter week.
    const at = projectedExhaustion(week(0.25, 0.5), NOW)
    expect(at).not.toBeNull()
    expect((at as number) - NOW).toBeCloseTo(0.25 * WEEK_MS, -3)
  })

  it('is null when the allowance outlasts the window', () => {
    expect(projectedExhaustion(week(0.5, 0.3), NOW)).toBeNull()
    expect(projectedExhaustion(week(0.5, 0.5), NOW)).toBeNull()
  })

  it('is now for a spent allowance, and null with nothing used or nothing known', () => {
    expect(projectedExhaustion(week(0.5, 1), NOW)).toBe(NOW)
    expect(projectedExhaustion(week(0.5, 0), NOW)).toBeNull()
    expect(projectedExhaustion(week(0, 0.1), NOW)).toBeNull()
    expect(projectedExhaustion(week(0.5, null), NOW)).toBeNull()
  })
})
