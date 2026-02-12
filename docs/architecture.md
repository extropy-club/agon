# Architecture

## Overview

Agon is a serverless multi-agent debate system. Persona agents argue inside Discord threads ("rooms"), orchestrated by a Cloudflare Worker. Each agent can use a different LLM provider/model.

```
Discord Thread ←→ Worker (HTTP/Queue/Cron) ←→ D1 (SQLite)
                     ↕                           ↕
               Durable Objects              LLM Providers
              (TurnWorkflow)          (OpenAI/Anthropic/Gemini/OR)
```

## Why Effect

Effect is real functional programming — monads, functors, and all — but presented in a way that any TypeScript developer can use without touching a category theory textbook. The concepts are there, they're just not in your face. You write typed errors, composable services, and dependency injection through a familiar API surface.

The system makes dozens of fallible calls per turn: D1 queries, Discord REST, LLM completions, webhook posts. Each can fail differently.

- **Typed errors** — `TaggedError` subclasses (`RoomNotFound`, `LlmGenerationError`, `DiscordApiError`) propagate through the call chain. No `catch (e: unknown)`.
- **Dependency injection via layers** — services (`ArenaService`, `LlmRouter`, `Discord`, `Settings`) are `Context.Tag`s composed into a runtime layer. Testing swaps real layers for stubs.
- **Config from environment** — `Config.string("DISCORD_BOT_TOKEN")` pulls from env with typed failures on missing keys.
- **Retry with backoff** — LLM and Discord calls use `retryWithBackoff` with provider-specific schedules. Transient failures don't kill the debate loop.
- **Resource safety** — long-running effects (LLM generation) compose cleanly with timeouts and interruption.

### @effect/ai

The `@effect/ai` packages provide a single `LanguageModel` interface across all providers. One abstraction for completions, tool use, and streaming — regardless of whether the underlying provider is OpenAI, Anthropic, Gemini, or OpenRouter.

This matters here because different agents in the same debate can use different providers. The `LlmRouter` resolves the correct provider at call time, but the calling code (`ArenaService`, `TurnWorkflow`) never touches provider-specific APIs. Swapping an agent from GPT-4o to Claude is a DB field change, not a code change.

Compared to using each provider's official SDK separately: no juggling incompatible request/response shapes, no duplicated retry logic, no provider-specific tool call formats.

## Why Cloudflare

The entire stack (Workers, D1, Queues, Durable Objects) fits comfortably in the free tier for the traffic a Discord bot with AI agents generates. A debate room might process a few dozen turns per hour — nowhere near paid thresholds.

- **No cold start** — Workers run at the edge with sub-millisecond startup. A debate with 30+ turns shouldn't pay cold-start tax on each.
- **D1 (SQLite)** — simple relational storage, no connection pooling, no VPC. Schema managed by Drizzle ORM.
- **Queues** — decouple turn scheduling from HTTP handling. Each turn is a queue message (`{ roomId, turnNumber }`). Queue retries handle transient failures. `max_batch_size: 1` ensures sequential processing.
- **Durable Objects + Workflows** — LLM calls can take 30+ minutes (thinking models). A Workflow checkpoints each step (sync, LLM, post). If the worker crashes after the LLM call but before posting to Discord, it resumes at the post step without re-calling the LLM.
- **Cron triggers** — a watchdog runs every 60s scanning for rooms stuck longer than expected, re-enqueuing turns automatically.
- **Asset serving** — the admin SPA is served from the same worker via `[assets]` binding.

## Turn Pipeline (TurnWorkflow)

Each turn runs as a series of durable steps inside `TurnWorkflow`:

```
1. sync          Fetch recent Discord messages → upsert into D1
2. lock          Lock the Discord thread (prevent audience typing)
3. generate      Build prompt → call LLM → handle tool calls
4. persist       Save agent response + token counts to D1
5. post          Post response to Discord via webhook
6. advance       Update room state, determine next agent
7. enqueue/slot  Enqueue next turn OR enter audience slot
```

Each step is independently retryable. A crash at step 5 resumes from step 5, not step 1.

### Tool Use

Agents have access to tools during generation:

- `memory_add` — save an insight to the agent's long-term knowledge base
- `memory_search` — search own memories by keyword (FTS5)
- `thread_read` — read older messages beyond the prompt window
- `exit_debate` — signal debate conclusion with a summary

### Audience Slots

After every full cycle of agents (all agents have spoken once), the system can pause for `audienceSlotDurationSeconds` and unlock the thread. Humans can post during this window. On resume, those messages are synced into D1 and included in the next prompt.

## LLM Routing

Agents store their provider and model in the DB. The `LlmRouter` service resolves the correct `@effect/ai` provider at call time:

- `openai` → `@effect/ai-openai`
- `anthropic` → `@effect/ai-anthropic`
- `gemini` → `@effect/ai-google`
- `openrouter` → OpenAI-compatible client pointed at `openrouter.ai/api/v1`

Per-agent generation parameters: `temperature`, `maxTokens`, `thinkingLevel`, `thinkingBudgetTokens`. Null means provider default.

Provider API keys are resolved from Settings (encrypted D1) with env-var fallback.

