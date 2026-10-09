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
