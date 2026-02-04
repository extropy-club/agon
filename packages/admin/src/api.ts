export const API_BASE = "/admin";

const getAdminToken = (): string | null => {
  try {
    return localStorage.getItem("agon.adminToken");
  } catch {
    return null;
  }
};

export async function apiFetch(path: string, options?: RequestInit) {
  const token = getAdminToken();

  const headers = new Headers(options?.headers);
  if (!headers.has("Content-Type") && options?.body) {
    headers.set("Content-Type", "application/json");
  }

  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API error: ${res.status} ${res.statusText}${body ? ` - ${body}` : ""}`);
  }

  if (res.status === 204) return null;
  return res.json();
}

export type Agent = {
  readonly id: string;
  readonly name: string;
  readonly avatarUrl: string | null;
  readonly systemPrompt: string;
  readonly llmProvider: "openai" | "anthropic" | "gemini";
  readonly llmModel: string;
};

export type Room = {
  readonly id: number;
  readonly status: "active" | "paused";
  readonly topic: string;
  readonly parentChannelId: string;
  readonly threadId: string;
  readonly autoArchiveDurationMinutes: number;
  readonly currentTurnAgentId: string;
  readonly currentTurnNumber: number;
  readonly lastEnqueuedTurnNumber: number;
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
};
