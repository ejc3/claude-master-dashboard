import { describe, expect, it } from 'vitest'
import {
  type Dimension,
  groupableBy,
  insightsQuery,
  resolveMetric,
  type SemanticMetric,
  UnsupportedQueryError,
} from '../src/core/index.js'

// Queries that were checked against the live CloudWatch API for the claude-master server's own
// CloudWatch dashboard. The catalog must produce them exactly.
const GOLDEN: Array<[SemanticMetric, Dimension | undefined, string]> = [
  [
    'requests',
    'client_account',
    'SELECT SUM("claude_master.inference.requests") FROM "ClaudeMaster" GROUP BY client_account',
  ],
  [
    'requests',
    'profile',
    'SELECT SUM("claude_master.inference.requests") FROM "ClaudeMaster" GROUP BY profile',
  ],
  [
    'requests',
    'client',
    'SELECT SUM("claude_master.inference.requests.by_client") FROM "ClaudeMaster" GROUP BY client',
  ],
  [
    'requests',
    'model',
    'SELECT SUM("claude_master.inference.requests.by_model") FROM "ClaudeMaster" GROUP BY model',
  ],
  [
    'requests',
    'status_class',
    'SELECT SUM("claude_master.inference.requests") FROM "ClaudeMaster" GROUP BY status_class',
  ],
  [
    'errors',
    'status',
    'SELECT SUM("claude_master.inference.errors") FROM "ClaudeMaster" GROUP BY status',
  ],
  [
    'ttfbMs',
    'profile',
    'SELECT AVG("claude_master.inference.ttfb") FROM "ClaudeMaster" GROUP BY profile',
  ],
  [
    'durationMs',
    'model',
    'SELECT AVG("claude_master.inference.duration.by_model") FROM "ClaudeMaster" GROUP BY model',
  ],
  [
    'upstreamTtfbMs',
    undefined,
    'SELECT AVG("claude_master.inference.upstream_ttfb") FROM "ClaudeMaster"',
  ],
  ['overheadMs', undefined, 'SELECT AVG("claude_master.proxy.overhead") FROM "ClaudeMaster"'],
  [
    'weeklyUsed',
    'profile',
    'SELECT MAX("claude_master.quota.used_fraction") FROM "ClaudeMaster" GROUP BY profile',
  ],
  [
    'weeklyResetsInSeconds',
    'profile',
    'SELECT MAX("claude_master.quota.resets_in_seconds") FROM "ClaudeMaster" GROUP BY profile',
  ],
  [
    'switches',
    'reason',
    'SELECT SUM("claude_master.routing.switches") FROM "ClaudeMaster" GROUP BY reason',
  ],
  ['rateLimited', undefined, 'SELECT SUM("claude_master.quota.rate_limited") FROM "ClaudeMaster"'],
  [
    'backupRequests',
    undefined,
    'SELECT SUM("claude_master.routing.backup_requests") FROM "ClaudeMaster"',
  ],
  [
    'tokenExpiresInSeconds',
    'profile',
    'SELECT MIN("claude_master.auth.token_expires_in_seconds") FROM "ClaudeMaster" GROUP BY profile',
  ],
]

describe('catalog', () => {
  it.each(GOLDEN)('%s by %s matches the live-checked query', (metric, groupBy, query) => {
    expect(insightsQuery('ClaudeMaster', resolveMetric(metric, groupBy))).toBe(query)
  })

  it('quotes Metrics Insights keywords used as dimension names', () => {
    const resolved = {
      name: 'claude_master.auth.refresh',
      statistic: 'SUM' as const,
      groupBy: 'result' as const,
    }
    expect(insightsQuery('ClaudeMaster', resolved)).toBe(
      'SELECT SUM("claude_master.auth.refresh") FROM "ClaudeMaster" GROUP BY "result"',
    )
  })

  it('refuses a split claude-master does not emit instead of returning nothing', () => {
    expect(() => resolveMetric('errors', 'model')).toThrow(UnsupportedQueryError)
    expect(() => resolveMetric('errors', 'client')).toThrow('does not emit errors split by client')
    expect(() => resolveMetric('backupRequests', 'profile')).toThrow(UnsupportedQueryError)
  })

  it('lists every split it accepts, and accepts every split it lists', () => {
    expect(groupableBy('requests').sort()).toEqual(
      ['client', 'client_account', 'model', 'profile', 'status_class'].sort(),
    )
    for (const metric of new Set(GOLDEN.map(([m]) => m))) {
      for (const dimension of groupableBy(metric)) {
        expect(() => resolveMetric(metric, dimension)).not.toThrow()
      }
    }
  })
})
