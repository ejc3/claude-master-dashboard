import { resolveMetric } from '../core/catalog.js'
import {
  type Dimension,
  type EpochMs,
  FIVE_HOURS_MS,
  HOUR_MS,
  type MetricsSource,
  type ProfileStatus,
  type SemanticMetric,
  type Series,
  type SeriesQuery,
  type Snapshot,
  WEEK_MS,
} from '../core/types.js'

/** Made-up dimension values; none is a real profile, box, person or model. */
export const DEMO_VALUES: Record<Dimension, readonly string[]> = {
  profile: ['alpha', 'bravo', 'charlie', 'delta'],
  client: ['box-1', 'box-2', 'tunnel'],
  client_account: ['alice', 'bob', 'carol', 'other'],
  model: ['claude-model-large', 'claude-model-medium', 'claude-model-small'],
  status_class: ['2xx', '4xx', '5xx'],
  status: ['429', '500', '529'],
  reason: ['rate_limited', 'weekly_exhausted', 'reserve_reached', 'rebalanced'],
  result: ['adopted', 'failed', 'rotated_scheduled'],
}

// FNV-1a, folded to [0, 1): the same inputs always give the same number.
function noise(...parts: Array<string | number>): number {
  let h = 0x811c9dc5
  for (const char of parts.join('|')) {
    h ^= char.charCodeAt(0)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) / 0x100000000
}

// Busier in the working day (UTC), never idle.
function diurnal(at: EpochMs): number {
  const hour = (at / HOUR_MS) % 24
  return 1 + 0.6 * Math.sin(((hour - 9) / 24) * 2 * Math.PI)
}

const KEY_WEIGHT: Partial<Record<Dimension, readonly number[]>> = {
  status_class: [0.94, 0.05, 0.01],
  status: [0.7, 0.1, 0.2],
}

function weight(groupBy: Dimension | undefined, index: number, count: number): number {
  if (groupBy === undefined) return 1
  return KEY_WEIGHT[groupBy]?.[index] ?? (count - index) / ((count * (count + 1)) / 2)
}

// Requests per minute across the pool at an average hour; the other metrics scale from it.
const REQUESTS_PER_MINUTE = 40

function value(
  metric: SemanticMetric,
  key: string,
  share: number,
  at: EpochMs,
  stepSeconds: number,
) {
  const jitter = 0.85 + 0.3 * noise(metric, key, at)
  const perStep = REQUESTS_PER_MINUTE * (stepSeconds / 60) * diurnal(at) * share * jitter
  switch (metric) {
    case 'requests':
      return Math.round(perStep)
    case 'errors':
      return Math.round(perStep * 0.03)
    case 'switches':
      return Math.round(perStep * 0.01)
    case 'rateLimited':
      return Math.round(perStep * 0.004)
    case 'backupRequests':
      return Math.round(perStep * 0.002)
    case 'ttfbMs':
      return Math.round(900 * jitter)
    case 'durationMs':
      return Math.round(14000 * jitter)
    case 'upstreamTtfbMs':
      return Math.round(820 * jitter)
    case 'overheadMs':
      return Math.round(4 * jitter)
    case 'weeklyUsed':
      return Math.min(1, ((at % WEEK_MS) / WEEK_MS) * (0.6 + noise(key) * 0.6))
    case 'weeklyResetsInSeconds':
      return Math.round((WEEK_MS - (at % WEEK_MS)) / 1000)
    case 'tokenExpiresInSeconds':
      return Math.round(4 * 3600 * (0.5 + noise(key, at)))
  }
}

export interface DemoOptions {
  /** The clock; tests pass a fixed one so every number is reproducible. */
  now?: () => EpochMs
}

/** A source with plausible, reproducible numbers, for previews, tests and local development. */
export function createDemoSource(options: DemoOptions = {}): MetricsSource {
  const now = options.now ?? Date.now
  return {
    async snapshot(): Promise<Snapshot> {
      const at = now()
      const asOf = at - 30_000
      const window = (used: number, resetsIn: number, lengthMs: number) => ({
        usedFraction: used,
        resetsAt: at + resetsIn,
        lengthMs,
      })
      const latency = (scale: number) => ({
        p50: 9000 * scale,
        p95: 31000 * scale,
        p99: 52000 * scale,
      })
      const profiles: ProfileStatus[] = [
        {
          profile: 'alpha',
          band: 'ok',
          weekly: window(0.42, 3.1 * 24 * HOUR_MS, WEEK_MS),
          fiveHour: window(0.35, 2.2 * HOUR_MS, FIVE_HOURS_MS),
          rateLimitedUntil: null,
          tokenExpiresAt: at + 5.5 * HOUR_MS,
          latencyMs: latency(1),
        },
        {
          profile: 'bravo',
          band: 'ok',
          weekly: window(0.71, 2.6 * 24 * HOUR_MS, WEEK_MS),
          fiveHour: window(0.82, 1.4 * HOUR_MS, FIVE_HOURS_MS),
          rateLimitedUntil: null,
          tokenExpiresAt: at + 2 * HOUR_MS,
          latencyMs: latency(1.1),
        },
        {
          profile: 'charlie',
          band: 'exhausted',
          weekly: window(1, 9 * HOUR_MS, WEEK_MS),
          fiveHour: window(1, 0.6 * HOUR_MS, FIVE_HOURS_MS),
          rateLimitedUntil: null,
          tokenExpiresAt: at + 7 * HOUR_MS,
          latencyMs: latency(0.9),
        },
        {
          profile: 'delta',
          band: 'reserve',
          weekly: window(0.93, 4.2 * 24 * HOUR_MS, WEEK_MS),
          fiveHour: null,
          rateLimitedUntil: at + 7 * 60_000,
          tokenExpiresAt: at + 40 * 60_000,
          latencyMs: latency(1.3),
        },
      ]
      return { asOf, profiles, sessions: 23, activeConnections: 41 }
    },

    async series(query: SeriesQuery): Promise<Series[]> {
      // Refuse what claude-master does not emit, exactly as a real source must.
      resolveMetric(query.metric, query.groupBy)
      const stepMs = query.stepSeconds * 1000
      const first = Math.ceil(query.range.start / stepMs) * stepMs
      const keys = query.groupBy === undefined ? ['total'] : DEMO_VALUES[query.groupBy]
      return keys.map((key, index) => {
        const share = weight(query.groupBy, index, keys.length)
        const points: Array<[EpochMs, number]> = []
        for (let at = first; at <= query.range.end; at += stepMs) {
          points.push([at, value(query.metric, key, share, at, query.stepSeconds)])
        }
        return { key, points }
      })
    },
  }
}
