export const API_BASE = "/admin";

export async function apiFetch(path: string, options?: RequestInit) {
  const headers = new Headers(options?.headers);
  if (!headers.has("Content-Type") && options?.body) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: "same-origin",
    headers,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API error: ${res.status} ${res.statusText}${body ? ` - ${body}` : ""}`);
  }

  if (res.status === 204) return null;
  return res.json();
}

export type AuthUser = {
  login: string;
  avatar_url: string;
  sub: number;
};

export async function authMe(): Promise<AuthUser | null> {
  try {
    const res = await fetch("/auth/me", { credentials: "same-origin" });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function authLogout(): Promise<void> {
  await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
}

export type Agent = {
  readonly id: string;
  readonly name: string;
  readonly avatarUrl: string | null;
  readonly systemPrompt: string;
  readonly llmProvider: "openai" | "anthropic" | "gemini" | "openrouter";
  readonly llmModel: string;

  // Optional per-agent generation params (null => provider defaults)
  readonly temperature: string | null;
  readonly maxTokens: number | null;
  readonly thinkingLevel: "low" | "medium" | "high" | null;
  readonly thinkingBudgetTokens: number | null;
};

export type Room = {
  readonly id: number;
  readonly status: "active" | "paused" | "audience_slot";
  readonly title: string;
  readonly topic: string;
  readonly parentChannelId: string;
  readonly threadId: string;
  readonly autoArchiveDurationMinutes: number;
  readonly currentTurnAgentId: string;
  readonly currentTurnNumber: number;
  readonly lastEnqueuedTurnNumber: number;
  readonly maxTurns: number;
};

export type Message = {
  readonly id: number;
  readonly roomId: number;
  readonly discordMessageId: string;
  readonly threadId: string;
  readonly authorType: "human" | "agent" | "bot_other";
  readonly authorAgentId: string | null;
  readonly content: string;
  readonly createdAtMs: number;
};

export type RoomTurnEvent = {
  readonly roomId: number;
  readonly turnNumber: number;
  readonly phase: string;
  readonly status: string;
  readonly createdAtMs: number;
  readonly dataJson: string | null;
};

export type AdminSetting = {
  readonly key: string;
  readonly label: string;
  readonly sensitive: boolean;
  readonly configured: boolean;
  readonly source: "db" | "db_invalid" | "env" | null;
  readonly maskedValue: string | null;
  readonly updatedAtMs: number | null;
};

export const agentsApi = {
  list: async (): Promise<readonly Agent[]> => {
    const res = (await apiFetch("/agents")) as { agents: readonly Agent[] };
    return res.agents;
  },
  get: async (id: string): Promise<Agent> => {
    const res = (await apiFetch(`/agents/${id}`)) as { agent: Agent };
    return res.agent;
  },
  create: async (data: unknown): Promise<Agent> => {
    const res = (await apiFetch("/agents", {
      method: "POST",
      body: JSON.stringify(data),
    })) as { agent: Agent };
    return res.agent;
  },
  update: async (id: string, data: unknown): Promise<Agent> => {
    const res = (await apiFetch(`/agents/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    })) as { agent: Agent };
    return res.agent;
  },
  remove: async (id: string): Promise<void> => {
    await apiFetch(`/agents/${id}`, { method: "DELETE" });
  },
};

export const roomsApi = {
  list: async (): Promise<readonly Room[]> => {
    const res = (await apiFetch("/rooms")) as { rooms: readonly Room[] };
    return res.rooms;
  },
  get: async (
    id: string,
  ): Promise<{
    room: Room;
    participants: ReadonlyArray<{ turnOrder: number; agent: Agent }>;
    recentMessages: readonly Message[];
  }> => {
    return (await apiFetch(`/rooms/${id}`)) as {
      room: Room;
      participants: ReadonlyArray<{ turnOrder: number; agent: Agent }>;
      recentMessages: readonly Message[];
    };
  },
  create: async (
    data: unknown,
  ): Promise<{
    roomId: number;
    threadId: string;
    enqueued: boolean;
  }> => {
    return (await apiFetch("/rooms", {
      method: "POST",
      body: JSON.stringify(data),
    })) as { roomId: number; threadId: string; enqueued: boolean };
  },
  pause: async (roomId: number): Promise<void> => {
    await apiFetch(`/rooms/${roomId}/pause`, { method: "POST" });
  },
  resume: async (roomId: number): Promise<{ enqueued: boolean }> => {
    return (await apiFetch(`/rooms/${roomId}/resume`, { method: "POST" })) as {
      enqueued: boolean;
    };
  },
  kick: async (roomId: number): Promise<{ enqueued: boolean; turnNumber: number }> => {
    return (await apiFetch(`/rooms/${roomId}/kick`, { method: "POST" })) as {
      enqueued: boolean;
      turnNumber: number;
    };
  },
  events: async (roomId: number | string): Promise<readonly RoomTurnEvent[]> => {
    const res = (await apiFetch(`/rooms/${roomId}/events`)) as {
      roomId: number;
      events: readonly RoomTurnEvent[];
    };
    return res.events;
  },
};

export const settingsApi = {
  list: async (): Promise<readonly AdminSetting[]> => {
    const res = (await apiFetch("/settings")) as { settings: readonly AdminSetting[] };
    return res.settings;
  },
  set: async (key: string, value: string): Promise<void> => {
    await apiFetch(`/settings/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    });
  },
  remove: async (key: string): Promise<void> => {
    await apiFetch(`/settings/${encodeURIComponent(key)}`, { method: "DELETE" });
  },
};

export type DiscordGuild = {
  readonly id: string;
  readonly name: string;
  readonly icon: string | null;
  readonly owner: boolean;
};

export const discordApi = {
  guilds: async (): Promise<readonly DiscordGuild[]> => {
    const res = (await apiFetch("/discord/guilds")) as { guilds: DiscordGuild[] };
    return res.guilds;
  },
};
