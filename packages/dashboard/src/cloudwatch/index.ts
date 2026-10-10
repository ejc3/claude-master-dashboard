import 'server-only'

import { AwsClient } from 'aws4fetch'
import { insightsQuery, resolveMetric } from '../core/catalog'
import { validateSeriesQuery } from '../core/query'
import {
  type Band,
  type EpochMs,
  FIVE_HOURS_MS,
  type LatencyQuantiles,
  type MetricsSource,
  type ProfileStatus,
  type Series,
  type SeriesQuery,
  type Snapshot,
  WEEK_MS,
} from '../core/types'

/**
 * The CloudWatch source: reads the `ClaudeMaster` namespace with GetMetricData (Metrics Insights)
 * over CloudWatch's JSON protocol, signed with SigV4 by aws4fetch, so it runs on Workers as well as
 * Node. Each Metrics Insights query is its own call (the API allows one per GetMetricData), cached
 * and coalesced for about a minute, the export interval, so a page load with many viewers reads
 * each query once.
 */
export interface CloudWatchSourceOptions {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  region: string
  /** The namespace claude-master's metrics land in. */
  namespace?: string
  /** How long a query's answer is reused, in ms. */
  cacheMs?: number
  /** The clock; tests pass a fixed one. */
  now?: () => EpochMs
  /** The fetch used after signing; tests pass a fake. */
  fetch?: typeof fetch
  /** Overrides the regional endpoint. */
  endpoint?: string
  /**
   * Account codes to people's names (`acct-<hash>` -> name). Points exported before the server
   * labelled accounts carry the code; a person's series under both is shown once, under the name.
   */
  accountAliases?: ReadonlyMap<string, string>
}

/** CloudWatch refused or failed a request; `code` is its error type, the message its text. */
export class CloudWatchError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(`CloudWatch answered ${status} ${code}: ${message}`)
    this.name = 'CloudWatchError'
    this.status = status
    this.code = code
  }
}

const ALIAS_LINE = /^(acct-[0-9a-f]+)\s*=\s*(\S(?:.*\S)?)$/

/**
 * Reads DASHBOARD_ACCOUNT_ALIASES: one `acct-<hash>=NAME` line per person. Blank lines and `#`
 * comments are skipped; a malformed line is ignored, and how many were is logged, never which.
 */
export function parseAccountAliases(
  text: string | undefined,
  warn: (message: string) => void = console.warn,
): Map<string, string> {
  const aliases = new Map<string, string>()
  if (text === undefined) return aliases
  let malformed = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = ALIAS_LINE.exec(line)
    if (match === null || (match[2] as string).length > 64) {
      malformed++
      continue
    }
    aliases.set(match[1] as string, match[2] as string)
  }
  if (malformed > 0) {
    warn(
      `claude-master dashboard: ${malformed} malformed line${malformed === 1 ? '' : 's'} in DASHBOARD_ACCOUNT_ALIASES ignored`,
    )
  }
  return aliases
}

/**
 * Renames each series by the aliases and merges the ones that land on the same name: summed at
 * a shared timestamp for a SUM metric, the larger value otherwise. A key not in the map stays.
 */
export function foldAliases(
  series: Series[],
  aliases: ReadonlyMap<string, string>,
  statistic: string,
): Series[] {
  if (aliases.size === 0) return series
  const merged = new Map<string, Map<EpochMs, number>>()
  for (const s of series) {
    const key = aliases.get(s.key) ?? s.key
    const points = merged.get(key) ?? new Map<EpochMs, number>()
    for (const [at, value] of s.points) {
      const prior = points.get(at)
      points.set(
        at,
        prior === undefined ? value : statistic === 'SUM' ? prior + value : Math.max(prior, value),
      )
    }
    merged.set(key, points)
  }
  return [...merged.entries()].map(([key, points]) => ({
    key,
    points: [...points.entries()].sort((a, b) => a[0] - b[0]),
  }))
}

export const DEFAULT_NAMESPACE = 'ClaudeMaster'
export const DEFAULT_CACHE_MS = 60_000
/** How far back the snapshot looks for each gauge's latest reading. */
export const SNAPSHOT_LOOKBACK_MS = 15 * 60_000
const MAX_CACHE_ENTRIES = 512

/** One group's readings from one query: the label CloudWatch gave it and its points, ascending. */
export interface InsightsResult {
  label: string
  points: Array<[EpochMs, number]>
}

