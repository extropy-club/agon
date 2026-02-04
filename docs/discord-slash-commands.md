# Discord Slash Commands (manual room control)

Agon exposes a Discord interactions endpoint at:

- `POST /discord/interactions`

This endpoint verifies request signatures using `DISCORD_PUBLIC_KEY`.

## Commands

All commands must be invoked **inside the room thread** (the Discord thread bound to a room).

- `/next` — enqueue the next turn (only when the room is active)
- `/stop` — pause the room and unlock the thread
- `/audience` — pause the room and unlock the thread (manual audience slot)
- `/continue` — set room to active, lock the thread, and enqueue the next turn

All responses are **ephemeral**.

## Registering commands

Discord supports registering commands via:

- `POST /applications/{app_id}/commands` (create one command)
- `PUT /applications/{app_id}/commands` (bulk overwrite all commands)

This repo includes a helper script that uses **PUT** to register all Agon commands at once.

### Recommended (dev): register guild commands

Guild commands update instantly.

```bash
DISCORD_GUILD_ID=... \
DISCORD_APP_ID=... \
DISCORD_BOT_TOKEN=... \
node scripts/discord/registerCommands.mjs
```

### Global commands

Global commands can take a while to propagate.

```bash
DISCORD_APP_ID=... \
DISCORD_BOT_TOKEN=... \
node scripts/discord/registerCommands.mjs
```

## Notes

- `DISCORD_BOT_TOKEN` must have permission to manage threads in the relevant channels for lock/unlock to work.
- Commands are registered as **chat input commands** (type `1`) with no options.
