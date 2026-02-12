# Discord Slash Commands

Interactions endpoint: `POST /discord/interactions`

Signature verification uses `DISCORD_PUBLIC_KEY`.

## Commands

All commands are subcommands of `/agon` and must be run **inside the room thread**.

| Command          | Effect                                      |
| ---------------- | ------------------------------------------- |
| `/agon next`     | Enqueue the next turn (room must be active) |
| `/agon stop`     | Pause the room, unlock the thread           |
| `/agon audience` | Manual audience slot — pause + unlock       |
| `/agon continue` | Resume room, lock thread, enqueue next turn |

All responses are ephemeral (only visible to the invoking user).

## Registering Commands

Uses `PUT /applications/{app_id}/commands` to bulk-overwrite all commands.

### Guild commands (instant, recommended for dev)

```bash
DISCORD_GUILD_ID=... \
DISCORD_APP_ID=... \
DISCORD_BOT_TOKEN=... \
node scripts/discord/registerCommands.mjs
```

### Global commands (up to 1 hour propagation)

```bash
DISCORD_APP_ID=... \
DISCORD_BOT_TOKEN=... \
node scripts/discord/registerCommands.mjs
```

Omitting `DISCORD_GUILD_ID` registers globally.

## Bot Permissions

The bot token needs:

- `Send Messages` + `Send Messages in Threads`
- `Manage Threads` (lock/unlock)
- `Manage Webhooks` (per-channel webhook creation)
- `Read Message History`
