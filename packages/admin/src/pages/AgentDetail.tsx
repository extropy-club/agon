import { A, useLocation, useParams } from "@solidjs/router";
import { Show, createMemo, createResource } from "solid-js";
import { API_BASE, type Agent } from "../api";
import AgentOverview from "../components/AgentOverview";

type Tab = "overview" | "memories";

async function fetchAgent(id: string): Promise<Agent | null> {
  const res = await fetch(`${API_BASE}/agents/${encodeURIComponent(id)}`, {
    credentials: "same-origin",
  });

  if (res.status === 404) return null;

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API error: ${res.status} ${res.statusText}${body ? ` - ${body}` : ""}`);
  }

  const json = (await res.json()) as { agent: Agent };
  return json.agent;
}

export default function AgentDetail() {
  const params = useParams();
  const location = useLocation();

  const [agent] = createResource(
    () => params.id,
    (id) => fetchAgent(id),
  );

  const tab = createMemo<Tab>(() => {
    const sp = new URLSearchParams(location.search);
    return sp.get("tab") === "memories" ? "memories" : "overview";
  });

  const hrefForTab = (t: Tab) => {
    const id = params.id;
    if (t === "memories") return `/agents/${encodeURIComponent(id)}?tab=memories`;
    return `/agents/${encodeURIComponent(id)}`;
  };

  return (
    <div>
      <Show when={!agent.loading} fallback={<p>Loading agent...</p>}>
        <Show when={!agent.error} fallback={<div class="card">{String(agent.error)}</div>}>
          {/* After loading: agent() is either Agent (found) or null (404) */}
          <Show
            when={agent()}
            fallback={
              <div>
                <header
                  style={{
                    display: "flex",
                    "justify-content": "space-between",
                    "align-items": "center",
                    "margin-bottom": "1rem",
                    gap: "1rem",
                  }}
                >
                  <h1 style={{ margin: 0 }}>Agent not found</h1>
                  <A class="btn" href="/agents">
                    ← Back to Agents
                  </A>
                </header>
                <div class="card">
                  <p style={{ margin: 0 }}>
                    No agent exists with id <code>{params.id}</code>.
                  </p>
                </div>
              </div>
            }
          >
            {(a) => (
              <div>
                <header
                  style={{
                    display: "flex",
                    "justify-content": "space-between",
                    "align-items": "center",
                    "margin-bottom": "1rem",
                    gap: "1rem",
                  }}
                >
                  <div style={{ display: "flex", "flex-direction": "column", gap: "0.5rem" }}>
                    <A class="btn" href="/agents" style={{ width: "fit-content" }}>
                      ← Back to Agents
                    </A>

                    <div
                      style={{
                        display: "flex",
                        "align-items": "center",
                        gap: "0.75rem",
                        "flex-wrap": "wrap",
                      }}
                    >
                      <h1 style={{ margin: 0 }}>{a().name}</h1>
                      <span class="badge badge-info">{a().llmProvider}</span>
                      <span class="badge badge-info">{a().llmModel}</span>
                    </div>
                  </div>
                </header>

                <nav
                  style={{
                    display: "flex",
                    gap: "1rem",
                    "border-bottom": "1px solid var(--border)",
                    "margin-bottom": "1.5rem",
                  }}
                >
                  <A
                    href={hrefForTab("overview")}
                    style={{
                      padding: "0.5rem 0.25rem",
                      "border-bottom":
                        tab() === "overview" ? "2px solid var(--primary)" : "2px solid transparent",
                      color: tab() === "overview" ? "var(--text)" : "var(--text-muted)",
                      "font-weight": tab() === "overview" ? 600 : 500,
                    }}
                  >
                    Overview
                  </A>
                  <A
                    href={hrefForTab("memories")}
                    style={{
                      padding: "0.5rem 0.25rem",
                      "border-bottom":
                        tab() === "memories" ? "2px solid var(--primary)" : "2px solid transparent",
                      color: tab() === "memories" ? "var(--text)" : "var(--text-muted)",
                      "font-weight": tab() === "memories" ? 600 : 500,
                    }}
                  >
                    Memories
                  </A>
                </nav>

                <Show
                  when={tab() === "overview"}
                  fallback={
                    <section class="card">
                      <h3>Memories</h3>
                      <p style={{ margin: 0 }}>Coming soon.</p>
                    </section>
                  }
                >
                  <AgentOverview agent={a()} />
                </Show>
              </div>
            )}
          </Show>
        </Show>
      </Show>
    </div>
  );
}
