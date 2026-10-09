# claude-master dashboard

Which subscription has headroom, when each window resets, who uses the pool, and whether
requests succeed: a dashboard for [claude-master](https://github.com/ejc3/CLIProxyAPI/blob/main/docs/claude-master.md)
telemetry, packaged to mount in any Next.js app.

Design and delivery plan: [docs/architecture.md](docs/architecture.md).

## Mount it in a Next.js app

```ts
// next.config.ts
export default { transpilePackages: ['@ejc3/claude-master-dashboard'] }

// app/layout.tsx
import '@ejc3/claude-master-dashboard/styles.css'

// app/api/claude-master/[...path]/route.ts
import { createDashboardHandler } from '@ejc3/claude-master-dashboard/next'
export const { GET } = createDashboardHandler({ source, authorize })

// app/claude-master/page.tsx
import { DashboardPage } from '@ejc3/claude-master-dashboard/next'
export default function Page() {
  return (
    <DashboardPage source={source} authorize={allowed} apiBase="/api/claude-master" unauthorized={<SignIn />} />
  )
}
```

`source` returns a `MetricsSource` (`createDemoSource()` from `@ejc3/claude-master-dashboard/demo`
until a CloudWatch source is configured). `authorize` is required; nothing is served without it.

Behind Cloudflare Access, create one checker per process (it caches the team's keys) and use it in
both places:

```ts
import { ACCESS_ASSERTION_HEADER, cloudflareAccess } from '@ejc3/claude-master-dashboard/access'
import { headers } from 'next/headers'

const access = cloudflareAccess({ teamDomain, audience })
// route handler: takes the request
export const { GET } = createDashboardHandler({ source, authorize: access.authorize })
// page: reads the incoming request's headers
const allowed = async () =>
  (await access.identify((await headers()).get(ACCESS_ASSERTION_HEADER))) !== null
```

`apps/web/lib/dashboard.ts` does this, reading the settings from Worker secrets.

The reference app deploys as a Cloudflare Worker: see [docs/deploy.md](docs/deploy.md).
The fonts are optional: set `--cmd-font-sans` and `--cmd-font-condensed` (the reference app uses
Barlow and Barlow Condensed through `next/font`).

## Develop

```bash
pnpm install
pnpm check && pnpm typecheck && pnpm test
cp apps/web/.env.example apps/web/.env.local   # DASHBOARD_AUTH=off skips Access locally
cd apps/web && PORT=<port> pnpm dev
```

Next reads `PORT` from the environment before it loads `.env.local`, so pass it on the command
line. Open the app as `http://localhost:<port>`: Next's development server serves its scripts
only to its own origin.
