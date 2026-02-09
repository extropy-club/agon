import { createMemo, createResource, For, Show, createSignal, onMount } from "solid-js";
import { useNavigate, useParams } from "@solidjs/router";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { SolidMarkdown, type Components } from "solid-markdown";
import remarkMath from "remark-math";
import katex from "katex";
import "katex/dist/katex.min.css";
import { roomsApi, type Message } from "../api";

// ---------------------------------------------------------------------------
// Math rendering component
// ---------------------------------------------------------------------------

function Math(props: { value: string; inline?: boolean }) {
  const [containerRef, setContainerRef] = createSignal<
    HTMLSpanElement | HTMLDivElement | undefined
  >();

  onMount(() => {
    const el = containerRef();
    if (el) {
      katex.render(props.value, el, {
        throwOnError: false,
        displayMode: !props.inline,
      });
    }
  });

  return props.inline ? (
    <span ref={setContainerRef} style={{ display: "inline-block" }} />
  ) : (
    <div ref={setContainerRef} style={{ overflow: "auto", margin: "0.75rem 0" }} />
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve a human-readable author name for a message. */
const authorDisplay = (msg: Message): string => {
  if (msg.authorType === "agent") {
    return msg.authorName ?? msg.authorAgentId ?? "agent";
  }
  return msg.authorName ?? msg.authorType;
};

// ---------------------------------------------------------------------------
// Export helpers
// ---------------------------------------------------------------------------

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
};

const exportJson = (roomId: number, messages: readonly Message[]) => {
  const data = messages.map((m) => ({
    id: m.id,
    roomId: m.roomId,
    authorType: m.authorType,
    authorAgentId: m.authorAgentId,
    authorName: m.authorName,
    content: m.content,
    thinkingText: m.thinkingText,
    inputTokens: m.inputTokens,
    outputTokens: m.outputTokens,
    createdAtMs: m.createdAtMs,
    createdAt: new Date(m.createdAtMs).toISOString(),
  }));

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  downloadBlob(blob, `room-${roomId}-messages.json`);
};

const exportMarkdown = (roomId: number, messages: readonly Message[]) => {
  const lines: string[] = [];

  for (const msg of messages) {
    const name = authorDisplay(msg);
    lines.push(`[name] ${name}`);

    if (msg.thinkingText) {
      lines.push(`[thinking] ${msg.thinkingText}`);
    }

    lines.push(`[message] ${msg.content}`);
    lines.push("");
  }

  const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
  downloadBlob(blob, `room-${roomId}-messages.md`);
};

// ---------------------------------------------------------------------------
// MessageItem component (accordion)
// ---------------------------------------------------------------------------

function MessageItem(props: { msg: Message; onResize?: () => void }) {
  const [expanded, setExpanded] = createSignal(false);

  const toggle = () => {
    setExpanded(!expanded());
    // Notify virtualizer of height change after DOM update
    requestAnimationFrame(() => props.onResize?.());
  };

  // Re-measure after markdown renders
  onMount(() => {
    requestAnimationFrame(() => props.onResize?.());
  });

  return (
    <div
      style={{
        "border-bottom": "1px solid var(--border)",
        "padding-bottom": "0.5rem",
        "padding-top": "0.5rem",
      }}
    >
      {/* Author + timestamp header */}
      <div
        style={{
          "font-size": "0.875rem",
          color: "var(--text-muted)",
          "margin-bottom": "0.25rem",
          display: "flex",
          "align-items": "center",
          gap: "0.5rem",
        }}
      >
        <strong>{authorDisplay(props.msg)}</strong>
        <span>•</span>
        <span>{new Date(props.msg.createdAtMs).toLocaleString()}</span>
        <Show when={props.msg.inputTokens != null || props.msg.outputTokens != null}>
          <span style={{ "font-size": "0.75rem", opacity: 0.7 }}>
            ({props.msg.inputTokens ?? "?"}→{props.msg.outputTokens ?? "?"} tok)
          </span>
        </Show>
      </div>

      {/* Thinking accordion (only shown when thinking text exists) */}
      <Show when={props.msg.thinkingText}>
        <div style={{ "margin-bottom": "0.5rem" }}>
          <button
            onClick={toggle}
            style={{
              background: "none",
              border: "1px solid var(--border)",
              "border-radius": "0.25rem",
              padding: "0.25rem 0.5rem",
              cursor: "pointer",
              "font-size": "0.75rem",
              color: "var(--text-muted)",
              display: "flex",
              "align-items": "center",
              gap: "0.25rem",
            }}
          >
            <span style={{ "font-size": "0.6rem", "line-height": 1 }}>
              {expanded() ? "▼" : "▶"}
            </span>
            Thinking
          </button>

          <Show when={expanded()}>
            <div
              style={{
                "margin-top": "0.5rem",
                padding: "0.75rem",
                "background-color": "#f8fafc",
                "border-left": "3px solid var(--primary)",
                "border-radius": "0 0.25rem 0.25rem 0",
                "font-size": "0.85rem",
                "white-space": "pre-wrap",
                color: "var(--text-muted)",
                "max-height": "400px",
                overflow: "auto",
              }}
            >
              {props.msg.thinkingText}
            </div>
          </Show>
        </div>
      </Show>

      {/* Message content */}
      <div class="markdown-content">
        <SolidMarkdown
          children={props.msg.content}
          remarkPlugins={[remarkMath]}
          components={
            {
              math: (p: { value: string }) => <Math value={p.value} inline={false} />,
              inlineMath: (p: { value: string }) => <Math value={p.value} inline={true} />,
            } as Components
          }
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// VirtualTurnTimeline component
// ---------------------------------------------------------------------------

function VirtualTurnTimeline(props: {
  eventsByTurn: {
    turnNumber: number;
    events: { createdAtMs: number; phase: string; status: string; dataJson?: string | null }[];
  }[];
  onRefresh: () => void;
}) {
  // eslint-disable-next-line no-unassigned-vars -- assigned via JSX ref
  let scrollRef!: HTMLDivElement;

  const virtualizer = createVirtualizer({
    get count() {
      return props.eventsByTurn.length;
    },
    getScrollElement: () => scrollRef,
    estimateSize: () => 150,
    overscan: 3,
  });

  return (
    <div>
      <div
        style={{
          display: "flex",
          "justify-content": "space-between",
          "align-items": "center",
          "margin-bottom": "0.75rem",
        }}
      >
        <h3 style={{ margin: 0 }}>Turn Timeline</h3>
        <button class="btn" onClick={() => props.onRefresh()}>
          Refresh
        </button>
      </div>

      <div
        ref={scrollRef}
        style={{
          height: "600px",
          overflow: "auto",
          position: "relative",
          "-webkit-overflow-scrolling": "touch",
        }}
      >
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: "100%",
            position: "relative",
          }}
        >
          <For each={virtualizer.getVirtualItems()}>
            {(vItem) => {
              const turn = () => props.eventsByTurn[vItem.index];
              return (
                <div
                  data-index={vItem.index}
                  ref={(el) => {
                    queueMicrotask(() => virtualizer.measureElement(el));
                  }}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${vItem.start}px)`,
                  }}
                >
                  <Show when={turn()}>
                    {(t) => (
                      <div style={{ "margin-bottom": "1.5rem", padding: "0 0.5rem" }}>
                        <div style={{ "font-weight": 600, "margin-bottom": "0.5rem" }}>
                          Turn {t().turnNumber}
                        </div>

                        <div
                          style={{
                            display: "flex",
                            "flex-direction": "column",
                            gap: "0.35rem",
                          }}
                        >
                          <For each={t().events}>
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
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// VirtualMessageList component
// ---------------------------------------------------------------------------

function VirtualMessageList(props: { messages: readonly Message[]; roomId: number }) {
  // eslint-disable-next-line no-unassigned-vars -- assigned via JSX ref
  let scrollRef!: HTMLDivElement;

  // Messages are returned newest-first from API; reverse for chronological display
  const chronological = createMemo(() => [...props.messages].reverse());

  const virtualizer = createVirtualizer({
    get count() {
      return chronological().length;
    },
    getScrollElement: () => scrollRef,
    estimateSize: () => 120,
    overscan: 5,
  });

  // Scroll to bottom on initial load
  onMount(() => {
    requestAnimationFrame(() => {
      if (scrollRef) {
        scrollRef.scrollTop = scrollRef.scrollHeight;
      }
    });
  });

  return (
    <div>
      <div
        style={{
          display: "flex",
          "justify-content": "space-between",
          "align-items": "center",
          "margin-bottom": "0.75rem",
        }}
      >
        <h3 style={{ margin: 0 }}>Recent Messages</h3>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button
            class="btn"
            style={{ "font-size": "0.8rem", padding: "0.25rem 0.75rem" }}
            onClick={() => exportJson(props.roomId, chronological())}
          >
            Export JSON
          </button>
          <button
            class="btn"
            style={{ "font-size": "0.8rem", padding: "0.25rem 0.75rem" }}
            onClick={() => exportMarkdown(props.roomId, chronological())}
          >
            Export Markdown
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        style={{
          height: "600px",
          overflow: "auto",
          position: "relative",
          "-webkit-overflow-scrolling": "touch",
        }}
      >
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: "100%",
            position: "relative",
          }}
        >
          <For each={virtualizer.getVirtualItems()}>
            {(vItem) => {
              const msg = () => chronological()[vItem.index];
              let rowRef: HTMLDivElement | undefined;
              return (
                <div
                  data-index={vItem.index}
                  ref={(el) => {
                    rowRef = el;
                    queueMicrotask(() => virtualizer.measureElement(el));
                  }}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${vItem.start}px)`,
                  }}
                >
                  <Show when={msg()}>
                    {(m) => (
                      <MessageItem
                        msg={m()}
                        onResize={() => {
                          if (rowRef) virtualizer.measureElement(rowRef);
                        }}
                      />
                    )}
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RoomDetail page
// ---------------------------------------------------------------------------

export default function RoomDetail() {
  const params = useParams();
  const navigate = useNavigate();

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

    if (d.room.status !== "paused") {
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

  const deleteRoom = async () => {
    const d = detail();
    if (!d) return;

    if (!confirm("Delete this room and all its data?")) return;

    await roomsApi.delete(d.room.id);
    navigate("/rooms");
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
            <h1>Room: {d().room.title || d().room.topic}</h1>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button class="btn" onClick={toggleStatus}>
                {d().room.status !== "paused" ? "Pause" : "Resume"}
              </button>
              <Show when={d().room.status === "active"}>
                <button class="btn btn-primary" onClick={kick} disabled={kicking()}>
                  {kicking() ? "Kicking…" : "Kick next turn"}
                </button>
              </Show>
              <button class="btn btn-danger" onClick={deleteRoom}>
                Delete
              </button>
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

          <div style={{ display: "grid", "grid-template-columns": "1fr 1fr", gap: "2rem" }}>
            {/* LEFT COLUMN - Recent Messages */}
            <section class="card">
              <VirtualMessageList messages={d().recentMessages} roomId={d().room.id} />
            </section>

            {/* RIGHT COLUMN - Turn Timeline */}
            <section class="card">
              <Show when={events()} fallback={<p>Loading events...</p>}>
                {(evs) => (
                  <Show when={evs().length > 0} fallback={<p>No turn events yet.</p>}>
                    <VirtualTurnTimeline eventsByTurn={eventsByTurn()} onRefresh={refetchEvents} />
                  </Show>
                )}
              </Show>
            </section>
          </div>

          {/* Details and Agents row */}
          <div
            style={{
              display: "grid",
              "grid-template-columns": "2fr 1fr",
              gap: "2rem",
              "margin-top": "2rem",
            }}
          >
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
      )}
    </Show>
  );
}
