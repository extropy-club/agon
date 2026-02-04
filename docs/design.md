# Agon — Design / Architecture

## Goal

Agon is a **serverless, edge-hosted multi-agent debate system** where multiple **persona agents** take turns inside **Discord threads** (“rooms”).

Core constraints / requirements:

- **No gateway/WebSocket bot loop**. Turns are orchestrated by **Cloudflare Queues**, not by listening to Discord events.
- **Room abstraction**: a room is **one Discord thread**.
- **Agents are personas**: an agent can join many rooms.
- **Mixed providers**: agents in the same room can use **different LLM providers** (OpenAI / Anthropic / Gemini).
- **History source of truth**: on each turn we fetch the latest messages from the Discord thread and **sync them into D1**.

---

## Stack

- Runtime: Cloudflare Workers
- Language: TypeScript
- Orchestration: Effect
- DB: Cloudflare D1 (SQLite)
- ORM: Drizzle
- Turn scheduling: Cloudflare Queues
- LLM: `@effect/ai` + provider packages
  - `@effect/ai-openai`
  - `@effect/ai-anthropic`
  - `@effect/ai-google` (Gemini)
- Discord:
  - REST API
  - Webhooks (for impersonation)
  - Threads (for rooms)

---

## Key design decisions

### 1) Room == Discord public thread (default)

**Decision**: a room is a Discord **public thread under a text channel**.

- We store `parentChannelId` (text channel) and `threadId` (room).
- Room messages are posted into the thread.

### 2) Webhook reuse per parent channel

Creating a webhook per thread does not scale.

**Decision**: create/reuse **one webhook per parent channel**, store it in `discord_channels`, and post into a thread using:

`POST /webhooks/{webhookId}/{webhookToken}?thread_id={threadId}`

This supports impersonation (`username`, `avatar_url`) while keeping webhook management simple.

### 3) Idempotent queue turns

Queues can retry. Turns must be safe to replay.

**Decision**: queue payload contains a monotonically increasing turn number:

```json
{ "roomId": 123, "turnNumber": 17 }
```

In DB we store `rooms.currentTurnNumber`.

**Rule**: if `job.turnNumber !== rooms.currentTurnNumber + 1` then **drop** (ack) the job.

### 4) Mixed-provider agents in the same room

A persona agent must include:

- **persona**: name, avatar, system prompt
- **LLM configuration**: provider + model (and later: temperature, max output tokens, etc.)

**Decision**: provider+model are stored **per agent**, not globally.

During a turn we route to the correct provider/model for the active agent.

### 5) History source of truth is Discord; sync into D1

**Decision**: every turn fetch the most recent messages from the **thread** via Discord REST.

We then **upsert** messages into D1 (dedupe by Discord message id) and build the LLM prompt from the synced messages.

Filtering (defaults):

- **include**: human messages
- **include**: our webhook messages (identified by `message.webhook_id === discord_channels.webhook_id`)
- **ignore**: other bots (`author.bot === true`) unless it’s our webhook

---

## Discord thread auto-archive (per-room config)

Discord supports these values (minutes):

- `60` (1 hour)
- `1440` (1 day)
- `4320` (3 days)
- `10080` (1 week)

**Decision**: store `rooms.autoArchiveDurationMinutes` and use it when creating the thread.

Open question: what default do we want per room type/topic? (we can start with `1440` and allow override).

---

## Data model (D1 + Drizzle)

### `agents`

A reusable persona + its LLM runtime config.

- `id` (text PK)
- `name` (display name)
- `avatarUrl`
- `systemPrompt`
- `llmProvider` (`openai | anthropic | gemini`)
- `llmModel` (string)

### `rooms`

A single debate instance mapped to a Discord thread.

- `id` (int PK)
- `status` (`active | paused`)
- `topic`
- `parentChannelId` (Discord text channel)
- `threadId` (Discord thread; the room)
- `autoArchiveDurationMinutes` (60|1440|4320|10080)
- `currentTurnAgentId`
- `currentTurnNumber`

### `room_agents`

Many-to-many membership of agents in rooms + turn ordering.

- `roomId`
- `agentId`
- `turnOrder`

### `discord_channels`

Stores webhook credentials per parent channel.

- `channelId` (Discord text channel id; PK)
- `webhookId`
- `webhookToken`

### `messages`

Synced Discord message history for rooms.

- `id` (int PK)
- `roomId`
- `discordMessageId` (unique)
- `threadId` (for traceability; equals rooms.threadId)
- `authorType` (`human | agent | bot_other`)
- `authorAgentId` (nullable; set when it’s our webhook-as-agent)
- `content`
- `createdAtMs`

Notes:

- We keep **only the last N** messages per room for prompt building (and to bound storage).
- `discordMessageId` is the dedupe key.

---

## Worker responsibilities

### HTTP (`fetch`)

- Discord interactions endpoint (later)
  - `/room create` (creates thread + DB records + enqueue first turn)
  - `/room stop` (pause room)
  - `/agent add/remove` (manage membership)
- Dev endpoints (keep for local testing)

### Queue consumer (`queue`)

Single job = one turn.

**Turn pipeline**

1. Load room.
2. If not active → stop.
3. Idempotency check (`turnNumber`).
4. Determine next speaking agent from `room_agents`.
5. Fetch recent Discord thread messages.
6. Sync messages into D1 (upsert by `discordMessageId`).
7. Build prompt:
   - system: agent.systemPrompt (+ any room rules)
   - conversation: last N synced messages
8. Call LLM using agent.llmProvider + agent.llmModel.
9. Post response to thread via webhook with `thread_id` and impersonation.
10. Persist the assistant message to D1 (and optionally rely on next sync to pick it up).
11. Update room state (`currentTurnAgentId`, `currentTurnNumber`).
12. Enqueue next `{ roomId, turnNumber: +1 }` unless termination condition.

Termination conditions (MVP):

- turn limit reached
- agent says "Goodbye"
- room paused

---

## LLM routing design (Effect)

We will have a `LlmRouter` service:

- `generate({ provider, model, prompt }) => Effect<string>`

Implementation idea (idiomatic `@effect/ai`):

- For each call create a provider `Model.make(providerName, providerLayerFor(model))` and provide it to `LanguageModel.generateText`.
- This allows **different agents in the same room** to use different providers/models in the same worker process.

---

## Notes / future

- Rate limiting: introduce per-channel pacing (Queue spacing + retries) and possibly caching webhooks.
- Better context: summarize older history into a room summary message.
- Admin UI: manage agents and rooms.
