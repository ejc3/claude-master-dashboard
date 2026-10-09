import type { SeriesQuery } from './types'

/** The longest range one query may cover. */
export const MAX_RANGE_MS = 15 * 24 * 60 * 60 * 1000
/** CloudWatch's finest period for these metrics; every step is a whole number of minutes. */
export const MIN_STEP_SECONDS = 60
/** At most this many points per series, so no query asks a source for unbounded data. */
export const MAX_POINTS = 1500

export class BadQueryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadQueryError'
  }
}

/** Rejects a query no source should run; every source calls this before doing any work. */
export function validateSeriesQuery(query: SeriesQuery): void {
  const { start, end } = query.range
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) {
    throw new BadQueryError('the range must be whole milliseconds with start before end')
  }
  if (end - start > MAX_RANGE_MS) throw new BadQueryError('the range is longer than 15 days')
  const step = query.stepSeconds
  if (!Number.isSafeInteger(step) || step < MIN_STEP_SECONDS || step % MIN_STEP_SECONDS !== 0) {
    throw new BadQueryError('the step must be a whole number of minutes')
  }
  if (step * 1000 > end - start) throw new BadQueryError('the step is longer than the range')
  if ((end - start) / (step * 1000) > MAX_POINTS) {
    throw new BadQueryError(`the query would return more than ${MAX_POINTS} points`)
  }
}
