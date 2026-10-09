# Deploying

The reference app (`apps/web`) deploys as the Cloudflare Worker `claude-master-dashboard`. The
`Deploy` workflow builds and deploys it on every push to `main`.

## What the Cloudflare account provides

Managed outside this repository (Terraform):

- An Access application whose destination is the Worker, so every URL of it (workers.dev
  included) requires sign-in. Its policy admits the dashboard's operators; it reuses the
  account's existing Google identity provider, so no new OAuth client is needed.
- An API token limited to Workers scripts, stored as this repository's `CLOUDFLARE_API_TOKEN`
  secret, and the account id as the `CLOUDFLARE_ACCOUNT_ID` variable.
- A read-only AWS key (`cloudwatch:GetMetricData`, `cloudwatch:ListMetrics`) for the
  CloudWatch source.

Until the token exists, the deploy step reports that it skipped and succeeds.

## Worker secrets

Set once with `wrangler secret put <NAME>` from `apps/web` (the value is read from standard input,
never the command line). Secrets survive deploys.

| Name | Value |
|---|---|
| `CF_ACCESS_TEAM_DOMAIN` | The Access team domain, `https://<team>.cloudflareaccess.com` |
| `CF_ACCESS_AUD` | The Access application's audience tag |
| `DASHBOARD_ALLOWED_EMAILS` | Optional: addresses admitted on top of the Access policy, comma-separated |
| `DASHBOARD_SERVICE_TOKEN_CLIENT_ID` | Optional: a service token admitted for automated checks |

Without `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` the app admits nobody.
