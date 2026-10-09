import { groupableBy } from './catalog'
import { BadQueryError, validateSeriesQuery } from './query'
import type { Dimension, SemanticMetric, SeriesQuery } from './types'

// The JSON a dashboard handler serves and its components read. Paths are relative to the
// handler's mount point: `snapshot` and `series?metric=…&groupBy=…&start=…&end=…&step=…`.

const METRICS: readonly SemanticMetric[] = [
  'requests',
  'errors',
  'switches',
  'rateLimited',
  'backupRequests',
  'ttfbMs',
  'durationMs',
  'upstreamTtfbMs',
  'overheadMs',
  'weeklyUsed',
  'weeklyResetsInSeconds',
  'tokenExpiresInSeconds',
]

export function seriesQueryToParams(query: SeriesQuery): URLSearchParams {
  const params = new URLSearchParams({
    metric: query.metric,
    start: String(query.range.start),
    end: String(query.range.end),
    step: String(query.stepSeconds),
  })
  if (query.groupBy !== undefined) params.set('groupBy', query.groupBy)
  return params
}

function integer(params: URLSearchParams, name: string): number {
  const raw = params.get(name)
  if (raw === null || !/^\d{1,16}$/.test(raw))
    throw new BadQueryError(`${name} must be a whole number`)
  return Number(raw)
}

/** Parses and bounds a series query from request parameters; throws BadQueryError. */
export function seriesQueryFromParams(params: URLSearchParams): SeriesQuery {
  const metric = params.get('metric')
  if (metric === null || !(METRICS as readonly string[]).includes(metric)) {
    throw new BadQueryError('unknown metric')
  }
  const query: SeriesQuery = {
    metric: metric as SemanticMetric,
    range: { start: integer(params, 'start'), end: integer(params, 'end') },
    stepSeconds: integer(params, 'step'),
  }
  const groupBy = params.get('groupBy')
  if (groupBy !== null) {
    if (!(groupableBy(query.metric) as string[]).includes(groupBy)) {
      throw new BadQueryError(`${metric} cannot be split by ${groupBy}`)
    }
    query.groupBy = groupBy as Dimension
  }
  validateSeriesQuery(query)
  return query
}
