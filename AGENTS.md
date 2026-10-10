# AGENTS.md

A Next.js-mountable dashboard for claude-master telemetry. Design: `docs/architecture.md`.

## Commands

```bash
pnpm install
pnpm check       # biome
pnpm typecheck   # tsc, strict
pnpm test        # vitest
```

## Rules

- `apps/web` pins Next 16.3.8: under OpenNext 1.20.10, Next 16.4 builds and passes
  `wrangler deploy --dry-run` but every request fails at runtime (`Unexpected
  loadManifest(/.next/server/preview-props.json)`). Before raising either version, run the built
  Worker (`pnpm --filter web cf:build`, then `wrangler dev` with an explicit port) and load a page.

- TypeScript stays strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`). Fix types; do not cast around them.
- Relative imports inside `packages/dashboard` are extensionless. The package is always bundled
  by its host (Next `transpilePackages`, Vitest), and Turbopack does not resolve a `.js` or
  `.jsx` specifier to a `.tsx` file.
- Views and sources ask the catalog for semantic metrics; metric names live in
  `src/core/catalog.ts` (tests and docs may quote them).
- Nothing from a real deployment goes into this public repository: no AWS account or role ARN,
  Cloudflare Access team or audience, email address, host name, profile name or model id from a real setup. Tests and
  examples use made-up values (`alpha`, `box-1`, `claude-model-large`).
- Never put secrets in `apps/web/.env*`: OpenNext embeds those files in the Worker it builds, and
  the Deploy workflow fails if a build embeds any. Deploys happen only from that workflow.
- Each change is its own pull request: the gate above, then `/code-review` and an independent
  `codex exec -s read-only` pass, then green CI.

## Two clouds: Vercel and Cloudflare (standing rule)

This app must deploy to Cloudflare Workers and to Vercel. Today it deploys to Cloudflare only
(the Worker `claude-master-dashboard`, from `.github/workflows/deploy.yml`); both are supported
targets, always:

- **A change is done only when it works on both.** Every deploy the app has must be green
  before merging. Do not merge a change that builds or runs on only one.
- **No platform-only code without a path on the other.** Avoid Vercel-only runtime features
  (`@vercel/*` storage or edge APIs, Vercel-specific headers) and Node APIs the Workers runtime
  lacks (runtime filesystem access, `fetch(..., { redirect: 'error' })`, which Workers
  rejects). When one is unavoidable, give the other platform an equivalent and test both.
- **Secrets live in AWS Secrets Manager** (administered from `ejc3/aws`) and are set as Worker
  secrets from there, each on stdin: the read-only CloudWatch key from
  `claude-master-dashboard/aws-reader`, the allowlist from `people/addresses`, the account
  aliases built from `claude-master/account-labels`, and the Access values from `terraform
  output claude_master_dashboard` in ejc3/aws. A Vercel copy takes the same values from the
  same containers. A secret changed on one platform only is a bug. Never commit one, never
  print one.
- **Public build-time values** (`NEXT_PUBLIC_*`) come from the repository's Actions variables
  for the Cloudflare build; a Vercel copy must use the same values.

Vercel: not deployed yet (tracked in ejc3/aws); until it is, a change must not add anything
that would block it.
