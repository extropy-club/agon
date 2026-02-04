import { createMemo, createResource, For, Show, createSignal } from "solid-js";
import { useParams } from "@solidjs/router";
import { roomsApi } from "../api";

export default function RoomDetail() {
  const params = useParams();

  const [detail, { refetch }] = createResource(
    () => params.id,
    (id) => roomsApi.get(id),
  );

  const [events, { refetch: refetchEvents }] = createResource(
    () => params.id,
    (id) => roomsApi.events(id),
  );

  const eventsByTurn = createMemo(() => {
    const list = events() ?? [];
    const map = new Map<number, (typeof list)[number][]>();

    for (const e of list) {
      const arr = map.get(e.turnNumber);
      if (arr) arr.push(e);
      else map.set(e.turnNumber, [e]);
    }

    return Array.from(map.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([turnNumber, events]) => ({ turnNumber, events }));
  });

  const [kickError, setKickError] = createSignal<string | null>(null);
  const [kicking, setKicking] = createSignal(false);

  const toggleStatus = async () => {
    const d = detail();
    if (!d) return;

    if (d.room.status === "active") {
      await roomsApi.pause(d.room.id);
    } else {
      await roomsApi.resume(d.room.id);
    }

    refetch();
    refetchEvents();
  };

  const kick = async () => {
    const d = detail();
    if (!d) return;

    setKickError(null);
    setKicking(true);
    try {
      await roomsApi.kick(d.room.id);
      refetch();
      refetchEvents();
    } catch (e) {
      setKickError(String(e instanceof Error ? e.message : e));
    } finally {
      setKicking(false);
    }
  };

  return (
    <Show when={detail()} fallback={<p>Loading room...</p>}>
      {(d) => (
        <div>
          <div
            style={{
              display: "flex",
              "justify-content": "space-between",
              "align-items": "center",
              "margin-bottom": "2rem",
            }}
          >
            <h1>Room: {d().room.topic}</h1>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button class="btn" onClick={toggleStatus}>
                {d().room.status === "active" ? "Pause" : "Resume"}
              </button>
              <Show when={d().room.status === "active"}>
                <button class="btn btn-primary" onClick={kick} disabled={kicking()}>
                  {kicking() ? "Kicking…" : "Kick next turn"}
                </button>
              </Show>
            </div>
          </div>

          <Show when={kickError()}>
            <div
              class="card"
              style={{
                "margin-bottom": "1rem",
                "border-color": "#fecaca",
                "background-color": "#fef2f2",
              }}
            >
              {kickError()}
            </div>
          </Show>

          <div style={{ display: "grid", "grid-template-columns": "2fr 1fr", gap: "2rem" }}>
            <div>
              <section class="card">
                <h3>Details</h3>
                <p>
                  <strong>ID:</strong> {d().room.id}
                </p>
                <p>
                  <strong>Status:</strong>{" "}
                  <span class={`badge badge-${d().room.status}`}>{d().room.status}</span>
                </p>
                <p>
                  <strong>Parent Channel ID:</strong> {d().room.parentChannelId}
                </p>
                <p>
                  <strong>Thread ID:</strong> {d().room.threadId}
                </p>
                <p>
                  <strong>Current Turn:</strong> {d().room.currentTurnNumber} (Agent:{" "}
                  {d().room.currentTurnAgentId})
                </p>
                <p>
                  <strong>Last Enqueued Turn:</strong> {d().room.lastEnqueuedTurnNumber}
                </p>
              </section>

              <section class="card">
                <h3>Recent Messages</h3>
                <div style={{ display: "flex", "flex-direction": "column", gap: "1rem" }}>
                  <For each={d().recentMessages}>
                    {(msg) => (
                      <div
                        style={{
                          "border-bottom": "1px solid var(--border)",
                          "padding-bottom": "0.5rem",
                        }}
                      >
                        <div
                          style={{
                            "font-size": "0.875rem",
                            color: "var(--text-muted)",
                            "margin-bottom": "0.25rem",
                          }}
                        >
                          <strong>
                            {msg.authorType === "agent"
                              ? (msg.authorAgentId ?? "agent")
                              : msg.authorType}
                          </strong>{" "}
                          • {new Date(msg.createdAtMs).toLocaleString()}
                        </div>
                        <div style={{ "white-space": "pre-wrap" }}>{msg.content}</div>
                      </div>
                    )}
                  </For>
                </div>
              </section>

              <section class="card">
                <div
                  style={{
                    display: "flex",
                    "justify-content": "space-between",
                    "align-items": "center",
                    gap: "1rem",
                  }}
                >
                  <h3>Turn Timeline</h3>
                  <button class="btn" onClick={() => refetchEvents()}>
                    Refresh
                  </button>
                </div>

                <Show when={events()} fallback={<p>Loading events...</p>}>
                  {(evs) => (
                    <Show when={evs().length > 0} fallback={<p>No turn events yet.</p>}>
                      <For each={eventsByTurn()}>
                        {(t) => (
                          <div style={{ "margin-bottom": "1.5rem" }}>
                            <div style={{ "font-weight": 600, "margin-bottom": "0.5rem" }}>
                              Turn {t.turnNumber}
                            </div>

                            <div
                              style={{
                                display: "flex",
                                "flex-direction": "column",
                                gap: "0.35rem",
                              }}
                            >
                              <For each={t.events}>
                                {(e) => (
                                  <div>
                                    <div
                                      style={{
                                        display: "flex",
                                        gap: "0.5rem",
                                        "align-items": "center",
                                        "flex-wrap": "wrap",
                                      }}
                                    >
                                      <span
                                        style={{
                                          "font-size": "0.75rem",
                                          color: "var(--text-muted)",
                                          "min-width": "160px",
                                        }}
                                      >
                                        {new Date(e.createdAtMs).toLocaleString()}
                                      </span>
                                      <span style={{ "font-family": "monospace" }}>{e.phase}</span>
                                      <span class={`badge badge-${e.status}`}>{e.status}</span>
                                    </div>
                                    <Show when={e.dataJson}>
                                      <div
                                        style={{
                                          "margin-left": "1.25rem",
                                          "margin-top": "0.25rem",
                                          "font-size": "0.75rem",
                                          color: "var(--text-muted)",
                                          "white-space": "pre-wrap",
                                        }}
                                      >
                                        {e.dataJson}
                                      </div>
                                    </Show>
                                  </div>
                                )}
                              </For>
                            </div>
                          </div>
                        )}
                      </For>
                    </Show>
                  )}
                </Show>
              </section>
            </div>

            <div>
              <section class="card">
                <h3>Agents</h3>
                <For each={d().participants}>
                  {(p) => (
                    <div
                      style={{
                        display: "flex",
                        "align-items": "center",
                        gap: "0.5rem",
                        "margin-bottom": "0.5rem",
                      }}
                    >
                      <div
                        style={{
                          width: "32px",
                          height: "32px",
                          "border-radius": "50%",
                          "background-color": "#e2e8f0",
                          display: "flex",
                          "align-items": "center",
                          "justify-content": "center",
                          "font-size": "0.75rem",
                        }}
                      >
                        {p.agent.name[0]}
                      </div>
                      <span>{p.agent.name}</span>
                      <span style={{ "font-size": "0.75rem", color: "var(--text-muted)" }}>
                        (Order: {p.turnOrder})
                      </span>
                    </div>
                  )}
                </For>
              </section>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}
