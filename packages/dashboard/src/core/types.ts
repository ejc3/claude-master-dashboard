/** Milliseconds since the Unix epoch. */
export type EpochMs = number

/** How much of a subscription's allowance is left, as claude-master classifies it. */
export type Band = 'ok' | 'reserve' | 'exhausted' | 'unknown'

/** One rate-limit window of a subscription: the weekly allowance or the 5-hour session. */
export interface QuotaWindow {
  /** Share of the window's allowance used, 0 to 1; null when the source has no reading. */
  usedFraction: number | null
  /** When the window resets; null when unknown. */
  resetsAt: EpochMs | null
  /** The window's length, so the share of it that has elapsed can be computed. */
  lengthMs: number
}

export interface LatencyQuantiles {
  p50: number | null
  p95: number | null
  p99: number | null
}

/** The latest state of one subscription (a claude-master profile). */
export interface ProfileStatus {
  profile: string
  band: Band
  weekly: QuotaWindow
  /** Null when the source does not report the 5-hour window. */
  fiveHour: QuotaWindow | null
  /** When claude-master's cooldown after a 429 ends; null when there is none. */
  rateLimitedUntil: EpochMs | null
  /** When the profile's login token expires; null when unknown. */
  tokenExpiresAt: EpochMs | null
  /** Request duration over the proxy's recent requests, in ms. */
  latencyMs: LatencyQuantiles
}

/** Everything the dashboard shows as "now". */
export interface Snapshot {
  /** When the newest reading in this snapshot was taken. */
  asOf: EpochMs
  profiles: ProfileStatus[]
  /** Conversations bound to a subscription. */
  sessions: number | null
  activeConnections: number | null
}

/**
 * The axes claude-master splits its metrics by. A metric carries a few of them (at most three
 * for the metrics the dashboard reads); a split by another axis is a separate metric.
 */
export type Dimension =
  | 'profile'
  | 'client'
  | 'client_account'
  | 'model'
  | 'status_class'
  | 'status'
  | 'reason'
  | 'from'
  | 'to'
  | 'result'

/** What a chart asks for, independent of where the numbers are stored. */
export type SemanticMetric =
  | 'requests'
  | 'errors'
  | 'switches'
  | 'rateLimited'
  | 'backupRequests'
  | 'ttfbMs'
  | 'durationMs'
  | 'upstreamTtfbMs'
  | 'overheadMs'
  | 'weeklyUsed'
  | 'weeklyResetsInSeconds'
  | 'tokenExpiresInSeconds'

export interface TimeRange {
  start: EpochMs
  end: EpochMs
}

export interface SeriesQuery {
  metric: SemanticMetric
  /** One line per value of this dimension; omitted for a single total line. */
  groupBy?: Dimension
  range: TimeRange
  /** Width of each point's bucket. */
  stepSeconds: number
}

export interface Series {
  /** The group's value (e.g. a profile name), or 'total' for an ungrouped query. */
  key: string
  /** [bucket start, value], oldest first. */
  points: Array<[EpochMs, number]>
}

/** Where the numbers come from: CloudWatch, Prometheus, a fixture. */
export interface MetricsSource {
  snapshot(): Promise<Snapshot>
  series(query: SeriesQuery): Promise<Series[]>
}

export const HOUR_MS = 60 * 60 * 1000
export const FIVE_HOURS_MS = 5 * HOUR_MS
export const WEEK_MS = 7 * 24 * HOUR_MS
