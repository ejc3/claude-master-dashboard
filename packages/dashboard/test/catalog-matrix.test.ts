import { describe, expect, it } from 'vitest'
import {
  type Dimension,
  insightsQuery,
  resolveMetric,
  type SemanticMetric,
  UnsupportedQueryError,
} from '../src/core/index.js'

// The attributes each metric carries, written out from claude-master's metrics.go
// (internal/claudemaster/metrics.go, observeRequest and the routing/quota recorders), not from
// the catalog: a catalog change that accepts a split the proxy does not emit fails here.
const EMITTED: Record<string, readonly Dimension[]> = {
  'claude_master.inference.requests': ['profile', 'client_account', 'status_class'],
  'claude_master.inference.requests.by_client': ['client', 'client_account'],
  'claude_master.inference.requests.by_model': ['model', 'status_class'],
  'claude_master.inference.errors': ['profile', 'status', 'client_account'],
  'claude_master.routing.switches': ['from', 'to', 'reason'],
  'claude_master.quota.rate_limited': ['profile'],
  'claude_master.routing.backup_requests': [],
  'claude_master.inference.ttfb': ['profile', 'status_class'],
  'claude_master.inference.ttfb.by_model': ['model'],
  'claude_master.inference.duration': ['profile', 'status_class'],
  'claude_master.inference.duration.by_model': ['model'],
  'claude_master.inference.upstream_ttfb': ['profile', 'status_class'],
  'claude_master.proxy.overhead': ['profile'],
  'claude_master.quota.used_fraction': ['profile'],
  'claude_master.quota.resets_in_seconds': ['profile'],
  'claude_master.auth.token_expires_in_seconds': ['profile'],
}

const METRICS: SemanticMetric[] = [
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
const DIMENSIONS: Dimension[] = [
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

describe('catalog against what claude-master emits', () => {
  for (const metric of METRICS) {
    it(`${metric}: the total and every split resolve to an emitted metric carrying that split`, () => {
      const total = resolveMetric(metric)
      expect(EMITTED[total.name]).toBeDefined()
      for (const dimension of DIMENSIONS) {
        // Some emitted metric of this family carries the split: the catalog must offer it.
        let resolved: ReturnType<typeof resolveMetric> | null = null
        try {
          resolved = resolveMetric(metric, dimension)
        } catch (error) {
          expect(error).toBeInstanceOf(UnsupportedQueryError)
        }
        if (resolved !== null) {
          expect(EMITTED[resolved.name], `${resolved.name} is not emitted`).toContain(dimension)
          expect(resolved.statistic).toBe(total.statistic)
        } else {
          expect(EMITTED[total.name]).not.toContain(dimension)
        }
      }
    })
  }

  it('refuses a namespace that would need escaping inside the query', () => {
    expect(() => insightsQuery('Demo"Metrics', resolveMetric('requests'))).toThrow()
    expect(() => insightsQuery('', resolveMetric('requests'))).toThrow()
    expect(insightsQuery('Team/Claude-Master_1', resolveMetric('requests'))).toBe(
      'SELECT SUM("claude_master.inference.requests") FROM "Team/Claude-Master_1"',
    )
  })

  it('quotes from and to, which are query keywords', () => {
    expect(insightsQuery('ClaudeMaster', resolveMetric('switches', 'from'))).toBe(
      'SELECT SUM("claude_master.routing.switches") FROM "ClaudeMaster" GROUP BY "from"',
    )
  })
})
