import { createResource, For, Show, createSignal } from "solid-js";
import { agentsApi } from "../api";

type EditingAgent = {
  id?: string;
  name?: string;
  avatarUrl?: string | null;
  llmProvider?: string;
  llmModel?: string;
  systemPrompt?: string;
};

export default function Agents() {
  const [agents, { refetch }] = createResource(agentsApi.list);
  const [editingAgent, setEditingAgent] = createSignal<EditingAgent | null>(null);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    const formData = new FormData(e.target as HTMLFormElement);
    const data = Object.fromEntries(formData.entries());

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
        <button class="btn btn-primary" onClick={() => setEditingAgent({})}>
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
                value={editingAgent()?.llmProvider || "openai"}
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
                        <button class="btn" onClick={() => setEditingAgent(agent)}>
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