// The JSON protocol's wire shapes, as CloudWatch answers them.
interface WireResult {
  Id?: string
  Label?: string
  Timestamps?: number[]
  Values?: number[]
  StatusCode?: string
}
interface WireResponse {
  MetricDataResults?: WireResult[]
  NextToken?: string
  Messages?: Array<{ Code?: string; Value?: string }>
  __type?: string
  message?: string
  Message?: string
}

// Metrics Insights keywords that must be quoted as identifiers (the catalog keeps the same list).
const RESERVED = new Set(['result', 'window', 'from', 'to'])
const identifier = (name: string) => (RESERVED.has(name) ? `"${name}"` : name)

/**
 * A Metrics Insights query over the namespace: a statistic of a metric, optionally filtered on
 * one dimension and grouped by one or two. The snapshot's gauges are not semantic metrics (they
 * are read once, as "now"), so they are written here rather than in the catalog.
 */
export function gaugeQuery(
  namespace: string,
  statistic: 'MAX' | 'MIN',
  metric: string,
  options: { where?: [string, string]; groupBy?: readonly string[] } = {},
): string {
  const where =
    options.where === undefined
      ? ''
      : ` WHERE ${identifier(options.where[0])} = '${options.where[1].replace(/'/g, "''")}'`
  const group =
    options.groupBy === undefined || options.groupBy.length === 0
      ? ''
      : ` GROUP BY ${options.groupBy.map(identifier).join(', ')}`
  return `SELECT ${statistic}("${metric}") FROM "${namespace}"${where}${group}`
}

/** Maps claude-master's band gauge (0 ok, 1 reserve, 2 exhausted, anything else unknown). */
export function bandFromGauge(value: number | null): Band {
  switch (value) {
    case 0:
      return 'ok'
    case 1:
      return 'reserve'
    case 2:
      return 'exhausted'
    default:
      return 'unknown'
  }
}

/** The newest reading of a group, as [bucket start, value]; null with no points. */
export function latest(result: InsightsResult | undefined): [EpochMs, number] | null {
  const point = result?.points.at(-1)
  return point === undefined ? null : point
}

/** Splits a two-dimension group label ("<first> <second>") at its last space. */
export function splitLabel(label: string): [string, string] {
  const at = label.lastIndexOf(' ')
  return at < 0 ? [label, ''] : [label.slice(0, at), label.slice(at + 1)]
}

interface CacheEntry {
  expiresAt: EpochMs
  value: Promise<InsightsResult[]>
}

