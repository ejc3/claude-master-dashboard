# Architecture

A dashboard for [claude-master](https://github.com/ejc3/CLIProxyAPI/blob/main/docs/claude-master.md)
telemetry: which subscription has headroom, when each window resets, who uses the pool, and
whether requests succeed. It ships as a package that any Next.js app mounts, plus a reference app
that deploys it. This document is the design; [Delivery](#delivery) lists which parts exist.

## Data path

```
claude-master ──OTLP/HTTP──▶ CloudWatch agent ──▶ CloudWatch namespace "ClaudeMaster"
                                                          │ GetMetricData (Metrics Insights)
                                  Next.js route handler ◀─┘  (server-only, read-only AWS key)
                                          │ JSON
                                  dashboard components (browser)
```

claude-master splits each metric the dashboard reads by at most three attributes, with one
projection per axis
(`claude_master.inference.requests` by profile, account and status class;
`…requests.by_client` by box; `…requests.by_model` by model). CloudWatch keeps the OpenTelemetry
name as the metric name and every attribute as a dimension, plus the resource's `service.name`.
(`claude_master.anthropic.ratelimit.state` carries a fourth attribute; the dashboard does not
read it.) Counters arrive as deltas, so a sum
is a count. Histograms arrive as statistic sets without percentiles, so latency percentiles come
from the proxy's own `duration_quantile` gauges.

## Package

`packages/dashboard` (`@ejc3/claude-master-dashboard`):

| Entry | Contents | Runs in | Step |
|---|---|---|---|
| `.` | Types, the `MetricsSource` interface, the metric catalog, pacing, query limits | anywhere | 1 |
| `./demo` | A reproducible fixture source | anywhere | 1 |
| `./react` | The dashboard components | browser | 2 |
| `./next` | `DashboardPage` and `createDashboardHandler(config)` | server | 2 |
| `./access` | `cloudflareAccess()`: verifies the Cloudflare Access assertion | server | 3 |
| `./cloudwatch` | The CloudWatch source; `@aws-sdk/client-cloudwatch` is a peer dependency | Node | 3 |

From step 2, a host app mounts it with two files:

```ts
// app/claude-master/[[...slug]]/page.tsx
export default function Page() {
  return <DashboardPage config={config} />
}

// app/api/claude-master/[...path]/route.ts
export const { GET } = createDashboardHandler(config)
```

### Invariants

- **Semantic queries only.** Views ask for `requests` split by `client`, never a metric name.
  The catalog (`src/core/catalog.ts`) resolves that to the emitted metric and refuses a split the
  proxy does not emit (`UnsupportedQueryError`) instead of returning an empty chart. Its Metrics
  Insights queries are tested against the queries proven on the live API.
- **Every source behaves alike.** Every source runs `validateSeriesQuery` (whole-minute steps,
  at most 15 days and 1,500 points), refuses the same splits, buckets on step boundaries with
  the range end exclusive (as GetMetricData does), and sums counters so a split adds up to its
  total. CloudWatch leaves out empty buckets and groups with no data, so views treat a missing
  bucket as zero and a missing group as absent.
- **Times are absolute.** A source turns `resets_in_seconds` into `resetsAt` (sample time plus
  value), and the browser counts down from it locally; every snapshot carries `asOf`.
- **Credentials stay on the server.** The CloudWatch source and its AWS credentials exist only
  in route handlers; the browser receives JSON.
- **No anonymous mount.** `createDashboardHandler` and `DashboardPage` require an
  `authorize(request)` callback; there is no default that allows everyone.

## Hosting, sign-in and access to AWS

The reference app runs as a Cloudflare Worker (Next.js through OpenNext). Cloudflare Access gates
every URL of the Worker: an Access application with the Worker as its destination, signing people
in with the account's existing Google identity provider and admitting the addresses its policy
lists. The app checks again: `cloudflareAccess()` verifies the `Cf-Access-Jwt-Assertion` header
(signature against the team's published keys, issuer, the application's audience tag, expiry, and
optionally an email allowlist), so a request that did not come through that Access application is
refused. With no Access settings configured the app admits nobody.

The Worker reads CloudWatch with an access key for an IAM user allowed only
`cloudwatch:GetMetricData` and `cloudwatch:ListMetrics` in one region, stored as Worker secrets.
CloudWatch read actions cannot be narrowed to one namespace, so the code, not IAM, limits reads to
`ClaudeMaster`. GetMetricData is billed per metric read, so the handler caches each query per
step-aligned time range and coalesces identical requests in flight; the snapshot refreshes every
minute and charts every five, and only while the tab is visible.

## Freshness

A reading reaches CloudWatch two to four minutes after the request (the proxy exports every
60 seconds, the agent collects every 60 seconds, then ingestion). Quotas and resets change on
that scale. `MetricsSource` separates `snapshot()` from `series()`, so a live status endpoint on
the proxy can serve the snapshot later while CloudWatch serves history.

## Delivery

Each step is its own pull request, stacked on the previous one:

1. Workspace, core types, catalog, pacing, demo source, CI.
2. The components and the reference app on demo data.
3. Cloudflare Access sign-in and the Worker build and deploy.
4. The CloudWatch source, cache and coalescing, and the catalog's snapshot metrics (quota band,
   cooldown, latency quantiles, sessions, connections, Anthropic's per-window utilization).
5. Production on CloudWatch.

Configuration that names a real account, key, team, person or host lives in the Worker's secrets,
never in this repository. `docs/deploy.md` lists them.
