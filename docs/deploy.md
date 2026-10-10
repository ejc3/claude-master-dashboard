# Deploying

The reference app (`apps/web`) deploys as the Cloudflare Worker `claude-master-dashboard`. The
`Deploy` workflow checks, builds and deploys it on every push to `main`.

## What lives where

**This repository:** the Worker's code and its URL switches in `apps/web/wrangler.jsonc`.

**`ejc3/aws` (Terraform, `claude-master-dashboard-site.tf`):**
- **The Access application.** It has the Worker as its destination, so once the URLs are on it gates workers.dev and every preview URL. It signs people in with the account's existing Google and one-time-PIN providers (no new OAuth client), and its policy admits the dashboard's operators.
- **The read-only AWS key.** It is limited to `cloudwatch:GetMetricData` and `cloudwatch:ListMetrics` in one region, and kept in Secrets Manager.

**`ejc3/aws` (Terraform, `workers-deploy.tf`):** the account's Workers deploy token, shared by the site repositories.

**Set by hand, once:**
- the token as the `CLOUDFLARE_API_TOKEN` secret of this repository's `production` environment, with `scripts/workers-deploy-secret.sh` in `ejc3/aws` or `gh secret set --env production`;
- the account id as the environment's `CLOUDFLARE_ACCOUNT_ID` variable;
- the Worker secrets below.

The `production` environment's deployment branches are limited to `main`, so only the Deploy workflow on `main` can read the token. Until the token exists, the deploy step reports that it skipped.

## Order

An Access application can name a Worker only by its id, which exists after the first deploy:

1. **First deploy.** Merge with `workers_dev` and `preview_urls` false. The first deploy creates the Worker with no public URL.
2. **Adopt the Worker.** Put the Worker's id in `ejc3/aws` and apply. The Access application adopts the Worker; nothing is reachable yet.
3. **Turn the URL on.** Turn `workers_dev` on, here and in `ejc3/aws`, and apply. The URL opens only after Access already covers it.

## Worker secrets

Set from `apps/web` with `wrangler secret put <NAME>`, reading the value from standard input, never the command line. Secrets survive deploys.

| Name | Value |
|---|---|
| `CF_ACCESS_TEAM_DOMAIN` | The Access team domain, `https://<team>.cloudflareaccess.com` (Terraform output) |
| `CF_ACCESS_AUD` | The Access application's audience tag (Terraform output) |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` | The read-only key, from its Secrets Manager secret (read by the CloudWatch source) |
| `DASHBOARD_ALLOWED_EMAILS` | Required. The addresses admitted, comma-separated. The app checks the address in the Access assertion against it, so a policy widened by mistake in Access admits no one new |
| `DASHBOARD_SERVICE_TOKEN_CLIENT_ID` | Optional. Admits that service token. Access issues one only if the application has a service-auth policy for it, and none is configured |

Without a valid `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` and `DASHBOARD_ALLOWED_EMAILS` the app admits nobody and logs why. Set `DASHBOARD_ALLOWED_EMAILS` before deploying a build that requires it.

Never put secrets in `apps/web/.env*`. OpenNext embeds those files in the Worker it builds. The Deploy workflow fails if a build embeds any.

## After the first deploy with the URL on

- **Not signed in:** a request is redirected to the Access sign-in.
- **Signed in as an operator:** `/api/claude-master/snapshot` answers 200.
- **Bypassing Access:** a request sent straight to the Worker with a made-up `Cf-Access-Jwt-Assertion` header answers 401.
