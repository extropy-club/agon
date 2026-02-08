import * as ConfigProvider from "effect/ConfigProvider";
import { Layer } from "effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { Db } from "./d1/db.js";
import { ArenaService } from "./services/ArenaService.js";
import { Discord } from "./services/Discord.js";
import { DiscordWebhookPoster } from "./services/DiscordWebhook.js";
import { LlmRouterLive } from "./services/LlmRouter.js";
import { ModelsDev } from "./services/ModelsDev.js";
import { Observability } from "./services/Observability.js";
import { Settings } from "./services/Settings.js";
import { TurnEventService } from "./services/TurnEventService.js";
import { MemoryService } from "./services/MemoryService.js";
import type { Env } from "./index.js";

export const makeConfigLayer = (env: Env) => {
  const map = new Map<string, string>();

  // Wrangler env vars
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") map.set(k, v);
  }

  // IMPORTANT: secrets can be defined as non-enumerable properties on `env`,
  // so `Object.entries(env)` may miss them. We explicitly copy the ones we use.
  const secretKeys = [
    "ENCRYPTION_KEY",
    "ADMIN_TOKEN",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "JWT_SECRET",
    "DISCORD_PUBLIC_KEY",
    "DISCORD_BOT_TOKEN",
    "DISCORD_BOT_USER_ID",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "OPENROUTER_HTTP_REFERER",
    "OPENROUTER_TITLE",
    "ANTHROPIC_API_KEY",
    "GOOGLE_AI_API_KEY",
    "LOG_LEVEL",
    "LOG_FORMAT",
    "LLM_PROVIDER",
    "LLM_MODEL",
    "MEMORY_EXTRACTION_PROVIDER",
    "MEMORY_EXTRACTION_MODEL",
    "ARENA_MAX_TURNS",
    "ARENA_HISTORY_LIMIT",
    "CF_ACCOUNT_ID",
    "CF_WORKER_SERVICE",
    "CF_QUEUE_NAME",
    "CF_D1_NAME",
  ] as const satisfies ReadonlyArray<keyof Env>;

  for (const k of secretKeys) {
    const v = env[k];
    if (typeof v === "string") map.set(k, v);
  }

  return Layer.setConfigProvider(ConfigProvider.fromMap(map));
};

export const makeRuntime = (env: Env) => {
  const dbLayer = Db.layer(env.DB);
  const settingsLayer = Settings.layer.pipe(Layer.provide(dbLayer));

  const llmRouterLayer = LlmRouterLive.pipe(Layer.provide(settingsLayer));
  const discordLayer = Discord.layer.pipe(Layer.provide(settingsLayer));
  const modelsDevLayer = ModelsDev.layer;

  const infraLayer = Layer.mergeAll(
    dbLayer,
    settingsLayer,
    Observability.layer,
    DiscordWebhookPoster.layer,
    llmRouterLayer,
    discordLayer,
    TurnEventService.layer.pipe(Layer.provide(dbLayer)),
    MemoryService.layer.pipe(Layer.provide(dbLayer)),
    modelsDevLayer,
  );

  const arenaLayer = ArenaService.layer.pipe(Layer.provide(infraLayer));

  const appLayer = Layer.mergeAll(infraLayer, arenaLayer).pipe(
    Layer.provideMerge(makeConfigLayer(env)),
  );

  return ManagedRuntime.make(appLayer);
};

export type Runtime = ReturnType<typeof makeRuntime>;
