# Agent Instructions

**Agon** — Serverless AI debate arena using Cloudflare Workers, Effect, and Discord Webhooks.

<!-- effect-solutions:start -->

## Effect Best Practices

**IMPORTANT:** Always consult effect-solutions before writing Effect code.

1. Run `effect-solutions list` to see available guides
2. Run `effect-solutions show <topic>...` for relevant patterns (supports multiple topics)
3. Search `.reference/effect/` for real implementations (run `effect-solutions setup` first)

Topics: quick-start, project-setup, tsconfig, basics, services-and-layers, data-modeling, error-handling, config, testing, cli.

Never guess at Effect patterns - check the guide first.

<!-- effect-solutions:end -->

## Project Structure

```
src/                    # Cloudflare Worker API
  d1/                   # Database schema
  lib/                  # Shared utilities
  services/             # Business logic
  index.ts              # Worker entry point

packages/
  admin/                # SolidJS admin UI
  api/                  # Shared API types/client
  types/                # Shared domain types
```

## Reference Code

**AI/LLM Integration**: See `~/projects/ribelo/erg` for effect/ai usage patterns.

- Provider implementations: `packages/core/src/ai/providers/`
- OpenAI completions: `packages/core/src/ai/providers/openaiCompletions.ts`
- Model resolution: `packages/core/src/ai/modelResolution.ts`

Cloning code from erg is explicitly allowed.

**Local Effect Source**: Search `.reference/effect/` for Effect implementation patterns and API details.

## Issue Tracking

Uses **bd** (beads). Run `bd onboard` to get started.

## Quality Gate

```bash
npm run gate          # typecheck → lint → format:check
```

Must pass before claiming work is done.

## Dev (one command)

1. Set the worker admin token (Wrangler loads this from `.dev.vars`):

```bash
cat > .dev.vars <<'EOF'
ADMIN_TOKEN=devtoken
EOF
```

2. Set the admin UI token (Vite loads this from `packages/admin/.env`):

```bash
cp packages/admin/.env.example packages/admin/.env
# edit if needed
```

NOTE: `VITE_*` env vars are exposed to the browser bundle by design. Only use
`VITE_ADMIN_TOKEN` for local dev or when the admin UI is strictly internal / behind
Cloudflare Access. `packages/admin/.env` is gitignored to prevent accidental commits.

3. Run everything:

```bash
npm run dev:all
```

- Starts the worker via `wrangler dev` (default http://localhost:8787)
- Starts the admin UI at http://localhost:3000 and proxies `/admin/*` to the worker

## Toolchain Notes

- `npm run typecheck` uses `tsgo` (TypeScript-Go) rather than `tsc`.
- Ensure `tsgo` is available on your PATH (in the author's Nix setup it typically lives at `/run/current-system/sw/bin/tsgo`).

## Landing the Plane

Work is NOT complete until `git push` succeeds:

```bash
git pull --rebase
bd sync
git push
git status  # MUST show "up to date with origin"
```
