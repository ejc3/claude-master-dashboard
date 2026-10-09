import type { Dimension, SemanticMetric } from './types.js'

/** How a stored series is reduced: counters arrive as deltas (sum), gauges as levels. */
export type Statistic = 'SUM' | 'AVG' | 'MAX' | 'MIN'

/** A semantic query resolved to the metric claude-master actually emits. */
export interface ResolvedMetric {
  /** The OpenTelemetry metric name, which CloudWatch keeps as the metric name. */
  name: string
  statistic: Statistic
  groupBy?: Dimension
}

interface Entry {
  name: string
  statistic: Statistic
  /** The dimensions this metric carries; grouping by any other one is refused. */
  dimensions: readonly Dimension[]
  /** A sibling metric that carries a dimension this one does not (one projection per axis). */
  projections?: Partial<Record<Dimension, string>>
}

// claude-master never crosses its axes: each metric carries at most three attributes, and a
// split by another axis is a separate metric (docs/claude-master.md in ejc3/CLIProxyAPI).
const CATALOG: Record<SemanticMetric, Entry> = {
  requests: {
    name: 'claude_master.inference.requests',
    statistic: 'SUM',
    dimensions: ['profile', 'client_account', 'status_class'],
    projections: {
      client: 'claude_master.inference.requests.by_client',
      model: 'claude_master.inference.requests.by_model',
    },
  },
  errors: {
    name: 'claude_master.inference.errors',
    statistic: 'SUM',
    dimensions: ['profile', 'status', 'client_account'],
  },
  switches: {
    name: 'claude_master.routing.switches',
    statistic: 'SUM',
    dimensions: ['reason', 'from', 'to'],
  },
  rateLimited: {
    name: 'claude_master.quota.rate_limited',
    statistic: 'SUM',
    dimensions: ['profile'],
  },
  backupRequests: {
    name: 'claude_master.routing.backup_requests',
    statistic: 'SUM',
    dimensions: [],
  },
  ttfbMs: {
    name: 'claude_master.inference.ttfb',
    statistic: 'AVG',
    dimensions: ['profile', 'status_class'],
    projections: { model: 'claude_master.inference.ttfb.by_model' },
  },
  durationMs: {
    name: 'claude_master.inference.duration',
    statistic: 'AVG',
    dimensions: ['profile', 'status_class'],
    projections: { model: 'claude_master.inference.duration.by_model' },
  },
  upstreamTtfbMs: {
    name: 'claude_master.inference.upstream_ttfb',
    statistic: 'AVG',
    dimensions: ['profile', 'status_class'],
  },
  overheadMs: { name: 'claude_master.proxy.overhead', statistic: 'AVG', dimensions: ['profile'] },
  weeklyUsed: {
    name: 'claude_master.quota.used_fraction',
    statistic: 'MAX',
    dimensions: ['profile'],
  },
  weeklyResetsInSeconds: {
    name: 'claude_master.quota.resets_in_seconds',
    statistic: 'MAX',
    dimensions: ['profile'],
  },
  tokenExpiresInSeconds: {
    name: 'claude_master.auth.token_expires_in_seconds',
    statistic: 'MIN',
    dimensions: ['profile'],
  },
}

const DIMENSIONS: readonly Dimension[] = [
  'profile',
  'client',
  'client_account',
  'model',
  'status_class',
  'status',
  'reason',
  'from',
  'to',
  'result',
]

export class UnsupportedQueryError extends Error {
  constructor(metric: SemanticMetric, groupBy: Dimension) {
    super(`claude-master does not emit ${metric} split by ${groupBy}`)
    this.name = 'UnsupportedQueryError'
  }
}

/** Resolves a semantic metric (optionally split by one dimension) to the emitted metric. */
export function resolveMetric(metric: SemanticMetric, groupBy?: Dimension): ResolvedMetric {
  const entry = CATALOG[metric]
  if (groupBy === undefined) return { name: entry.name, statistic: entry.statistic }
  if (entry.dimensions.includes(groupBy)) {
    return { name: entry.name, statistic: entry.statistic, groupBy }
  }
  const projection = entry.projections?.[groupBy]
  if (projection !== undefined) return { name: projection, statistic: entry.statistic, groupBy }
  throw new UnsupportedQueryError(metric, groupBy)
}

/** The dimensions a semantic metric can be split by. */
export function groupableBy(metric: SemanticMetric): Dimension[] {
  const entry = CATALOG[metric]
  return DIMENSIONS.filter(
    (d) => entry.dimensions.includes(d) || entry.projections?.[d] !== undefined,
  )
}

// Metrics Insights keywords that must be quoted when used as a dimension name.
const RESERVED = new Set<string>(['result', 'window', 'from', 'to'])

function identifier(name: string): string {
  return RESERVED.has(name) ? `"${name}"` : name
}

/**
 * The CloudWatch Metrics Insights query for a resolved metric in a namespace. A namespace that
 * would need escaping inside the query's quotes is refused rather than escaped.
 */
export function insightsQuery(namespace: string, resolved: ResolvedMetric): string {
  if (!/^[A-Za-z0-9 ._\-/#:]{1,255}$/.test(namespace)) {
    throw new Error('the namespace must be 1-255 letters, digits or . _ - / # : and spaces')
  }
  const group = resolved.groupBy === undefined ? '' : ` GROUP BY ${identifier(resolved.groupBy)}`
  return `SELECT ${resolved.statistic}("${resolved.name}") FROM "${namespace}"${group}`
}
