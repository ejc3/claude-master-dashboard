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
  it('is the share of the window already past', () => {
    expect(elapsedFraction(week(0.25, 0), NOW)).toBeCloseTo(0.25)
    expect(elapsedFraction(week(0.8, 0), NOW)).toBeCloseTo(0.8)
    expect(
      elapsedFraction({ usedFraction: 0, resetsAt: NOW + 2 * WEEK_MS, lengthMs: WEEK_MS }, NOW),
    ).toBe(0)
  })

  it('is unknown without a reset time, with no length, or once the reset has passed', () => {
    expect(
      elapsedFraction({ usedFraction: 0.5, resetsAt: null, lengthMs: WEEK_MS }, NOW),
    ).toBeNull()
    expect(
      elapsedFraction({ usedFraction: 0.5, resetsAt: NOW + HOUR_MS, lengthMs: 0 }, NOW),
    ).toBeNull()
    expect(
      elapsedFraction({ usedFraction: 1, resetsAt: NOW - 2 * 60_000, lengthMs: WEEK_MS }, NOW),
    ).toBeNull()
    expect(elapsedFraction({ usedFraction: 1, resetsAt: NOW, lengthMs: WEEK_MS }, NOW)).toBeNull()
  })
})

describe('pace', () => {
  it('measures how far usage leads elapsed time, margins inclusive', () => {
    expect(pace(week(0.5, 0.2), NOW)).toBe('even')
    expect(pace(week(0.5, 0.5 + EVEN_MARGIN), NOW)).toBe('even')
    expect(pace(week(0.5, 0.5 + EVEN_MARGIN + 0.001), NOW)).toBe('ahead')
    expect(pace(week(0.5, 0.5 + OVER_MARGIN), NOW)).toBe('ahead')
    expect(pace(week(0.5, 0.5 + OVER_MARGIN + 0.001), NOW)).toBe('over')
  })

  it('compares usage with elapsed time, not remaining time', () => {
    // A fifth of the week gone: 30% used leads by 10 points; 10% used is behind.
    expect(pace(week(0.2, 0.3), NOW)).toBe('ahead')
    expect(pace(week(0.2, 0.1), NOW)).toBe('even')
    expect(pace(week(0.8, 0.3), NOW)).toBe('even')
  })

  it('calls a used-up allowance over, even near the end of the window', () => {
    expect(pace(week(0.97, 1), NOW)).toBe('over')
    expect(pace(week(0.97, 1.02), NOW)).toBe('over')
  })

  it('is unknown for a reading taken before its window reset, and for unreadable numbers', () => {
    expect(pace({ usedFraction: 1, resetsAt: NOW - 60_000, lengthMs: WEEK_MS }, NOW)).toBe(
      'unknown',
    )
    expect(pace(week(0.5, null), NOW)).toBe('unknown')
    expect(pace(week(0.5, Number.NaN), NOW)).toBe('unknown')
    expect(pace({ usedFraction: 0.5, resetsAt: Number.NaN, lengthMs: WEEK_MS }, NOW)).toBe(
      'unknown',
    )
  })
})

describe('projectedExhaustion', () => {
  it('extrapolates the average rate so far when usage leads', () => {
    // Half the allowance in a quarter of the week: the rest lasts another quarter week.
    const at = projectedExhaustion(week(0.25, 0.5), NOW)
    expect(at).not.toBeNull()
    expect(((at as number) - NOW) / WEEK_MS).toBeCloseTo(0.25, 6)
  })

  it('is null at an even pace, so no card says both "even" and "runs out"', () => {
    expect(projectedExhaustion(week(0.5, 0.3), NOW)).toBeNull()
    expect(projectedExhaustion(week(0.45, 0.49), NOW)).toBeNull()
  })

  it('is now for a spent allowance and null when nothing is known', () => {
    expect(projectedExhaustion(week(0.5, 1), NOW)).toBe(NOW)
    expect(projectedExhaustion(week(0.5, null), NOW)).toBeNull()
    expect(
      projectedExhaustion({ usedFraction: 1, resetsAt: NOW - 60_000, lengthMs: WEEK_MS }, NOW),
    ).toBeNull()
  })
})