export function createCloudWatchSource(options: CloudWatchSourceOptions): MetricsSource {
  const namespace = options.namespace ?? DEFAULT_NAMESPACE
  const cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS
  const clock = options.now ?? Date.now
  const fetchImpl = options.fetch ?? fetch
  const endpoint = options.endpoint ?? `https://monitoring.${options.region}.amazonaws.com/`
  const aliases = options.accountAliases ?? new Map<string, string>()
  const client = new AwsClient({
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    ...(options.sessionToken === undefined ? {} : { sessionToken: options.sessionToken }),
    region: options.region,
    service: 'monitoring',
  })
  const cache = new Map<string, CacheEntry>()

  async function call(body: Record<string, unknown>): Promise<WireResponse> {
    const request = await client.sign(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-amz-json-1.0',
        'x-amz-target': 'GraniteServiceVersion20100801.GetMetricData',
      },
      body: JSON.stringify(body),
    })
    const response = await fetchImpl(request)
    const text = await response.text()
    let parsed: WireResponse = {}
    try {
      parsed = JSON.parse(text) as WireResponse
    } catch {
      if (response.ok) throw new CloudWatchError(response.status, 'InvalidResponse', 'not JSON')
    }
    if (!response.ok) {
      const code = (parsed.__type ?? 'HttpError').split('#').at(-1) ?? 'HttpError'
      throw new CloudWatchError(response.status, code, parsed.message ?? parsed.Message ?? text)
    }
    return parsed
  }

  /** Runs one Metrics Insights query over [start, end) at `periodSeconds`, following pages. */
  async function run(
    expression: string,
    start: EpochMs,
    end: EpochMs,
    periodSeconds: number,
  ): Promise<InsightsResult[]> {
    const groups = new Map<string, Array<[EpochMs, number]>>()
    let nextToken: string | undefined
    do {
      const response: WireResponse = await call({
        StartTime: Math.floor(start / 1000),
        EndTime: Math.floor(end / 1000),
        ScanBy: 'TimestampAscending',
        MetricDataQueries: [{ Id: 'q', Expression: expression, Period: periodSeconds }],
        ...(nextToken === undefined ? {} : { NextToken: nextToken }),
      })
      for (const result of response.MetricDataResults ?? []) {
        if (result.StatusCode === 'InternalError') {
          throw new CloudWatchError(200, 'InternalError', 'a query result failed')
        }
        const label = result.Label ?? ''
        const points = groups.get(label) ?? []
        const stamps = result.Timestamps ?? []
        const values = result.Values ?? []
        for (const [i, stamp] of stamps.entries()) {
          const value = values[i]
          if (typeof stamp === 'number' && typeof value === 'number' && Number.isFinite(value)) {
            points.push([stamp * 1000, value])
          }
        }
        groups.set(label, points)
      }
      nextToken = response.NextToken
    } while (nextToken !== undefined)
    return [...groups.entries()].map(([label, points]) => ({
      label,
      points: points.sort((a, b) => a[0] - b[0]),
    }))
  }

  /** The same query within a minute is answered once, concurrent callers included. */
  function cached(
    expression: string,
    start: EpochMs,
    end: EpochMs,
    periodSeconds: number,
  ): Promise<InsightsResult[]> {
    const now = clock()
    const key = `${expression}\n${start}\n${end}\n${periodSeconds}`
    const hit = cache.get(key)
    if (hit !== undefined && hit.expiresAt > now) return hit.value
    for (const [k, entry] of cache) if (entry.expiresAt <= now) cache.delete(k)
    if (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    const value = run(expression, start, end, periodSeconds)
    cache.set(key, { expiresAt: now + cacheMs, value })
    // A failure is not kept: the next caller asks CloudWatch again.
    value.catch(() => {
      if (cache.get(key)?.value === value) cache.delete(key)
    })
    return value
  }

  // The gauges the snapshot reads; one query each, all in flight together.
  const gauge = (statistic: 'MAX' | 'MIN', metric: string, groupBy: readonly string[]) =>
    gaugeQuery(namespace, statistic, `claude_master.${metric}`, { groupBy })

  return {
    async snapshot(): Promise<Snapshot> {
      const now = clock()
      const end = Math.floor(now / 60_000) * 60_000 + 60_000
      const start = end - SNAPSHOT_LOOKBACK_MS
      const read = (query: string) => cached(query, start, end, 60)
      const [used, resets, bands, cooldowns, tokens, quantiles, fiveHour, sessions, connections] =
        await Promise.all([
          read(gauge('MAX', 'quota.used_fraction', ['profile'])),
          read(gauge('MAX', 'quota.resets_in_seconds', ['profile'])),
          read(gauge('MAX', 'quota.band', ['profile'])),
          read(gauge('MAX', 'quota.rate_limited_for_seconds', ['profile'])),
          read(gauge('MIN', 'auth.token_expires_in_seconds', ['profile'])),
          read(gauge('MAX', 'inference.duration_quantile', ['profile', 'quantile'])),
          read(
            gaugeQuery(namespace, 'MAX', 'claude_master.anthropic.ratelimit', {
              where: ['window', '5h'],
              groupBy: ['profile', 'measure'],
            }),
          ),
          read(gauge('MAX', 'sessions.tracked', [])),
          read(gauge('MAX', 'proxy.active_connections', [])),
        ])
      const byLabel = (results: InsightsResult[]) => new Map(results.map((r) => [r.label, r]))
      const resetsBy = byLabel(resets)
      const bandsBy = byLabel(bands)
      const cooldownsBy = byLabel(cooldowns)
      const tokensBy = byLabel(tokens)
      // Two-dimension groups: "<profile> <quantile>" and "<profile> <measure>".
      const quantilesBy = new Map<string, Partial<Record<string, number>>>()
      for (const result of quantiles) {
        const [profile, quantile] = splitLabel(result.label)
        const reading = latest(result)
        if (reading === null) continue
        quantilesBy.set(profile, { ...quantilesBy.get(profile), [quantile]: reading[1] })
      }
      const fiveHourBy = new Map<string, Partial<Record<string, [EpochMs, number]>>>()
      for (const result of fiveHour) {
        const [profile, measure] = splitLabel(result.label)
        const reading = latest(result)
        if (reading === null) continue
        fiveHourBy.set(profile, { ...fiveHourBy.get(profile), [measure]: reading })
      }

      let asOf = 0
      const at = (reading: [EpochMs, number] | null) => {
        if (reading !== null && reading[0] > asOf) asOf = reading[0]
        return reading
      }
      // A subscription is whatever reports a weekly used share; the API-key backup and the
      // 'none' placeholder report latency but no quota, so they are not listed.
      const profiles: ProfileStatus[] = used
        .filter((result) => result.points.length > 0)
        .map((result) => {
          const profile = result.label
          const weeklyUsed = at(latest(result))
          const weeklyReset = at(latest(resetsBy.get(profile)))
          const band = at(latest(bandsBy.get(profile)))
          const cooldown = at(latest(cooldownsBy.get(profile)))
          const token = at(latest(tokensBy.get(profile)))
          const q = quantilesBy.get(profile) ?? {}
          const latencyMs: LatencyQuantiles = {
            p50: q['0.5'] ?? null,
            p95: q['0.95'] ?? null,
            p99: q['0.99'] ?? null,
          }
          const window5h = fiveHourBy.get(profile)
          const utilization = window5h?.utilization
          const resets5h = window5h?.resets_in_seconds
          return {
            profile,
            band: bandFromGauge(band === null ? null : band[1]),
            weekly: {
              usedFraction: weeklyUsed === null ? null : weeklyUsed[1],
              resetsAt:
                weeklyReset === null || weeklyReset[1] <= 0
                  ? null
                  : weeklyReset[0] + weeklyReset[1] * 1000,
              lengthMs: WEEK_MS,
            },
            fiveHour:
              utilization === undefined
                ? null
                : {
                    usedFraction: utilization[1],
                    resetsAt:
                      resets5h === undefined || resets5h[1] <= 0
                        ? null
                        : resets5h[0] + resets5h[1] * 1000,
                    lengthMs: FIVE_HOURS_MS,
                  },
            rateLimitedUntil:
              cooldown === null || cooldown[1] <= 0 ? null : cooldown[0] + cooldown[1] * 1000,
            tokenExpiresAt: token === null ? null : token[0] + token[1] * 1000,
            latencyMs,
          }
        })
        .sort((a, b) => a.profile.localeCompare(b.profile))
      const sessionsNow = at(latest(sessions[0]))
      const connectionsNow = at(latest(connections[0]))
      return {
        asOf: asOf === 0 ? now : asOf,
        profiles,
        sessions: sessionsNow === null ? null : sessionsNow[1],
        activeConnections: connectionsNow === null ? null : connectionsNow[1],
      }
    },

    async series(query: SeriesQuery): Promise<Series[]> {
      validateSeriesQuery(query)
      const resolved = resolveMetric(query.metric, query.groupBy)
      const expression = insightsQuery(namespace, resolved)
      const results = await cached(
        expression,
        query.range.start,
        query.range.end,
        query.stepSeconds,
      )
      // Without GROUP BY, CloudWatch labels the one result with the query id.
      const series = results.map((result) => ({
        key: query.groupBy === undefined ? 'total' : result.label,
        points: result.points,
      }))
      return query.groupBy === 'client_account'
        ? foldAliases(series, aliases, resolved.statistic)
        : series
    },
  }
}

