import { createResource, For, Show, createSignal } from "solid-js";
import { agentsApi, type Agent } from "../api";

type EditingAgent = Partial<Agent>;

type Provider = Agent["llmProvider"];

export default function Agents() {
  const [agents, { refetch }] = createResource(agentsApi.list);
  const [editingAgent, setEditingAgent] = createSignal<EditingAgent | null>(null);
  const [selectedProvider, setSelectedProvider] = createSignal<Provider>("openai");

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    const formData = new FormData(e.target as HTMLFormElement);

    const data: Record<string, unknown> = {};
    for (const [key, value] of formData.entries()) {
      if (typeof value !== "string") continue;

      if (key === "maxTokens" || key === "thinkingBudgetTokens") {
        const s = value.trim();
        if (s.length === 0) {
          data[key] = null;
          continue;
        }
        const n = Number(s);
        if (Number.isFinite(n)) data[key] = n;
        continue;
      }

      if (key === "thinkingLevel") {
        const s = value.trim();
        data[key] = s.length === 0 ? null : s;
        continue;
      }

      // Keep empty strings for nullable text fields so the server can clear them.
      if (key === "avatarUrl" || key === "temperature") {
        data[key] = value;
        continue;
      }

      data[key] = value;
    }

    const id = editingAgent()?.id;
    if (id) {
      await agentsApi.update(id, data);
    } else {
      await agentsApi.create(data);
    }
    setEditingAgent(null);
    refetch();
  };

  const handleDelete = async (id: string) => {
    if (!confirm(`Delete agent '${id}'?`)) return;
    await agentsApi.remove(id);
    refetch();
  };

  const startNew = () => {
    setSelectedProvider("openai");
    setEditingAgent({ llmProvider: "openai", llmModel: "gpt-4o-mini" });
  };

  const startEdit = (agent: Agent) => {
    setSelectedProvider(agent.llmProvider);
    setEditingAgent(agent);
  };

  return (
    <div>
      <header
        style={{
          display: "flex",
          "justify-content": "space-between",
          "align-items": "center",
          "margin-bottom": "2rem",
        }}
      >
        <h1>Agents</h1>
        <button class="btn btn-primary" onClick={startNew}>
          Add Agent
        </button>
      </header>

      <Show when={editingAgent()}>
        <div class="card">
          <h3>{editingAgent()?.id ? "Edit Agent" : "New Agent"}</h3>
          <form onSubmit={handleSubmit}>
            <div class="form-group">
              <label>ID</label>
              <input
                class="form-control"
                name="id"
                value={editingAgent()?.id || ""}
                required
                disabled={!!editingAgent()?.id}
              />
            </div>
            <div class="form-group">
              <label>Name</label>
              <input class="form-control" name="name" value={editingAgent()?.name || ""} required />
            </div>
            <div class="form-group">
              <label>Avatar URL</label>
              <input
                class="form-control"
                name="avatarUrl"
                value={editingAgent()?.avatarUrl || ""}
              />
            </div>
            <div class="form-group">
              <label>LLM Provider</label>
              <select
                class="form-control"
                name="llmProvider"
                value={selectedProvider()}
                onChange={(e) =>
                  setSelectedProvider((e.target as HTMLSelectElement).value as Provider)
                }
              >
                <option value="openai">OpenAI</option>
                <option value="openrouter">OpenRouter</option>
                <option value="anthropic">Anthropic</option>
                <option value="gemini">Gemini</option>
              </select>
            </div>
            <div class="form-group">
              <label>LLM Model</label>
              <input
                class="form-control"
                name="llmModel"
                value={editingAgent()?.llmModel || "gpt-4o-mini"}
                required
              />
            </div>

            <div class="form-group">
              <label>Temperature</label>
              <input
                class="form-control"
                name="temperature"
                type="number"
                min="0"
                max="2"
                step="0.1"
                value={editingAgent()?.temperature ?? ""}
              />
            </div>

            <div class="form-group">
              <label>Max Tokens</label>
              <input
                class="form-control"
                name="maxTokens"
                type="number"
                min="1"
                step="1"
                value={editingAgent()?.maxTokens ?? ""}
              />
            </div>

            <Show when={selectedProvider() === "openai" || selectedProvider() === "anthropic"}>
              <div class="form-group">
                <label>Thinking Level</label>
                <select
                  class="form-control"
                  name="thinkingLevel"
                  value={editingAgent()?.thinkingLevel ?? ""}
                >
                  <option value="">Default</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </div>
            </Show>

            <Show when={selectedProvider() === "anthropic"}>
              <div class="form-group">
                <label>Thinking Budget Tokens</label>
                <input
                  class="form-control"
                  name="thinkingBudgetTokens"
                  type="number"
                  min="1"
                  step="1"
                  value={editingAgent()?.thinkingBudgetTokens ?? ""}
                />
              </div>
            </Show>

            <div class="form-group">
              <label>System Prompt</label>
              <textarea class="form-control" name="systemPrompt" rows="5" required>
                {editingAgent()?.systemPrompt || ""}
              </textarea>
            </div>
            <div style={{ display: "flex", gap: "1rem" }}>
              <button type="submit" class="btn btn-primary">
                Save
              </button>
              <button type="button" class="btn" onClick={() => setEditingAgent(null)}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      </Show>

      <div class="card">
        <Show when={!agents.loading} fallback={<p>Loading agents...</p>}>
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Provider</th>
                <th>Model</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              <For each={agents()}>
                {(agent) => (
                  <tr>
                    <td>{agent.id}</td>
                    <td>{agent.name}</td>
                    <td>{agent.llmProvider}</td>
                    <td>{agent.llmModel}</td>
                    <td>
                      <div style={{ display: "flex", gap: "0.5rem" }}>
                        <button class="btn" onClick={() => startEdit(agent)}>
                          Edit
                        </button>
                        <button class="btn" onClick={() => handleDelete(agent.id)}>
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </Show>
      </div>
    </div>
  );
}
