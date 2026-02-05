import { asc, desc, eq, sql } from "drizzle-orm";
import type { APIInteraction } from "discord-api-types/v10";
import * as ConfigProvider from "effect/ConfigProvider";
import { Config, Effect, Layer, Option, Redacted, Schema } from "effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { Db, nowMs } from "./d1/db.js";
import {
  agents,
  discordChannels,
  messages,
  roomAgents,
  rooms,
  roomTurnEvents,
  settings,
} from "./d1/schema.js";
import {
  ArenaService,
  RoomDbError,
  type ArenaError,
  type RoomTurnJob,
  type TurnJob,
} from "./services/ArenaService.js";
import {
  Discord,
  type DiscordAutoArchiveDurationMinutes,
  verifyDiscordInteraction,
} from "./services/Discord.js";
import { DiscordWebhookPoster } from "./services/DiscordWebhook.js";
import { LlmRouterLive } from "./services/LlmRouter.js";
import { Observability } from "./services/Observability.js";
import { Settings } from "./services/Settings.js";
import { TurnEventService } from "./services/TurnEventService.js";
import { decrypt } from "./lib/crypto.js";
import { signJwt, verifyJwt } from "./lib/jwt.js";

export interface Env {
  DB: D1Database;
  ARENA_QUEUE: Queue<RoomTurnJob>;

  // Optional runtime config (usually provided via .dev.vars / wrangler secrets)
  ENCRYPTION_KEY?: string;

  DISCORD_PUBLIC_KEY?: string;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_BOT_USER_ID?: string;

  // Optional Cloudflare dashboard deep links (used by admin UI)
  CF_ACCOUNT_ID?: string;
  CF_WORKER_SERVICE?: string;
  CF_QUEUE_NAME?: string;
  CF_D1_NAME?: string;

  // LLM providers
  OPENAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_HTTP_REFERER?: string;
  OPENROUTER_TITLE?: string;
  ANTHROPIC_API_KEY?: string;
  GOOGLE_AI_API_KEY?: string;

  ARENA_MAX_TURNS?: string;
  ARENA_HISTORY_LIMIT?: string;

  // Admin API auth
  ADMIN_TOKEN?: string;

  // GitHub OAuth + session JWT
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  JWT_SECRET?: string;
  AUTH_ALLOWED_USERS?: string; // comma-separated GitHub logins

  // Cloudflare Workers static assets binding (admin UI)
  ASSETS?: Fetcher;
}

const KNOWN_SETTINGS = [
  { key: "OPENAI_API_KEY", label: "OpenAI API Key", sensitive: true },
  { key: "OPENROUTER_API_KEY", label: "OpenRouter API Key", sensitive: true },
  { key: "ANTHROPIC_API_KEY", label: "Anthropic API Key", sensitive: true },
  { key: "GOOGLE_AI_API_KEY", label: "Google AI API Key", sensitive: true },
  { key: "DISCORD_BOT_TOKEN", label: "Discord Bot Token", sensitive: true },
  { key: "OPENROUTER_HTTP_REFERER", label: "OpenRouter HTTP Referer", sensitive: false },
  { key: "OPENROUTER_TITLE", label: "OpenRouter Title", sensitive: false },
] as const;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const text = (status: number, body: string) => new Response(body, { status });

const isLocalhost = (hostname: string) =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";

const getCookie = (request: Request, name: string): string | undefined => {
  const header = request.headers.get("cookie");
  if (!header) return undefined;

  // Simple cookie parsing (sufficient for our use-case).
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return undefined;
};

type CookieOptions = {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
  path?: string;
  maxAge?: number;
};