export type SourceKind = 'cloudwatch' | 'demo'

export interface SourceSelection {
  kind: SourceKind
  source: MetricsSource
}

/**
 * CloudWatch when AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_REGION are all set, otherwise
 * the given demo source (and a warning naming what is missing, so an empty deployment is not
 * mistaken for a configured one). A CloudWatch failure later is an error, never a fallback.
 * DASHBOARD_ACCOUNT_ALIASES, when set, folds account codes into people's names.
 */
export function selectSource(
  env: Record<string, string | undefined>,
  demo: MetricsSource,
  options: Omit<CloudWatchSourceOptions, 'accessKeyId' | 'secretAccessKey' | 'region'> & {
    warn?: (message: string) => void
  } = {},
): SourceSelection {
  const { warn = console.warn, ...rest } = options
  const accessKeyId = env.AWS_ACCESS_KEY_ID?.trim()
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY?.trim()
  const region = env.AWS_REGION?.trim()
  if (accessKeyId && secretAccessKey && region) {
    return {
      kind: 'cloudwatch',
      source: createCloudWatchSource({
        accountAliases: parseAccountAliases(env.DASHBOARD_ACCOUNT_ALIASES, warn),
        ...rest,
        accessKeyId,
        secretAccessKey,
        region,
      }),
    }
  }
  const missing = [
    accessKeyId ? null : 'AWS_ACCESS_KEY_ID',
    secretAccessKey ? null : 'AWS_SECRET_ACCESS_KEY',
    region ? null : 'AWS_REGION',
  ].filter((name) => name !== null)
  warn(`claude-master dashboard: ${missing.join(', ')} not set; showing demo data`)
  return { kind: 'demo', source: demo }
}
