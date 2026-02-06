#!/usr/bin/env node

/**
 * Register Agon global slash commands.
 *
 * Usage:
 *   DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... node scripts/discord/registerCommands.mjs
 *
 * Optional (recommended for dev; updates are instant):
 *   DISCORD_GUILD_ID=... DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... node scripts/discord/registerCommands.mjs
 */

const DISCORD_API = "https://discord.com/api/v10";

const appId = process.env.DISCORD_APP_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;

if (!appId) {
  console.error("Missing DISCORD_APP_ID");
  process.exit(1);
}

if (!botToken) {
  console.error("Missing DISCORD_BOT_TOKEN");
  process.exit(1);
}

const sanitizeToken = (s) =>
  String(s)
    .trim()
    .replace(/^"(.*)"$/, "$1")
    .replace(/^'(.*)'$/, "$1")
    .replace(/^Bot\s+/i, "")
    .replace(/^Bearer\s+/i, "");

const endpoint = guildId
  ? `${DISCORD_API}/applications/${appId}/guilds/${guildId}/commands`
  : `${DISCORD_API}/applications/${appId}/commands`;

const commands = [
  {
    name: "agon",
    description: "Agon debate arena commands",
    type: 1,
    options: [
      {
        name: "next",
        description: "Trigger next turn manually",
        type: 1, // SUB_COMMAND
      },
      {
        name: "stop",
        description: "Pause the room",
        type: 1, // SUB_COMMAND
      },
      {
        name: "audience",
        description: "Open the audience slot (unlock the thread)",
        type: 1, // SUB_COMMAND
      },
      {
        name: "continue",
        description: "Close the audience slot and resume agents",
        type: 1, // SUB_COMMAND
      },
      {
        name: "agent",
        description: "Agent management",
        type: 2, // SUB_COMMAND_GROUP
        options: [
          {
            name: "create",
            description: "Create a new agent (opens modal)",
            type: 1, // SUB_COMMAND
          },
        ],
      },
      {
        name: "room",
        description: "Room management",
        type: 2, // SUB_COMMAND_GROUP
        options: [
          {
            name: "create",
            description: "Create a new debate room (opens wizard)",
            type: 1, // SUB_COMMAND
          },
        ],
      },
    ],
  },
];

const res = await fetch(endpoint, {
  method: "PUT",
  headers: {
    Authorization: `Bot ${sanitizeToken(botToken)}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(commands),
});

const text = await res.text();

if (!res.ok) {
  console.error(`Discord API error (${res.status}): ${text}`);
  process.exit(1);
}

console.log(
  `Registered ${commands.length} command(s) (${guildId ? "guild" : "global"}) at: ${endpoint}`,
);
console.log(text);