const serializeCookie = (name: string, value: string, options: CookieOptions): string => {
  const parts: string[] = [`${name}=${value}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  return parts.join("; ");
};

const redirect = (location: string, cookies: string[] = []) => {
  const headers = new Headers({ Location: location });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
};

const makeConfigLayer = (env: Env) => {
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
    "AUTH_ALLOWED_USERS",
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
    "ARENA_MAX_TURNS",
    "ARENA_HISTORY_LIMIT",
    "CF_ACCOUNT_ID",
    "CF_WORKER_SERVICE",
    "CF_QUEUE_NAME",
    "CF_D1_NAME",
  ] as const;

  for (const k of secretKeys) {
    const v = (env as unknown as Record<string, unknown>)[k];
    if (typeof v === "string") map.set(k, v);
  }

  return Layer.setConfigProvider(ConfigProvider.fromMap(map));
};

const makeRuntime = (env: Env) => {
  const dbLayer = Db.layer(env.DB);
  const settingsLayer = Settings.layer.pipe(Layer.provide(dbLayer));

  const llmRouterLayer = LlmRouterLive.pipe(Layer.provide(settingsLayer));
  const discordLayer = Discord.layer.pipe(Layer.provide(settingsLayer));

  const infraLayer = Layer.mergeAll(
    dbLayer,
    settingsLayer,
    Observability.layer,
    DiscordWebhookPoster.layer,
    llmRouterLayer,
    discordLayer,
    TurnEventService.layer.pipe(Layer.provide(dbLayer)),
  );

  const arenaLayer = ArenaService.layer.pipe(Layer.provide(infraLayer));

  const appLayer = Layer.mergeAll(infraLayer, arenaLayer).pipe(
    Layer.provideMerge(makeConfigLayer(env)),
  );

  return ManagedRuntime.make(appLayer);
};

const parseJson = <A>(request: Request): Effect.Effect<A, unknown> =>
  Effect.tryPromise({
    try: () => request.json() as Promise<A>,
    catch: (e) => e,
  });

export class AdminUnauthorized extends Schema.TaggedError<AdminUnauthorized>()(
  "AdminUnauthorized",
  {},
) {}

export class AdminMissingConfig extends Schema.TaggedError<AdminMissingConfig>()(
  "AdminMissingConfig",
  {
    key: Schema.String,
  },
) {}

export class AdminBadRequest extends Schema.TaggedError<AdminBadRequest>()("AdminBadRequest", {
  message: Schema.String,
}) {}

export class AdminNotFound extends Schema.TaggedError<AdminNotFound>()("AdminNotFound", {
  resource: Schema.String,
  id: Schema.String,
}) {}

export class AdminDbError extends Schema.TaggedError<AdminDbError>()("AdminDbError", {
  cause: Schema.Defect,
}) {}

export class AdminQueueError extends Schema.TaggedError<AdminQueueError>()("AdminQueueError", {
  cause: Schema.Defect,
}) {}

// Dev-only endpoints (/dev/*)
export class DevBadRequest extends Schema.TaggedError<DevBadRequest>()("DevBadRequest", {
  message: Schema.String,
}) {}

export class DevDbError extends Schema.TaggedError<DevDbError>()("DevDbError", {
  cause: Schema.Defect,
}) {}

export class AuthJwtError extends Schema.TaggedError<AuthJwtError>()("AuthJwtError", {
  operation: Schema.String,
  cause: Schema.Defect,
}) {}

const requireAdmin = (request: Request) =>
  Effect.gen(function* () {
    // 1) Bearer token (programmatic access)
    const auth = request.headers.get("authorization") ?? "";
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (match) {
      const opt = yield* Config.option(Config.redacted("ADMIN_TOKEN")).pipe(
        Effect.catchAll(() => Effect.succeed(Option.none())),
      );

      // When ADMIN_TOKEN is configured, validate the Bearer token.
      // When it's NOT configured, fall through to cookie/session auth below.
      if (Option.isSome(opt)) {
        if (Redacted.value(opt.value) !== match[1]) {
          return yield* Effect.fail(AdminUnauthorized.make({}));
        }
        return;
      }
    }

    // 2) Session cookie (GitHub OAuth)
    const session = getCookie(request, "session");
    if (session) {
      const jwtOpt = yield* Config.option(Config.redacted("JWT_SECRET")).pipe(
        Effect.catchAll(() => Effect.succeed(Option.none())),
      );

      if (Option.isNone(jwtOpt)) {
        return yield* Effect.fail(AdminMissingConfig.make({ key: "JWT_SECRET" }));
      }

      const payload = (yield* verifyJwt(session, Redacted.value(jwtOpt.value)).pipe(
        Effect.catchAll(() => Effect.succeed(null)),
      )) as (Record<string, unknown> & { login?: string }) | null;

      if (!payload) {
        return yield* Effect.fail(AdminUnauthorized.make({}));
      }

      const allowOpt = yield* Config.option(Config.string("AUTH_ALLOWED_USERS")).pipe(
        Effect.catchAll(() => Effect.succeed(Option.none())),
      );

      if (Option.isSome(allowOpt) && allowOpt.value.trim().length > 0) {
        const allowed = allowOpt.value.split(",").map((s) => s.trim().toLowerCase());
        const login = payload.login;
        if (typeof login !== "string" || !allowed.includes(login.toLowerCase())) {
          return yield* Effect.fail(AdminUnauthorized.make({}));
        }
      }

      return;
    }

    // 3) Nothing
    return yield* Effect.fail(AdminUnauthorized.make({}));
  });

const decodeBody = <A>(request: Request, schema: Schema.Schema<A>) =>
  parseJson<unknown>(request).pipe(
    Effect.flatMap((u) => Schema.decodeUnknown(schema)(u)),
    Effect.mapError(() => AdminBadRequest.make({ message: "Invalid JSON body" })),
  );

const slugify = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

const dbTry = <A>(thunk: () => Promise<A>) =>
  Effect.tryPromise({
    try: thunk,
    catch: (cause) => AdminDbError.make({ cause }),
  });

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const runtime = makeRuntime(env);

    const requestId =
      request.headers.get("CF-Ray") ?? request.headers.get("cf-ray") ?? crypto.randomUUID();

    // Auth (GitHub OAuth)
    if (url.pathname === "/auth/login" && request.method === "GET") {
      if (!env.GITHUB_CLIENT_ID) {
        return json(500, { error: "Missing GITHUB_CLIENT_ID" });
      }

      const state = crypto.randomUUID();
      const secure = !isLocalhost(url.hostname);

      const stateCookie = serializeCookie("oauth_state", state, {
        httpOnly: true,
        secure,
        sameSite: "Lax",
        path: "/auth/callback",
        maxAge: 60 * 5,
      });

      const redirectUri = new URL("/auth/callback", request.url).toString();
      const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
      authorizeUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set("scope", "read:user");

      return redirect(authorizeUrl.toString(), [stateCookie]);
    }

    if (url.pathname === "/auth/callback" && request.method === "GET") {
      const code = url.searchParams.get("code") ?? "";
      const state = url.searchParams.get("state") ?? "";

      const secure = !isLocalhost(url.hostname);
      const clearStateCookie = serializeCookie("oauth_state", "", {
        httpOnly: true,
        secure,
        sameSite: "Lax",
        path: "/auth/callback",
        maxAge: 0,
      });

      const cookieState = getCookie(request, "oauth_state") ?? "";
      if (!code || !state || !cookieState || cookieState !== state) {
        const headers = new Headers({ "Content-Type": "application/json" });
        headers.append("Set-Cookie", clearStateCookie);
        return new Response(JSON.stringify({ error: "Invalid state" }, null, 2), {
          status: 400,
          headers,
        });
      }

      if (!env.GITHUB_CLIENT_ID) {
        const headers = new Headers({ "Content-Type": "application/json" });
        headers.append("Set-Cookie", clearStateCookie);
        return new Response(JSON.stringify({ error: "Missing GITHUB_CLIENT_ID" }, null, 2), {
          status: 500,
          headers,
        });
      }

      if (!env.GITHUB_CLIENT_SECRET) {
        const headers = new Headers({ "Content-Type": "application/json" });
        headers.append("Set-Cookie", clearStateCookie);
        return new Response(JSON.stringify({ error: "Missing GITHUB_CLIENT_SECRET" }, null, 2), {
          status: 500,
          headers,
        });
      }

      if (!env.JWT_SECRET) {
        const headers = new Headers({ "Content-Type": "application/json" });
        headers.append("Set-Cookie", clearStateCookie);
        return new Response(JSON.stringify({ error: "Missing JWT_SECRET" }, null, 2), {
          status: 500,
          headers,
        });
      }

      const jwtSecret = env.JWT_SECRET;

      // Exchange code → access token
      const tokenResp = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
        }).toString(),
      });

      const tokenJson = (await tokenResp.json().catch(() => null)) as {
        access_token?: string;
        error?: string;
        error_description?: string;
      } | null;

      const accessToken = tokenJson?.access_token;
      if (!tokenResp.ok || !accessToken) {
        const headers = new Headers({ "Content-Type": "application/json" });
        headers.append("Set-Cookie", clearStateCookie);
        return new Response(
          JSON.stringify(
            {
              error: "Failed to exchange code",
              details: tokenJson,
            },
            null,
            2,
          ),
          { status: 502, headers },
        );
      }

      // Fetch user
      const userResp = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "agon",
        },
      });

      const userJson = (await userResp.json().catch(() => null)) as {
        id: number;
        login: string;
        avatar_url: string;
      } | null;

      if (!userResp.ok || !userJson?.login || userJson.id === undefined) {
        const headers = new Headers({ "Content-Type": "application/json" });
        headers.append("Set-Cookie", clearStateCookie);
        return new Response(
          JSON.stringify({ error: "Failed to fetch user", details: userJson }, null, 2),
          { status: 502, headers },
        );
      }

      // Optional allowlist
      const allowRaw = env.AUTH_ALLOWED_USERS?.trim() ?? "";
      if (allowRaw.length > 0) {
        const allow = allowRaw
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);

        if (!allow.includes(userJson.login.toLowerCase())) {
          const headers = new Headers({ "Content-Type": "application/json" });
          headers.append("Set-Cookie", clearStateCookie);
          return new Response(JSON.stringify({ error: "Forbidden" }, null, 2), {
            status: 403,
            headers,
          });
        }
      }

      const now = Math.floor(Date.now() / 1000);
      const payload = {
        sub: String(userJson.id),
        login: userJson.login,
        avatar_url: userJson.avatar_url,
        exp: now + 60 * 60 * 24 * 7,
      };

      let jwt: string;
      try {
        jwt = await runtime.runPromise(
          signJwt(payload, jwtSecret).pipe(
            Effect.mapError((e) =>
              AuthJwtError.make({
                operation: e.operation,
                cause: e.cause,
              }),
            ),
          ),
        );
      } catch (e) {
        console.error("auth.jwt.sign.failed", e);
        const headers = new Headers({ "Content-Type": "application/json" });
        headers.append("Set-Cookie", clearStateCookie);
        return new Response(JSON.stringify({ error: "Failed to sign session" }, null, 2), {
          status: 500,
          headers,
        });
      }

      const sessionCookie = serializeCookie("session", jwt, {
        httpOnly: true,
        secure,
        sameSite: "Lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 7,
      });

      return redirect("/", [clearStateCookie, sessionCookie]);
    }

    if (url.pathname === "/auth/me" && request.method === "GET") {
      const token = getCookie(request, "session");
      if (!token) return json(401, { error: "Unauthorized" });
      if (!env.JWT_SECRET) return json(500, { error: "Missing JWT_SECRET" });

      const jwtSecret = env.JWT_SECRET;

      const payload = await runtime.runPromise(
        verifyJwt(token, jwtSecret).pipe(Effect.catchAll(() => Effect.succeed(null))),
      );
      if (!payload) return json(401, { error: "Unauthorized" });

      const rec = payload as Record<string, unknown>;
      const login = typeof rec.login === "string" ? rec.login : null;
      const avatar_url = typeof rec.avatar_url === "string" ? rec.avatar_url : null;
      const sub = typeof rec.sub === "string" ? rec.sub : null;
      if (!login || !avatar_url || !sub) return json(401, { error: "Unauthorized" });

      return json(200, {
        login,
        avatar_url,
        sub,
      });
    }

    if (url.pathname === "/auth/logout" && request.method === "POST") {
      const secure = !isLocalhost(url.hostname);
      const clearSessionCookie = serializeCookie("session", "", {
        httpOnly: true,
        secure,
        sameSite: "Lax",
        path: "/",
        maxAge: 0,
      });

      const headers = new Headers({ "Content-Type": "application/json" });
      headers.append("Set-Cookie", clearSessionCookie);
      return new Response(JSON.stringify({ ok: true }, null, 2), { status: 200, headers });
    }

    // Admin API
    if (url.pathname.startsWith("/admin")) {
      const segments = url.pathname.split("/").filter(Boolean);

      const AgentProviderSchema = Schema.Literal("openai", "anthropic", "gemini", "openrouter");
      const ThinkingLevelSchema = Schema.Literal("low", "medium", "high");

      const AgentCreateSchema = Schema.Struct({
        id: Schema.optional(Schema.String),
        name: Schema.String,
        avatarUrl: Schema.optional(Schema.String),
        systemPrompt: Schema.String,
        llmProvider: Schema.optional(AgentProviderSchema),
        llmModel: Schema.optional(Schema.String),
        temperature: Schema.optional(Schema.String),
        maxTokens: Schema.optional(Schema.NullOr(Schema.Number)),
        thinkingLevel: Schema.optional(Schema.NullOr(ThinkingLevelSchema)),
        thinkingBudgetTokens: Schema.optional(Schema.NullOr(Schema.Number)),
      });

      const AgentUpdateSchema = Schema.Struct({
        name: Schema.optional(Schema.String),
        avatarUrl: Schema.optional(Schema.String),
        systemPrompt: Schema.optional(Schema.String),
        llmProvider: Schema.optional(AgentProviderSchema),
        llmModel: Schema.optional(Schema.String),
        temperature: Schema.optional(Schema.String),
        maxTokens: Schema.optional(Schema.NullOr(Schema.Number)),
        thinkingLevel: Schema.optional(Schema.NullOr(ThinkingLevelSchema)),
        thinkingBudgetTokens: Schema.optional(Schema.NullOr(Schema.Number)),
      });

      const CreateRoomSchema = Schema.Struct({
        parentChannelId: Schema.String,
        topic: Schema.String,
        title: Schema.optional(Schema.String),
        audienceSlotDurationSeconds: Schema.optional(Schema.Number),
        audienceTokenLimit: Schema.optional(Schema.Number),
        roomTokenLimit: Schema.optional(Schema.Number),
        autoArchiveDurationMinutes: Schema.optional(Schema.Number),
        agentIds: Schema.Array(Schema.String),
        // Provide threadId to bind to an existing thread. If omitted, we will create a thread.
        threadId: Schema.optional(Schema.String),
        threadName: Schema.optional(Schema.String),
      });

      const program = Effect.gen(function* () {
        yield* requireAdmin(request);
        const { db } = yield* Db;
        const settingsService = yield* Settings;

        const maskSensitive = (value: string) => {
          const v = value.trim();
          if (v.length < 8) return "••••••••";
          return `...${v.slice(-4)}`;
        };

        // /admin/discord/guilds
        if (segments[1] === "discord" && segments[2] === "guilds" && request.method === "GET") {
          const discord = yield* Discord;

          return yield* discord.getGuilds().pipe(
            Effect.map((guilds) => json(200, { guilds })),
            Effect.catchTag("DiscordApiError", (e) =>
              Effect.succeed(
                json(502, {
                  error: "Discord API error",
                  endpoint: e.endpoint,
                  status: e.status,
                  body: e.body,
                  requestId,
                }),
              ),
            ),
          );
        }

        // /admin/settings
        if (segments.length === 2 && segments[1] === "settings") {
          if (request.method !== "GET") {
            return json(405, { error: "Method not allowed" });
          }

          const encryptionKey = yield* Config.redacted("ENCRYPTION_KEY");
          const secret = Redacted.value(encryptionKey);

          const rows = yield* dbTry(() => db.select().from(settings).all());
          const byKey = new Map(rows.map((r) => [r.key, r] as const));

          const settingsResponse = yield* Effect.forEach(KNOWN_SETTINGS, (def) =>
            Effect.gen(function* () {
              const row = byKey.get(def.key);

              if (row) {
                const decrypted = yield* decrypt(row.value, secret).pipe(
                  Effect.catchAll(() => Effect.succeed(null as string | null)),
                );

                if (decrypted === null) {
                  // DB row exists but decryption failed — don't claim it's configured
                  // (runtime will fall back to env via Settings.getSetting)
                  return {
                    key: def.key,
                    label: def.label,
                    sensitive: def.sensitive,
                    configured: false,
                    source: "db_invalid" as const,
                    maskedValue: null,
                    updatedAtMs: row.updatedAtMs,
                  };
                }

                const maskedValue = def.sensitive ? maskSensitive(decrypted) : decrypted;

                return {
                  key: def.key,
                  label: def.label,
                  sensitive: def.sensitive,
                  configured: true,
                  source: "db" as const,
                  maskedValue,
                  updatedAtMs: row.updatedAtMs,
                };
              }

              // Not in DB -> check env (existence + masked preview for sensitive only)
              if (def.sensitive) {
                const envOpt = yield* Config.option(Config.redacted(def.key)).pipe(
                  Effect.catchAll(() => Effect.succeed(Option.none())),
                );
                if (Option.isSome(envOpt)) {
                  return {
                    key: def.key,
                    label: def.label,
                    sensitive: def.sensitive,
                    configured: true,
                    source: "env" as const,
                    maskedValue: maskSensitive(Redacted.value(envOpt.value)),
                    updatedAtMs: null,
                  };
                }
              } else {
                const envOpt = yield* Config.option(Config.string(def.key)).pipe(
                  Effect.catchAll(() => Effect.succeed(Option.none())),
                );
                if (Option.isSome(envOpt)) {
                  return {
                    key: def.key,
                    label: def.label,
                    sensitive: def.sensitive,
                    configured: true,
                    source: "env" as const,
                    maskedValue: null,
                    updatedAtMs: null,
                  };
                }
              }

              return {
                key: def.key,
                label: def.label,
                sensitive: def.sensitive,
                configured: false,
                source: null,
                maskedValue: null,
                updatedAtMs: null,
              };
            }),
          );

          return json(200, { settings: settingsResponse });
        }

        // /admin/settings/:key
        if (segments.length === 3 && segments[1] === "settings") {
          let key: string;
          try {
            key = decodeURIComponent(segments[2] ?? "");
          } catch {
            return json(400, { error: "Malformed key encoding" });
          }
          const known = KNOWN_SETTINGS.find((s) => s.key === key);
          if (!known) return json(404, { error: "Not Found" });

          if (request.method === "PUT") {
            const body = yield* decodeBody(request, Schema.Struct({ value: Schema.String }));

            const value = body.value.trim();
            if (value.length === 0) {
              return yield* Effect.fail(
                AdminBadRequest.make({ message: "Value must be non-empty" }),
              );
            }

            yield* settingsService
              .setSetting(key, value)
              .pipe(Effect.mapError((cause) => AdminDbError.make({ cause })));
            return json(200, { ok: true });
          }

          if (request.method === "DELETE") {
            yield* dbTry(() => db.delete(settings).where(eq(settings.key, key)).run());
            return json(200, { ok: true });
          }

          return json(405, { error: "Method not allowed" });
        }

        // /admin/meta
        if (segments.length === 2 && segments[1] === "meta") {
          if (request.method !== "GET") {
            return json(405, { error: "Method not allowed" });
          }

          const accountId = yield* Config.option(Config.string("CF_ACCOUNT_ID")).pipe(
            Effect.map(Option.getOrNull),
          );

          const workerService = yield* Config.option(Config.string("CF_WORKER_SERVICE")).pipe(
            Effect.map(Option.getOrElse(() => "agon")),
          );

          const queueName = yield* Config.option(Config.string("CF_QUEUE_NAME")).pipe(
            Effect.map(Option.getOrElse(() => "arena-turns")),
          );

          const d1Name = yield* Config.option(Config.string("CF_D1_NAME")).pipe(
            Effect.map(Option.getOrElse(() => "agon-db")),
          );

          if (!accountId) {
            return json(200, {
              configured: false,
              missing: ["CF_ACCOUNT_ID"],
            });
          }

          return json(200, {
            configured: true,
            cloudflare: {
              accountId,
              workerService,
              queueName,
              d1Name,
              links: {
                queueMetrics: `https://dash.cloudflare.com/${accountId}/workers/queues/view/${encodeURIComponent(queueName)}`,
                workerLogs: `https://dash.cloudflare.com/${accountId}/workers/services/view/${encodeURIComponent(workerService)}/production/observability/logs`,
                d1Console: `https://dash.cloudflare.com/${accountId}/workers/d1/view/${encodeURIComponent(d1Name)}`,
              },
            },
          });
        }

        // /admin/agents
        if (segments.length === 2 && segments[1] === "agents") {
          if (request.method === "GET") {
            const rows = yield* dbTry(() =>
              db.select().from(agents).orderBy(asc(agents.name)).all(),
            );
            return json(200, { agents: rows });
          }

          if (request.method === "POST") {
            const body = yield* decodeBody(request, AgentCreateSchema);
            const id = body.id ? body.id : slugify(body.name);
            if (!id) return json(400, { error: "Invalid id" });

            const provider = body.llmProvider ?? "openai";

            const avatarUrl = body.avatarUrl?.trim();
            const avatarUrlOrNull = avatarUrl && avatarUrl.length > 0 ? avatarUrl : null;

            const temperatureRaw = body.temperature?.trim();
            const temperatureOrNull =
              temperatureRaw && temperatureRaw.length > 0 ? temperatureRaw : null;

            if (temperatureOrNull !== null) {
              const t = Number.parseFloat(temperatureOrNull);
              if (!Number.isFinite(t) || t < 0.0 || t > 2.0) {
                return yield* Effect.fail(
                  AdminBadRequest.make({
                    message: "temperature must be a number between 0.0 and 2.0",
                  }),
                );
              }
            }

            const validatePositiveInt = (n: number, label: string) => {
              if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
                return AdminBadRequest.make({ message: `${label} must be an integer > 0` });
              }
              return null;
            };

            if (body.maxTokens != null) {
              const err = validatePositiveInt(body.maxTokens, "maxTokens");
              if (err) return yield* Effect.fail(err);
            }

            if (body.thinkingBudgetTokens != null) {
              const err = validatePositiveInt(body.thinkingBudgetTokens, "thinkingBudgetTokens");
              if (err) return yield* Effect.fail(err);
            }

            if (
              body.thinkingLevel != null &&
              !(provider === "openai" || provider === "anthropic")
            ) {
              return yield* Effect.fail(
                AdminBadRequest.make({
                  message: "thinkingLevel is only supported for OpenAI and Anthropic",
                }),
              );
            }

            if (body.thinkingBudgetTokens != null && provider !== "anthropic") {
              return yield* Effect.fail(
                AdminBadRequest.make({
                  message: "thinkingBudgetTokens is only supported for Anthropic",
                }),
              );
            }

            yield* dbTry(() =>
              db
                .insert(agents)
                .values({
                  id,
                  name: body.name,
                  avatarUrl: avatarUrlOrNull,
                  systemPrompt: body.systemPrompt,
                  llmProvider: provider,
                  llmModel: body.llmModel ?? "gpt-4o-mini",
                  temperature: temperatureOrNull,
                  maxTokens: body.maxTokens ?? null,
                  thinkingLevel: body.thinkingLevel ?? null,
                  thinkingBudgetTokens: body.thinkingBudgetTokens ?? null,
                })
                .onConflictDoUpdate({
                  target: agents.id,
                  set: {
                    name: body.name,
                    avatarUrl: avatarUrlOrNull,
                    systemPrompt: body.systemPrompt,
                    llmProvider: provider,
                    llmModel: body.llmModel ?? "gpt-4o-mini",
                    temperature: temperatureOrNull,
                    maxTokens: body.maxTokens ?? null,
                    thinkingLevel: body.thinkingLevel ?? null,
                    thinkingBudgetTokens: body.thinkingBudgetTokens ?? null,
                  },
                })
                .run(),
            );

            const agent = yield* dbTry(() =>
              db.select().from(agents).where(eq(agents.id, id)).get(),
            );
            return json(200, { agent });
          }

          return json(405, { error: "Method not allowed" });
        }

        // /admin/agents/:id
        if (segments.length === 3 && segments[1] === "agents") {
          const agentId = segments[2];

          if (request.method === "GET") {
            const agent = yield* dbTry(() =>
              db.select().from(agents).where(eq(agents.id, agentId)).get(),
            );
            if (!agent) {
              return yield* Effect.fail(AdminNotFound.make({ resource: "agent", id: agentId }));
            }
            return json(200, { agent });
          }

          if (request.method === "PUT") {
            const body = yield* decodeBody(request, AgentUpdateSchema);

            const existing = yield* dbTry(() =>
              db.select().from(agents).where(eq(agents.id, agentId)).get(),
            );
            if (!existing) {
              return yield* Effect.fail(AdminNotFound.make({ resource: "agent", id: agentId }));
            }

            const provider = body.llmProvider ?? existing.llmProvider;

            const temperatureTrimmed = body.temperature?.trim();
            const temperatureOrNull =
              body.temperature !== undefined
                ? temperatureTrimmed && temperatureTrimmed.length > 0
                  ? temperatureTrimmed
                  : null
                : undefined;

            if (temperatureOrNull !== undefined && temperatureOrNull !== null) {
              const t = Number.parseFloat(temperatureOrNull);
              if (!Number.isFinite(t) || t < 0.0 || t > 2.0) {
                return yield* Effect.fail(
                  AdminBadRequest.make({
                    message: "temperature must be a number between 0.0 and 2.0",
                  }),
                );
              }
            }

            const validatePositiveInt = (n: number, label: string) => {
              if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
                return AdminBadRequest.make({ message: `${label} must be an integer > 0` });
              }
              return null;
            };

            if (body.maxTokens != null) {
              const err = validatePositiveInt(body.maxTokens, "maxTokens");
              if (err) return yield* Effect.fail(err);
            }

            if (body.thinkingBudgetTokens != null) {
              const err = validatePositiveInt(body.thinkingBudgetTokens, "thinkingBudgetTokens");
              if (err) return yield* Effect.fail(err);
            }

            if (
              body.thinkingLevel != null &&
              !(provider === "openai" || provider === "anthropic")
            ) {
              return yield* Effect.fail(
                AdminBadRequest.make({
                  message: "thinkingLevel is only supported for OpenAI and Anthropic",
                }),
              );
            }

            if (body.thinkingBudgetTokens != null && provider !== "anthropic") {
              return yield* Effect.fail(
                AdminBadRequest.make({
                  message: "thinkingBudgetTokens is only supported for Anthropic",
                }),
              );
            }

            yield* dbTry(() =>
              db
                .update(agents)
                .set({
                  ...(body.name !== undefined ? { name: body.name } : {}),
                  ...(body.avatarUrl !== undefined
                    ? {
                        avatarUrl: body.avatarUrl.trim().length > 0 ? body.avatarUrl.trim() : null,
                      }
                    : {}),
                  ...(body.systemPrompt !== undefined ? { systemPrompt: body.systemPrompt } : {}),
                  ...(body.llmProvider !== undefined ? { llmProvider: body.llmProvider } : {}),
                  ...(body.llmModel !== undefined ? { llmModel: body.llmModel } : {}),
                  ...(body.temperature !== undefined ? { temperature: temperatureOrNull } : {}),
                  ...(body.maxTokens !== undefined ? { maxTokens: body.maxTokens } : {}),
                  ...(body.thinkingLevel !== undefined
                    ? { thinkingLevel: body.thinkingLevel }
                    : {}),
                  ...(body.thinkingBudgetTokens !== undefined
                    ? { thinkingBudgetTokens: body.thinkingBudgetTokens }
                    : {}),
                  ...(body.llmProvider !== undefined &&
                  (body.llmProvider === "gemini" || body.llmProvider === "openrouter")
                    ? { thinkingLevel: null, thinkingBudgetTokens: null }
                    : {}),
                  ...(body.llmProvider !== undefined && body.llmProvider === "openai"
                    ? { thinkingBudgetTokens: null }
                    : {}),
                })
                .where(eq(agents.id, agentId))
                .run(),
            );

            const agent = yield* dbTry(() =>
              db.select().from(agents).where(eq(agents.id, agentId)).get(),
            );
            return json(200, { agent });
          }

          if (request.method === "DELETE") {
            yield* dbTry(() => db.delete(agents).where(eq(agents.id, agentId)).run());
            return json(200, { ok: true });
          }

          return json(405, { error: "Method not allowed" });
        }

        // /admin/rooms
        if (segments.length === 2 && segments[1] === "rooms") {
          if (request.method === "GET") {
            const rs = yield* dbTry(() => db.select().from(rooms).orderBy(desc(rooms.id)).all());
            return json(200, { rooms: rs });
          }

          if (request.method === "POST") {
            const body = yield* decodeBody(request, CreateRoomSchema);
            const arena = yield* ArenaService;
            const discord = yield* Discord;

            const allowed = [60, 1440, 4320, 10080] as const;
            const autoArchiveDurationMinutes = allowed.includes(
              body.autoArchiveDurationMinutes as (typeof allowed)[number],
            )
              ? (body.autoArchiveDurationMinutes as number)
              : 1440;

            // ensure webhook mapping for parent channel
            const existingWebhook = yield* dbTry(() =>
              db
                .select()
                .from(discordChannels)
                .where(eq(discordChannels.channelId, body.parentChannelId))
                .get(),
            );

            const webhook = existingWebhook
              ? { id: existingWebhook.webhookId, token: existingWebhook.webhookToken }
              : yield* discord.createOrFetchWebhook(body.parentChannelId);

            yield* dbTry(() =>
              db
                .insert(discordChannels)
                .values({
                  channelId: body.parentChannelId,
                  webhookId: webhook.id,
                  webhookToken: webhook.token,
                })
                .onConflictDoUpdate({
                  target: discordChannels.channelId,
                  set: { webhookId: webhook.id, webhookToken: webhook.token },
                })
                .run(),
            );

            const threadName = body.threadName?.trim();
            const threadId = body.threadId
              ? body.threadId
              : yield* discord.createPublicThread(body.parentChannelId, {
                  name:
                    threadName && threadName.length > 0
                      ? threadName
                      : `Agon Room ${new Date().toISOString()}`,
                  autoArchiveDurationMinutes:
                    autoArchiveDurationMinutes as DiscordAutoArchiveDurationMinutes,
                });

            const result = yield* arena.createRoom({
              parentChannelId: body.parentChannelId,
              threadId,
              topic: body.topic,
              autoArchiveDurationMinutes,
              agentIds: body.agentIds,
              ...(body.title !== undefined ? { title: body.title } : {}),
              ...(body.audienceSlotDurationSeconds !== undefined
                ? { audienceSlotDurationSeconds: body.audienceSlotDurationSeconds }
                : {}),
              ...(body.audienceTokenLimit !== undefined
                ? { audienceTokenLimit: body.audienceTokenLimit }
                : {}),
              ...(body.roomTokenLimit !== undefined ? { roomTokenLimit: body.roomTokenLimit } : {}),
            });

            yield* Effect.tryPromise({
              try: () => env.ARENA_QUEUE.send(result.firstJob),
              catch: (cause) => AdminQueueError.make({ cause }),
            });

            const markerUpdated = yield* dbTry(() =>
              db
                .update(rooms)
                .set({
                  lastEnqueuedTurnNumber: sql`max(${rooms.lastEnqueuedTurnNumber}, ${result.firstJob.turnNumber})`,
                })
                .where(eq(rooms.id, result.roomId))
                .run(),
            ).pipe(
              Effect.as(true),
              Effect.catchAll((e) =>
                Effect.logError("admin.last_enqueued_turn.update_failed").pipe(
                  Effect.annotateLogs({ cause: String(e.cause) }),
                  Effect.as(false),
                ),
              ),
            );

            return json(200, {
              roomId: result.roomId,
              threadId,
              firstJob: result.firstJob,
              enqueued: true,
              markerUpdated,
            });
          }

          return json(405, { error: "Method not allowed" });
        }

        // /admin/rooms/:id
        if (segments.length === 3 && segments[1] === "rooms") {
          const roomId = Number(segments[2]);
          if (!Number.isFinite(roomId)) return json(400, { error: "Invalid room id" });

          if (request.method === "GET") {
            const room = yield* dbTry(() =>
              db.select().from(rooms).where(eq(rooms.id, roomId)).get(),
            );
            if (!room) {
              return yield* Effect.fail(
                AdminNotFound.make({ resource: "room", id: String(roomId) }),
              );
            }

            const participants = yield* dbTry(() =>
              db
                .select({
                  turnOrder: roomAgents.turnOrder,
                  agent: agents,
                })
                .from(roomAgents)
                .innerJoin(agents, eq(roomAgents.agentId, agents.id))
                .where(eq(roomAgents.roomId, roomId))
                .orderBy(asc(roomAgents.turnOrder))
                .all(),
            );

            const recentMessages = yield* dbTry(() =>
              db
                .select()
                .from(messages)
                .where(eq(messages.roomId, roomId))
                .orderBy(desc(messages.createdAtMs), desc(messages.id))
                .limit(50)
                .all(),
            );

            return json(200, { room, participants, recentMessages });
          }

          return json(405, { error: "Method not allowed" });
        }

        // /admin/rooms/:id/events
        if (segments.length === 4 && segments[1] === "rooms" && segments[3] === "events") {
          const roomId = Number(segments[2]);
          if (!Number.isFinite(roomId)) return json(400, { error: "Invalid room id" });

          if (request.method !== "GET") return json(405, { error: "Method not allowed" });

          const rows = yield* dbTry(() =>
            db
              .select()
              .from(roomTurnEvents)
              .where(eq(roomTurnEvents.roomId, roomId))
              .orderBy(asc(roomTurnEvents.turnNumber), asc(roomTurnEvents.createdAtMs))
              .all(),
          );

          return json(200, { roomId, events: rows });
        }

        // /admin/rooms/:id/unlock | /admin/rooms/:id/pause | /admin/rooms/:id/resume | /admin/rooms/:id/kick
        if (segments.length === 4 && segments[1] === "rooms") {
          const roomId = Number(segments[2]);
          if (!Number.isFinite(roomId)) return json(400, { error: "Invalid room id" });

          if (request.method !== "POST") return json(405, { error: "Method not allowed" });

          const action = segments[3];

          if (action === "unlock") {
            const discord = yield* Discord;

            const room = yield* dbTry(() =>
              db.select().from(rooms).where(eq(rooms.id, roomId)).get(),
            );
            if (!room) {
              return yield* Effect.fail(
                AdminNotFound.make({ resource: "room", id: String(roomId) }),
              );
            }

            const threadId = room.threadId;

            return yield* discord.unlockThread(threadId).pipe(
              Effect.tap(() =>
                Effect.logInfo("admin.room.unlock_thread.success").pipe(
                  Effect.annotateLogs({ roomId, threadId }),
                ),
              ),
              Effect.as(json(200, { success: true, roomId, threadId })),
              Effect.catchAll((e) =>
                Effect.logError("admin.room.unlock_thread.failed").pipe(
                  Effect.annotateLogs({ roomId, threadId, error: String(e) }),
                  Effect.as(json(502, { success: false, roomId, threadId, error: e })),
                ),
              ),
            );
          }

          if (action === "pause") {
            const room = yield* dbTry(() =>
              db.select().from(rooms).where(eq(rooms.id, roomId)).get(),
            );
            if (!room) {
              return yield* Effect.fail(
                AdminNotFound.make({ resource: "room", id: String(roomId) }),
              );
            }

            yield* dbTry(() =>
              db.update(rooms).set({ status: "paused" }).where(eq(rooms.id, roomId)).run(),
            );
            return json(200, { ok: true });
          }

          if (action === "resume") {
            const room = yield* dbTry(() =>
              db.select().from(rooms).where(eq(rooms.id, roomId)).get(),
            );
            if (!room) {
              return yield* Effect.fail(
                AdminNotFound.make({ resource: "room", id: String(roomId) }),
              );
            }

            yield* dbTry(() =>
              db.update(rooms).set({ status: "active" }).where(eq(rooms.id, roomId)).run(),
            );

            const nextTurnNumber = room.currentTurnNumber + 1;

            if (room.lastEnqueuedTurnNumber < nextTurnNumber) {
              const job: TurnJob = { type: "turn", roomId, turnNumber: nextTurnNumber };
              yield* Effect.tryPromise({
                try: () => env.ARENA_QUEUE.send(job),
                catch: (cause) => AdminQueueError.make({ cause }),
              });

              yield* dbTry(() =>
                db
                  .update(rooms)
                  .set({
                    lastEnqueuedTurnNumber: sql`max(${rooms.lastEnqueuedTurnNumber}, ${nextTurnNumber})`,
                  })
                  .where(eq(rooms.id, roomId))
                  .run(),
              ).pipe(
                Effect.catchAll((e) =>
                  Effect.logError("admin.last_enqueued_turn.update_failed").pipe(
                    Effect.annotateLogs({ cause: String(e.cause) }),
                    Effect.asVoid,
                  ),
                ),
              );
            }

            return json(200, { ok: true, enqueued: room.lastEnqueuedTurnNumber < nextTurnNumber });
          }

          if (action === "kick") {
            const room = yield* dbTry(() =>
              db.select().from(rooms).where(eq(rooms.id, roomId)).get(),
            );
            if (!room) {
              return yield* Effect.fail(
                AdminNotFound.make({ resource: "room", id: String(roomId) }),
              );
            }

            if (room.status !== "active") {
              return json(409, { error: "Room is paused", ok: false, enqueued: false });
            }

            const nextTurnNumber = room.currentTurnNumber + 1;

            // Prevent accidental duplicates while the room is actively progressing.
            // Only allow kick when the room looks stale (no recent messages recorded).
            const lastMsg = yield* dbTry(() =>
              db
                .select({ createdAtMs: messages.createdAtMs })
                .from(messages)
                .where(eq(messages.roomId, roomId))
                .orderBy(desc(messages.createdAtMs))
                .get(),
            );

            const now = Date.now();
            const ageMs = lastMsg ? now - Number(lastMsg.createdAtMs) : Number.POSITIVE_INFINITY;
            if (ageMs < 15_000) {
              return json(409, {
                error: "Room not stale (refusing to kick)",
                ok: false,
                enqueued: false,
                nextTurnNumber,
              });
            }

            const job: TurnJob = { type: "turn", roomId, turnNumber: nextTurnNumber };

            yield* Effect.tryPromise({
              try: () => env.ARENA_QUEUE.send(job),
              catch: (cause) => AdminQueueError.make({ cause }),
            });

            yield* dbTry(() =>
              db
                .update(rooms)
                .set({
                  lastEnqueuedTurnNumber: sql`max(${rooms.lastEnqueuedTurnNumber}, ${nextTurnNumber})`,
                })
                .where(eq(rooms.id, roomId))
                .run(),
            ).pipe(
              Effect.catchAll((e) =>
                Effect.logError("admin.last_enqueued_turn.update_failed").pipe(
                  Effect.annotateLogs({ cause: String(e.cause) }),
                  Effect.asVoid,
                ),
              ),
            );

            return json(200, { ok: true, enqueued: true, turnNumber: nextTurnNumber });
          }

          return json(404, { error: "Not Found" });
        }

        return json(404, { error: "Not Found" });
      }).pipe(
        Effect.annotateLogs({ requestId, route: url.pathname }),
        Effect.withLogSpan("http.admin"),
        Effect.catchTag("AdminUnauthorized", () =>
          Effect.succeed(json(401, { error: "Unauthorized", requestId })),
        ),
        Effect.catchTag("AdminMissingConfig", (e) =>
          Effect.succeed(json(500, { error: `Missing ${e.key}`, requestId })),
        ),
        Effect.catchTag("AdminBadRequest", (e) =>
          Effect.succeed(json(400, { error: e.message, requestId })),
        ),
        Effect.catchTag("AdminNotFound", (e) =>
          Effect.succeed(json(404, { error: `${e.resource} not found`, id: e.id, requestId })),
        ),
        Effect.catchTag("AdminDbError", (e) =>
          Effect.gen(function* () {
            yield* Effect.logError("admin.db_error").pipe(
              Effect.annotateLogs({ cause: String(e.cause) }),
            );
            return json(500, { error: "DB error", requestId });
          }),
        ),
        Effect.catchTag("AdminQueueError", (e) =>
          Effect.gen(function* () {
            yield* Effect.logError("admin.queue_error").pipe(
              Effect.annotateLogs({ cause: String(e.cause) }),
            );
            return json(500, { error: "Queue error", requestId });
          }),
        ),
        Effect.catchAllCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logError("admin.unhandled").pipe(
              Effect.annotateLogs({ cause: String(cause) }),
            );
            return json(500, { error: "Internal error", requestId });
          }),
        ),
      );

      return await runtime.runPromise(program);
    }

    // Health
    if (request.method === "GET" && url.pathname === "/health") {
      return json(200, { ok: true });
    }

    // Discord interactions (slash commands)
    if (url.pathname === "/discord/interactions" && request.method === "POST") {
      const publicKey = env.DISCORD_PUBLIC_KEY;
      if (!publicKey) return json(500, { error: "Missing DISCORD_PUBLIC_KEY" });

      const respond = (content: string) =>
        json(200, {
          // CHANNEL_MESSAGE_WITH_SOURCE
          type: 4,
          data: {
            content,
            // EPHEMERAL
            flags: 64,
          },
        });

      const sig = request.headers.get("X-Signature-Ed25519") ?? "";
      const ts = request.headers.get("X-Signature-Timestamp") ?? "";
      const raw = new Uint8Array(await request.clone().arrayBuffer());

      const ok = await runtime.runPromise(
        verifyDiscordInteraction({
          publicKeyHex: publicKey,
          signatureHex: sig,
          timestamp: ts,
          body: raw,
        }).pipe(
          Effect.annotateLogs({ requestId, route: "/discord/interactions" }),
          Effect.withLogSpan("discord.verify_interaction"),
        ),
      );

      if (!ok) return json(401, { error: "Invalid signature" });

      const interaction = (await request.json()) as APIInteraction;

      // PING -> PONG
      if (interaction.type === 1) {
        return json(200, { type: 1 });
      }

      // APPLICATION_COMMAND
      if (interaction.type !== 2) {
        return respond("Agon: unsupported interaction type.");
      }

      const threadId = (interaction as unknown as { channel_id?: unknown }).channel_id;
      const commandName = (interaction as unknown as { data?: { name?: unknown } }).data?.name;

      if (typeof threadId !== "string" || typeof commandName !== "string") {
        return respond("Agon: malformed command payload.");
      }

      type SlashResult = {
        readonly content: string;
        readonly enqueue?: RoomTurnJob;
        readonly background?: Effect.Effect<void, never, never>;
      };
      type InteractionDbError = { readonly _tag: "InteractionDbError"; readonly cause: unknown };

      const reply = (content: string, enqueue?: RoomTurnJob): SlashResult =>
        enqueue ? { content, enqueue } : { content };

      const replyBg = (
        content: string,
        background: Effect.Effect<void, never, never>,
      ): SlashResult => ({
        content,
        background,
      });

      const withBackground = (
        result: SlashResult,
        background: Effect.Effect<void, never, never>,
      ): SlashResult => ({ ...result, background });

      const dbTryInteraction = <A>(thunk: () => Promise<A>) =>
        Effect.tryPromise({
          try: thunk,
          catch: (cause): InteractionDbError => ({ _tag: "InteractionDbError", cause }),
        });

      const program = Effect.gen(function* () {
        const { db } = yield* Db;
        const discord = yield* Discord;

        const room = yield* dbTryInteraction(() =>
          db.select().from(rooms).where(eq(rooms.threadId, threadId)).get(),
        );

        if (!room) {
          return reply(
            "Agon: no room found for this thread. Please run the command inside an Agon room thread.",
          );
        }

        const roomId = room.id;
        const name = commandName.toLowerCase();

        const loadRoom = () =>
          dbTryInteraction(() => db.select().from(rooms).where(eq(rooms.id, roomId)).get());

        const enqueueNextTurn = Effect.fn("DiscordSlash.enqueueNextTurn")(() =>
          Effect.gen(function* () {
            const fresh = yield* loadRoom();
            if (!fresh) {
              return reply("Agon: room not found (it may have been deleted).");
            }

            const nextTurnNumber = fresh.currentTurnNumber + 1;

            if (fresh.lastEnqueuedTurnNumber >= nextTurnNumber) {
              return reply(`Agon: turn #${nextTurnNumber} is already enqueued.`);
            }

            yield* dbTryInteraction(() =>
              db
                .update(rooms)
                .set({
                  lastEnqueuedTurnNumber: sql`max(${rooms.lastEnqueuedTurnNumber}, ${nextTurnNumber})`,
                })
                .where(eq(rooms.id, roomId))
                .run(),
            );

            return reply(`Agon: enqueued next turn (#${nextTurnNumber}).`, {
              type: "turn",
              roomId,
              turnNumber: nextTurnNumber,
            });
          }),
        );

        switch (name) {
          case "next": {
            const fresh = yield* loadRoom();
            if (!fresh) {
              return reply("Agon: room not found (it may have been deleted).");
            }
            if (fresh.status !== "active") {
              return reply("Agon: room is paused. Use /continue to resume.");
            }
            return yield* enqueueNextTurn();
          }

          case "stop": {
            yield* dbTryInteraction(() =>
              db.update(rooms).set({ status: "paused" }).where(eq(rooms.id, roomId)).run(),
            );

            // Best-effort: unlock thread (in the background to avoid Discord's 3s interaction timeout)
            const background = discord
              .unlockThread(threadId)
              .pipe(
                Effect.catchAll((e) =>
                  Effect.logWarning("discord.thread.unlock.failed").pipe(
                    Effect.annotateLogs({ requestId, roomId, threadId, error: String(e) }),
                    Effect.asVoid,
                  ),
                ),
              );

            return replyBg("Agon: room paused and thread unlocked.", background);
          }

          case "audience": {
            // Stop the auto-loop by pausing the room; unlock the thread so humans can speak.
            yield* dbTryInteraction(() =>
              db.update(rooms).set({ status: "paused" }).where(eq(rooms.id, roomId)).run(),
            );

            const background = discord
              .unlockThread(threadId)
              .pipe(
                Effect.catchAll((e) =>
                  Effect.logWarning("discord.thread.unlock.failed").pipe(
                    Effect.annotateLogs({ requestId, roomId, threadId, error: String(e) }),
                    Effect.asVoid,
                  ),
                ),
              );

            return replyBg(
              "Agon: audience slot opened (room paused, thread unlocked). Use /continue to resume.",
              background,
            );
          }

          case "continue": {
            // Resume the loop and close the audience slot.
            yield* dbTryInteraction(() =>
              db.update(rooms).set({ status: "active" }).where(eq(rooms.id, roomId)).run(),
            );

            // Best-effort: lock thread in the background (the turn handler also locks during processing)
            const background = discord
              .lockThread(threadId)
              .pipe(
                Effect.catchAll((e) =>
                  Effect.logWarning("discord.thread.lock.failed").pipe(
                    Effect.annotateLogs({ requestId, roomId, threadId, error: String(e) }),
                    Effect.asVoid,
                  ),
                ),
              );

            const enqueued = yield* enqueueNextTurn();
            return withBackground(enqueued, background);
          }

          default:
            return reply(
              `Agon: unknown command: /${commandName}. Available: /next, /stop, /audience, /continue.`,
            );
        }
      }).pipe(
        Effect.annotateLogs({ requestId, route: "/discord/interactions", threadId, commandName }),
        Effect.withLogSpan("discord.slash_command"),
      );

      const result = await runtime.runPromise(
        program.pipe(
          Effect.catchAll((e) =>
            Effect.gen(function* () {
              yield* Effect.logError("discord.slash_command.db_error").pipe(
                Effect.annotateLogs({
                  requestId,
                  threadId,
                  commandName,
                  cause: String((e as InteractionDbError).cause),
                }),
              );

              return reply("Agon: failed to handle command. Please try again or contact an admin.");
            }),
          ),
        ),
      );

      const response = respond(result.content);

      if (result.enqueue) {
        ctx.waitUntil(env.ARENA_QUEUE.send(result.enqueue));
      }

      if (result.background) {
        ctx.waitUntil(Effect.runPromise(result.background));
      }

      return response;
    }

    // DEV: start arena without Discord
    if (url.pathname === "/dev/arena/start" && request.method === "POST") {
      const program = Effect.gen(function* () {
        yield* Effect.logInfo("http.dev.arena.start");
        const arena = yield* ArenaService;
        const payload = yield* parseJson<{ channelId: string; topic: string; agentIds?: string[] }>(
          request,
        ).pipe(Effect.mapError(() => DevBadRequest.make({ message: "Invalid JSON body" })));
        const result = yield* arena.startArena(payload);
        return result;
      }).pipe(
        Effect.annotateLogs({ requestId, route: "/dev/arena/start" }),
        Effect.withLogSpan("http.dev.arena.start"),
      );

      try {
        const result = await runtime.runPromise(program);
        ctx.waitUntil(env.ARENA_QUEUE.send(result.firstJob));
        return json(200, {
          roomId: result.roomId,
          // Back-compat field name (temporary)
          arenaId: result.roomId,
          enqueued: true,
          firstJob: result.firstJob,
        });
      } catch (e) {
        if (e instanceof DevBadRequest) {
          return json(400, { error: e.message, requestId });
        }
        console.error("dev.arena.start.failed", e);
        return json(500, { error: "Internal error", requestId });
      }
    }

    // DEV: create a Discord room as a public thread under a parent channel
    if (url.pathname === "/dev/room/create" && request.method === "POST") {
      const payload = (await request.json().catch(() => null)) as unknown;
      const rec =
        payload && typeof payload === "object" ? (payload as Record<string, unknown>) : undefined;

      const parentChannelId =
        rec && typeof rec.parentChannelId === "string" ? rec.parentChannelId : undefined;
      const name = rec && typeof rec.name === "string" ? rec.name : undefined;
      const topic = rec && typeof rec.topic === "string" ? rec.topic : undefined;

      const agentIdsRaw = rec && Array.isArray(rec.agentIds) ? rec.agentIds : undefined;
      const agentIds = agentIdsRaw?.filter((a): a is string => typeof a === "string");

      const allowed = [60, 1440, 4320, 10080] as const;
      const autoArchiveDurationMinutesRaw =
        rec && typeof rec.autoArchiveDurationMinutes === "number"
          ? rec.autoArchiveDurationMinutes
          : undefined;
      const autoArchiveDurationMinutesNum = autoArchiveDurationMinutesRaw ?? 1440;

      if (!parentChannelId || !name || !topic) {
        return json(400, { error: "Invalid payload" });
      }

      if (!allowed.includes(autoArchiveDurationMinutesNum as (typeof allowed)[number])) {
        return json(400, {
          error: "Invalid autoArchiveDurationMinutes",
          allowed,
        });
      }

      const autoArchiveDurationMinutes =
        autoArchiveDurationMinutesNum as DiscordAutoArchiveDurationMinutes;

      const program = Effect.gen(function* () {
        yield* Effect.logInfo("http.dev.room.create");
        const discord = yield* Discord;
        const { db } = yield* Db;
        const arena = yield* ArenaService;

        const existingWebhook = yield* Effect.tryPromise({
          try: () =>
            db
              .select()
              .from(discordChannels)
              .where(eq(discordChannels.channelId, parentChannelId))
              .get(),
          catch: (e) => e,
        }).pipe(Effect.mapError((cause) => DevDbError.make({ cause })));

        const webhook = existingWebhook
          ? { id: existingWebhook.webhookId, token: existingWebhook.webhookToken }
          : yield* discord.createOrFetchWebhook(parentChannelId);

        // Upsert webhook mapping for the parent channel
        yield* Effect.tryPromise({
          try: () =>
            db
              .insert(discordChannels)
              .values({
                channelId: parentChannelId,
                webhookId: webhook.id,
                webhookToken: webhook.token,
              })
              .onConflictDoUpdate({
                target: discordChannels.channelId,
                set: { webhookId: webhook.id, webhookToken: webhook.token },
              })
              .run(),
          catch: (e) => e,
        }).pipe(Effect.mapError((cause) => DevDbError.make({ cause })));

        const threadId = yield* discord.createPublicThread(parentChannelId, {
          name,
          autoArchiveDurationMinutes,
        });

        const result = yield* arena.createRoom({
          parentChannelId,
          threadId,
          topic,
          autoArchiveDurationMinutes,
          ...(agentIds && agentIds.length > 0 ? { agentIds } : {}),
        });

        return { roomId: result.roomId, threadId, firstJob: result.firstJob } as const;
      });

      try {
        const result = await runtime.runPromise(
          program.pipe(
            Effect.annotateLogs({ requestId, route: "/dev/room/create", parentChannelId }),
            Effect.withLogSpan("http.dev.room.create"),
          ),
        );
        ctx.waitUntil(env.ARENA_QUEUE.send(result.firstJob));
        return json(200, { roomId: result.roomId, threadId: result.threadId });
      } catch (e) {
        if (e instanceof DevDbError) {
          return json(500, { error: "DB error", requestId });
        }
        console.error("dev.room.create.failed", e);
        return json(500, { error: "Internal error", requestId });
      }
    }

    if (url.pathname === "/dev/arena/stop" && request.method === "POST") {
      const program = Effect.gen(function* () {
        yield* Effect.logInfo("http.dev.arena.stop");
        const arena = yield* ArenaService;
        const payload = yield* parseJson<{ roomId?: number; arenaId?: number }>(request).pipe(
          Effect.mapError(() => DevBadRequest.make({ message: "Invalid JSON body" })),
        );
        const roomId = payload.roomId ?? payload.arenaId;
        if (roomId === undefined) {
          return yield* Effect.fail(DevBadRequest.make({ message: "Missing roomId" }));
        }
        yield* arena.stopArena(roomId);
        return { ok: true, roomId };
      }).pipe(
        Effect.annotateLogs({ requestId, route: "/dev/arena/stop" }),
        Effect.withLogSpan("http.dev.arena.stop"),
      );

      try {
        return json(200, await runtime.runPromise(program));
      } catch (e) {
        if (e instanceof DevBadRequest) {
          return json(400, { error: e.message, requestId });
        }
        console.error("dev.arena.stop.failed", e);
        return json(500, { error: "Internal error", requestId });
      }
    }

    // Static assets + SPA fallback (admin UI)
    if (env.ASSETS) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return asset;

      // SPA fallback: serve admin UI for unmatched routes
      return env.ASSETS.fetch(new Request(new URL("/index.html", request.url)));
    }

    return text(404, "Not Found");
  },

  async queue(batch: MessageBatch<RoomTurnJob>, env: Env, _ctx: ExecutionContext): Promise<void> {
    const runtime = makeRuntime(env);

    const normalizeJob = (raw: unknown): RoomTurnJob => {
      if (typeof raw === "object" && raw !== null && "type" in raw) {
        return raw as RoomTurnJob;
      }
      const r = raw as { readonly roomId: number; readonly turnNumber: number };
      return { type: "turn", roomId: r.roomId, turnNumber: r.turnNumber };
    };

    const sendJob = async (job: RoomTurnJob): Promise<void> => {
      if (job.type === "close_audience_slot") {
        await env.ARENA_QUEUE.send(job, { delaySeconds: job.delaySeconds });
      } else {
        await env.ARENA_QUEUE.send(job);
      }
    };

    for (const message of batch.messages) {
      try {
        const job = normalizeJob(message.body);

        const annotations = {
          queue: batch.queue,
          queueMessageId: message.id,
          attempts: message.attempts,
          jobType: job.type,
          roomId: job.roomId,
          turnNumber: job.turnNumber,
        };

        const program: Effect.Effect<
          RoomTurnJob | null,
          ArenaError,
          ArenaService | Db | Discord | TurnEventService
        > =
          job.type === "close_audience_slot"
            ? Effect.gen(function* () {
                yield* Effect.logInfo("queue.audience_slot.close");

                const { db } = yield* Db;
                const discord = yield* Discord;
                const turnEvents = yield* TurnEventService;

                const room = yield* Effect.tryPromise({
                  try: () => db.select().from(rooms).where(eq(rooms.id, job.roomId)).get(),
                  catch: (e) => e,
                }).pipe(Effect.mapError((cause) => RoomDbError.make({ cause })));

                if (!room) return null;

                // If the room was manually paused/resumed, or already advanced, do nothing.
                if (room.status !== "audience_slot" && room.status !== "active") return null;
                if (room.currentTurnNumber !== job.turnNumber) return null;

                const nextTurnNumber = room.currentTurnNumber + 1;
                if (room.lastEnqueuedTurnNumber >= nextTurnNumber) {
                  yield* turnEvents.write({
                    roomId: room.id,
                    turnNumber: job.turnNumber,
                    phase: "audience_slot_close",
                    status: "info",
                    data: { skippedEnqueue: true, nextTurnNumber },
                  });
                  return null;
                }

                const nextAgentName = yield* Effect.tryPromise({
                  try: () =>
                    db
                      .select({ name: agents.name })
                      .from(agents)
                      .where(eq(agents.id, room.currentTurnAgentId))
                      .get(),
                  catch: (e) => e,
                }).pipe(
                  Effect.map((row) => row?.name ?? "Unknown"),
                  Effect.catchAll((e) =>
                    Effect.logWarning("db.next_agent.lookup.failed").pipe(
                      Effect.annotateLogs({ roomId: room.id, error: String(e) }),
                      Effect.as("Unknown"),
                    ),
                  ),
                );

                const notificationContent = `🔒 Audience slot closed - debate continues with ${nextAgentName}`;

                const posted = yield* discord.postMessage(room.threadId, notificationContent).pipe(
                  Effect.catchAll((e) =>
                    Effect.logWarning("discord.postMessage.failed").pipe(
                      Effect.annotateLogs({
                        roomId: room.id,
                        threadId: room.threadId,
                        error: String(e),
                      }),
                      Effect.as(null),
                    ),
                  ),
                );

                const parsed = posted ? Date.parse(posted.timestamp) : NaN;
                const now = yield* nowMs;
                const createdAtMs = posted && Number.isFinite(parsed) ? parsed : now;
                const discordMessageId = posted
                  ? posted.id
                  : `local-notification:audience_close:${room.id}:${job.turnNumber}`;

                // Best-effort: store in D1 so notifications are visible in admin UI and filtered out of prompts.
                yield* Effect.tryPromise({
                  try: () =>
                    db
                      .insert(messages)
                      .values({
                        roomId: room.id,
                        discordMessageId,
                        threadId: room.threadId,
                        authorType: "notification",
                        authorAgentId: null,
                        authorName: "System",
                        content: notificationContent,
                        createdAtMs,
                      })
                      .onConflictDoNothing({ target: messages.discordMessageId })
                      .run(),
                  catch: (e) => e,
                }).pipe(
                  Effect.catchAll((e) =>
                    Effect.logWarning("db.notification_insert.failed").pipe(
                      Effect.annotateLogs({ roomId: room.id, error: String(e) }),
                      Effect.asVoid,
                    ),
                  ),
                  Effect.asVoid,
                );

                // Best-effort: lock the thread.
                yield* discord.lockThread(room.threadId).pipe(
                  Effect.catchAll((e) =>
                    Effect.logWarning("discord.thread.lock.failed").pipe(
                      Effect.annotateLogs({
                        roomId: room.id,
                        threadId: room.threadId,
                        error: String(e),
                      }),
                      Effect.asVoid,
                    ),
                  ),
                  Effect.asVoid,
                );

                yield* Effect.tryPromise({
                  try: () =>
                    db.update(rooms).set({ status: "active" }).where(eq(rooms.id, room.id)).run(),
                  catch: (e) => e,
                }).pipe(Effect.mapError((cause) => RoomDbError.make({ cause })));

                yield* turnEvents.write({
                  roomId: room.id,
                  turnNumber: job.turnNumber,
                  phase: "audience_slot_close",
                  status: "ok",
                  data: { nextTurnNumber },
                });

                return { type: "turn", roomId: room.id, turnNumber: nextTurnNumber } as const;
              }).pipe(
                Effect.annotateLogs(annotations),
                Effect.withLogSpan("queue.audience_slot.close"),
              )
            : Effect.gen(function* () {
                yield* Effect.logInfo("queue.turn");
                const arena = yield* ArenaService;
                const next = yield* arena.processTurn(job as TurnJob);
                if (next) {
                  yield* Effect.logInfo("queue.turn.next").pipe(
                    Effect.annotateLogs({
                      nextTurnNumber: next.turnNumber,
                      nextJobType: next.type,
                    }),
                  );
                }
                return next;
              }).pipe(Effect.annotateLogs(annotations), Effect.withLogSpan("queue.turn"));

        const next = await runtime.runPromise(program);
        if (next) {
          await sendJob(next);

          if (next.type === "turn") {
            // Persist an enqueue marker so a redelivered message (e.g., crash between send+ack)
            // doesn't re-enqueue duplicates.
            const markEnqueued = Effect.gen(function* () {
              yield* Effect.logDebug("queue.mark_enqueued");
              const { db } = yield* Db;
              yield* Effect.tryPromise({
                try: () =>
                  db
                    .update(rooms)
                    .set({
                      lastEnqueuedTurnNumber: sql`max(${rooms.lastEnqueuedTurnNumber}, ${next.turnNumber})`,
                    })
                    .where(eq(rooms.id, next.roomId))
                    .run(),
                catch: () => null,
              });
            }).pipe(Effect.annotateLogs(annotations), Effect.withLogSpan("queue.mark_enqueued"));

            await runtime.runPromise(markEnqueued);
          }
        }

        message.ack();
      } catch (e) {
        console.error("queue message failed", e);
        message.retry({ delaySeconds: Math.min(60, 2 ** message.attempts) });
      }
    }
  },
};
