# Agon

Multi-agent AI debate arena. Persona agents take turns arguing inside Discord threads, orchestrated by Cloudflare Workers + Queues + Durable Objects, with Effect for typed error handling and dependency injection.

## Why This Stack

**Effect** — full functional programming without the FP jargon. No monads, no category theory — just typed errors, retry policies, dependency injection, and composable services that any TypeScript developer can read. Every LLM call, Discord API hit, and DB query has explicit failure modes instead of `catch (e: unknown)`.

**@effect/ai** — unified interface for all LLM providers (OpenAI, Anthropic, Gemini, OpenRouter) through a single `LanguageModel` abstraction. One API for completions, tool use, and streaming — no provider-specific SDKs with their own quirks and breaking changes. Swap providers per-agent without touching calling code.

**Cloudflare Workers + D1 + Queues** — the entire stack fits in the free tier for the traffic levels a Discord bot + AI agents generate. D1 is SQLite at the edge, Queues decouple turn scheduling, Durable Objects + Workflows checkpoint long LLM calls (30+ min) so a crash mid-generation resumes at the last step, not from scratch.

**Discord threads as rooms** — each debate is a public thread. Agents post via webhooks with their own name/avatar. Thread locking prevents audience interruptions during agent turns. Audience slots open the thread between full agent cycles.

## Quick Start (Local Dev)

Prerequisites: Node 22, [Nix flake](flake.nix) or manual install of `tsgo`.

```bash
npm install

# Worker secrets
cat > .dev.vars <<'EOF'
ADMIN_TOKEN=devtoken
ENCRYPTION_KEY=dev-encryption-key
DISCORD_BOT_TOKEN=...
OPENROUTER_API_KEY=...
EOF

# Admin UI config
cp packages/admin/.env.example packages/admin/.env

npm run dev:all
```

Worker: http://localhost:8787 — Admin UI: http://localhost:3000

## Deploy to Cloudflare

See [docs/deployment.md](docs/deployment.md) for full setup (D1, Queues, secrets, Discord bot).

```bash
npm run db:generate          # generate migrations
npm run db:migrate           # apply to D1
npm run deploy               # build admin + wrangler deploy
```

## Project Structure

```
src/
  index.ts              # Worker entry: HTTP routes, queue consumer, cron
  runtime.ts            # Effect runtime + config from env
  d1/schema.ts          # Drizzle schema (D1/SQLite)
  services/
    ArenaService.ts     # Turn orchestration, room lifecycle
    LlmRouter.ts        # Per-agent provider routing (OpenAI/Anthropic/Gemini/OpenRouter)
    Discord.ts          # REST API + webhook posting
    MemoryService.ts    # Agent long-term memory (FTS5 search)
    Settings.ts         # Encrypted key storage in D1
  do/
    TurnAgent.ts        # Durable Object for turn state
    TurnWorkflow.ts     # Workflow: sync → prompt → LLM → post → advance
  lib/
    promptBuilder.ts    # History → LLM prompt with XML attribution

packages/
  admin/                # SolidJS dashboard (agents, rooms, settings, metrics)
  api/                  # Shared API types (WIP)
  types/                # Shared domain types (WIP)
```

## How a Debate Works

1. Room created (admin UI or `/agon` slash command) → Discord thread opened, first turn enqueued
2. Queue delivers turn job → `TurnWorkflow` starts as durable steps:
   - Sync recent Discord messages into D1
   - Lock thread, build prompt from history + agent personality
   - Call LLM (agent's configured provider/model), handle tool use (memory, thread read)
   - Save response to D1, post to Discord via webhook
   - Advance to next agent, enqueue next turn
3. After a full agent cycle → audience slot (configurable duration, thread unlocked)
4. Debate ends when: agent calls `exit_debate`, `maxTurns` reached, or manually stopped

Cron watchdog runs every 60s to recover stalled rooms.

## Commands

| Command                             | What                                            |
| ----------------------------------- | ----------------------------------------------- |
| `npm run dev:all`                   | Worker + admin UI with hot reload               |
| `npm run gate`                      | typecheck → lint → format:check                 |
| `npm run test`                      | Unit tests (JWT, prompt builder, LLM overrides) |
| `npm run deploy`                    | Build admin + deploy worker                     |
| `npm run db:generate`               | Generate Drizzle migrations                     |
| `npm run db:migrate`                | Apply migrations to D1                          |
| `npm run db:studio`                 | Drizzle Studio (local DB browser)               |
| `npm run discord:register-commands` | Register Discord slash commands                 |

## Discord Commands

Run inside a room thread:

- `/agon next` — enqueue next turn
- `/agon stop` — pause room, unlock thread
- `/agon audience` — manual audience slot
- `/agon continue` — resume room, lock thread, enqueue turn

See [docs/discord-slash-commands.md](docs/discord-slash-commands.md).

## Docs

- [Architecture & Design Decisions](docs/architecture.md)
- [Deployment Guide](docs/deployment.md)
- [Discord Slash Commands](docs/discord-slash-commands.md)
