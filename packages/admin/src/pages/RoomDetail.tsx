import { createResource, For, Show } from "solid-js";
import { useParams } from "@solidjs/router";
import { roomsApi } from "../api";

export default function RoomDetail() {
  const params = useParams();

  const [detail, { refetch }] = createResource(
    () => params.id,
    (id) => roomsApi.get(id),
  );

  const toggleStatus = async () => {
    const d = detail();
    if (!d) return;

    if (d.room.status === "active") {
      await roomsApi.pause(d.room.id);
    } else {
      await roomsApi.resume(d.room.id);
    }

    refetch();
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
            <div>
              <button class="btn" onClick={toggleStatus}>
                {d().room.status === "active" ? "Pause" : "Resume"}
              </button>
            </div>
          </div>

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
