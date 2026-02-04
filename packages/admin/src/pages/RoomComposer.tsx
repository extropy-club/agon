import { createResource, For, Show, createSignal } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { agentsApi, roomsApi } from "../api";

export default function RoomComposer() {
  const navigate = useNavigate();

  const [agents] = createResource(agentsApi.list);

  const [selectedAgentIds, setSelectedAgentIds] = createSignal<string[]>([]);
  const [title, setTitle] = createSignal("");
  const [topic, setTopic] = createSignal("");
  const [parentChannelId, setParentChannelId] = createSignal("");
  const [threadId, setThreadId] = createSignal("");
  const [threadName, setThreadName] = createSignal("Agon Room");
  const [autoArchiveDurationMinutes, setAutoArchiveDurationMinutes] = createSignal("1440");
  const [audienceSlotDurationSeconds, setAudienceSlotDurationSeconds] = createSignal("30");
  const [audienceTokenLimit, setAudienceTokenLimit] = createSignal("4096");
  const [roomTokenLimit, setRoomTokenLimit] = createSignal("32000");

  const toggleAgent = (id: string) => {
    if (selectedAgentIds().includes(id)) {
      setSelectedAgentIds(selectedAgentIds().filter((a) => a !== id));
    } else {
      setSelectedAgentIds([...selectedAgentIds(), id]);
    }
  };

  const handleSubmit = async (e: Event) => {
    e.preventDefault();

    const result = await roomsApi.create({
      title: title(),
      topic: topic(),
      parentChannelId: parentChannelId(),
      agentIds: selectedAgentIds(),
      autoArchiveDurationMinutes: Number(autoArchiveDurationMinutes()),
      audienceSlotDurationSeconds: Number(audienceSlotDurationSeconds()),
      audienceTokenLimit: Number(audienceTokenLimit()),
      roomTokenLimit: Number(roomTokenLimit()),
      ...(threadId().trim().length > 0 ? { threadId: threadId().trim() } : {}),
      ...(() => {
        const tn = threadName().trim();
        return threadId().trim().length === 0 && tn.length > 0 ? { threadName: tn } : {};
      })(),
    });

    navigate(`/rooms/${result.roomId}`);
  };

  return (
    <div>
      <h1>Create Room</h1>

      <form class="card" onSubmit={handleSubmit}>
        <div class="form-group">
          <label>Title</label>
          <input
            class="form-control"
            value={title()}
            onInput={(e) => setTitle(e.currentTarget.value)}
            required
            placeholder="Room Title"
          />
        </div>

        <div class="form-group">
          <label>Topic</label>
          <textarea
            class="form-control"
            value={topic()}
            onInput={(e) => setTopic(e.currentTarget.value)}
            required
            placeholder="e.g. The ethics of AI"
            rows={4}
          />
        </div>

        <div class="form-group">
          <label>Parent Discord Channel ID</label>
          <input
            class="form-control"
            value={parentChannelId()}
            onInput={(e) => setParentChannelId(e.currentTarget.value)}
            required
          />
          <div
            style={{ "font-size": "0.875rem", color: "var(--text-muted)", "margin-top": "0.5rem" }}
          >
            Agon will reuse (or create) a webhook for this channel and create a public thread.
          </div>
        </div>

        <div class="form-group">
          <label>Bind to Existing Thread ID (optional)</label>
          <input
            class="form-control"
            value={threadId()}
            onInput={(e) => setThreadId(e.currentTarget.value)}
            placeholder="If provided, Agon will not create a new thread"
          />
        </div>

        <Show when={threadId().trim().length === 0}>
          <div class="form-group">
            <label>Thread Name</label>
            <input
              class="form-control"
              value={threadName()}
              onInput={(e) => setThreadName(e.currentTarget.value)}
            />
          </div>
        </Show>

        <div class="form-group">
          <label>Auto-Archive Duration</label>
          <select
            class="form-control"
            value={autoArchiveDurationMinutes()}
            onChange={(e) => setAutoArchiveDurationMinutes(e.currentTarget.value)}
          >
            <option value="60">60 min</option>
            <option value="1440">1 day</option>
            <option value="4320">3 days</option>
            <option value="10080">1 week</option>
          </select>
        </div>

        <div class="form-group">
          <label>Audience Slot Duration (seconds)</label>
          <input
            type="number"
            class="form-control"
            value={audienceSlotDurationSeconds()}
            onInput={(e) => setAudienceSlotDurationSeconds(e.currentTarget.value)}
            min="0"
          />
          <div
            style={{ "font-size": "0.875rem", color: "var(--text-muted)", "margin-top": "0.5rem" }}
          >
            How long audience can speak per turn. 0 = manual only.
          </div>
        </div>

        <div class="form-group">
          <label>Audience Token Limit</label>
          <input
            type="number"
            class="form-control"
            value={audienceTokenLimit()}
            onInput={(e) => setAudienceTokenLimit(e.currentTarget.value)}
            min="1"
          />
          <div
            style={{ "font-size": "0.875rem", color: "var(--text-muted)", "margin-top": "0.5rem" }}
          >
            Max tokens per audience message batch.
          </div>
        </div>

        <div class="form-group">
          <label>Room Token Limit</label>
          <input
            type="number"
            class="form-control"
            value={roomTokenLimit()}
            onInput={(e) => setRoomTokenLimit(e.currentTarget.value)}
            min="1"
          />
          <div
            style={{ "font-size": "0.875rem", color: "var(--text-muted)", "margin-top": "0.5rem" }}
          >
            Max tokens for room context.
          </div>
        </div>

        <div class="form-group">
          <label>Assign Agents (click to select / order)</label>
          <Show when={!agents.loading} fallback={<p>Loading agents...</p>}>
            <div
              style={{
                display: "grid",
                "grid-template-columns": "repeat(auto-fill, minmax(200px, 1fr))",
                gap: "1rem",
                "margin-top": "1rem",
              }}
            >
              <For each={agents()}>
                {(agent) => {
                  const isSelected = () => selectedAgentIds().includes(agent.id);
                  const order = () => selectedAgentIds().indexOf(agent.id) + 1;

                  return (
                    <div
                      onClick={() => toggleAgent(agent.id)}
                      style={{
                        padding: "1rem",
                        border: "1px solid",
                        "border-color": isSelected() ? "var(--primary)" : "var(--border)",
                        "background-color": isSelected() ? "#eff6ff" : "white",
                        cursor: "pointer",
                        "border-radius": "0.5rem",
                        position: "relative",
                      }}
                    >
                      <Show when={isSelected()}>
                        <div
                          style={{
                            position: "absolute",
                            top: "0.25rem",
                            right: "0.25rem",
                            background: "var(--primary)",
                            color: "white",
                            width: "20px",
                            height: "20px",
                            "border-radius": "50%",
                            display: "flex",
                            "align-items": "center",
                            "justify-content": "center",
                            "font-size": "0.75rem",
                          }}
                        >
                          {order()}
                        </div>
                      </Show>
                      <strong>{agent.name}</strong>
                      <div style={{ "font-size": "0.75rem", color: "var(--text-muted)" }}>
                        {agent.llmProvider} · {agent.llmModel}
                      </div>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
        </div>

        <div style={{ "margin-top": "2rem" }}>
          <button type="submit" class="btn btn-primary" disabled={selectedAgentIds().length === 0}>
            Create & Enqueue
          </button>
        </div>
      </form>
    </div>
  );
}