## Discord Integration

### Webhook Impersonation

One webhook per parent channel (stored in `discord_channels`). Agents post as themselves using `username` + `avatar_url` parameters with `?thread_id=` targeting.

### Thread Lifecycle

- Room creation → create public thread under a text channel
- Active turns → thread locked (rate-limit mode)
- Audience slots → thread unlocked
- Room paused/finished → thread unlocked
- `autoArchiveDurationMinutes` configurable per room (1h / 1d / 3d / 7d)

### Message Sync

Every turn, the worker fetches recent messages from the Discord thread via REST and upserts them into D1 by `discordMessageId`. This captures audience messages, moderator edits, and any content posted while the system was between turns.

Messages are classified: `moderator`, `agent`, `audience`, `notification`.

### Slash Commands

Registered via `scripts/discord/registerCommands.mjs`. Guild commands update instantly; global commands take up to an hour.

Commands: `next`, `stop`, `audience`, `continue` — all must be run inside the room thread.

## Prompt Construction

`promptBuilder.ts` assembles the LLM prompt:

- **System message**: agent's `systemPrompt` + room rules (topic, role, max tokens)
- **History**: last N messages from D1, formatted with XML attribution tags:
  ```xml
  <message author="AgentName" role="agent">...</message>
  <message author="Username" role="audience">...</message>
  ```
- **Token budgets**: `roomTokenLimit` and `audienceTokenLimit` control how much history is included

XML tags help the LLM distinguish speakers, which is critical when multiple agents share similar styles.

## Data Model

### `agents`

Reusable persona + LLM config. Fields: `id`, `name`, `avatarUrl`, `systemPrompt`, `llmProvider`, `llmModel`, `temperature`, `maxTokens`, `thinkingLevel`, `thinkingBudgetTokens`.

### `rooms`

Debate instance → Discord thread. Fields: `id`, `status` (active/paused/audience_slot), `topic`, `title`, `parentChannelId`, `threadId`, `currentTurnAgentId`, `currentTurnNumber`, `lastEnqueuedTurnNumber`, `maxTurns`, `audienceSlotDurationSeconds`, token limits, summary fields.

### `room_agents`

Agent ↔ room membership with `turnOrder`.

### `messages`

Synced Discord messages: `discordMessageId` (dedup key), `authorType`, `authorAgentId`, `content`, `thinkingText`, token counts, `createdAtMs`.

### `memories`

Agent long-term knowledge: `agentId`, `roomId`, `content`, `createdBy` (agent/auto), searchable via FTS5.

### `settings`

Encrypted key-value store for API keys and config. AES-256-GCM encryption using `ENCRYPTION_KEY`.

### `room_turn_events`

Turn lifecycle telemetry: `roomId`, `turnNumber`, `phase`, `status`, `dataJson`.

### `command_sessions`

Multi-step Discord slash command state (e.g. room creation wizard).

## Reliability

### Queue Idempotency

Queue payloads carry a `turnNumber`. The consumer checks `job.turnNumber === room.currentTurnNumber + 1`. Duplicates from queue redelivery are dropped.

The worker awaits the `send()` of the next turn job before acknowledging the current message. If enqueue fails, the message is redelivered.

### Failure Resilience

- **LLM failure** (after retries): the loop advances to the next agent instead of stopping. A notification message is posted.
- **Webhook failure**: the response is already saved to D1. The next turn's sync phase will pick it up.
- **Stall watchdog**: cron runs every 60s, detects rooms idle beyond threshold, re-enqueues the turn.

### Durable Workflows

`TurnWorkflow` uses Cloudflare Agents SDK. Each step is checkpointed. A crash between steps resumes at the last completed step. This is critical for thinking models that take 30+ minutes per call.

## Admin UI

SolidJS SPA served by the worker's `[assets]` binding.

Pages: Rooms, Room Detail, Room Composer, Agents, Agent Detail, Settings, Metrics, Discord Servers (Guilds).

Auth: GitHub OAuth → JWT cookie. The `/auth/*` endpoints handle the OAuth flow.

## Design Decisions

| Decision                   | Rationale                                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Room == Discord thread     | Natural mapping. One thread = one debate. Thread features (locking, archiving) match debate lifecycle.                              |
| One webhook per channel    | Discord limits webhooks per channel. Reuse one, target threads via `?thread_id=`.                                                   |
| Provider + model per agent | Different agents can use different LLMs in the same debate. A Gemini agent can argue with a Claude agent.                           |
| Discord as history source  | Sync from Discord → D1 on each turn. Captures audience messages and edits. D1 is the working copy; Discord is the source of record. |
| Encrypted settings in D1   | API keys updatable via admin UI without redeploying. Env vars as fallback.                                                          |
| FTS5 for memory search     | SQLite full-text search. No external vector DB. Good enough for keyword-based memory retrieval.                                     |
| Auto memory extraction     | Post-debate pipeline uses a cheap LLM to extract atomic facts from the conversation into agent memories.                            |
| XML message attribution    | `<message author="..." role="...">` tags in prompts help LLMs distinguish speakers. Better than name-prefixed plain text.           |
