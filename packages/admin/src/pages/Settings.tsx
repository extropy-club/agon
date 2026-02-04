import { createResource, createSignal, For, Show } from "solid-js";
import { settingsApi, type AdminSetting } from "../api";

const badgeLabel = (s: AdminSetting) => {
  switch (s.source) {
    case "db":
      return "Configured (DB)";
    case "db_invalid":
      return "DB (decrypt failed)";
    case "env":
      return "Configured (env)";
    default:
      return "Not set";
  }
};

const badgeClass = (s: AdminSetting) => {
  switch (s.source) {
    case "db":
      return "badge-config-db";
    case "db_invalid":
      return "badge-config-none";
    case "env":
      return "badge-config-env";
    default:
      return "badge-config-none";
  }
};

export default function Settings() {
  const [settings, { refetch }] = createResource(settingsApi.list);

  const [editingKey, setEditingKey] = createSignal<string | null>(null);
  const [draftValue, setDraftValue] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  const startEdit = (key: string) => {
    setEditingKey(key);
    setDraftValue("");
  };

  const save = async (key: string) => {
    const value = draftValue().trim();
    if (!value) return;

    setBusy(true);
    try {
      await settingsApi.set(key, value);
      setEditingKey(null);
      setDraftValue("");
      refetch();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (key: string) => {
    if (!confirm(`Delete '${key}' from DB? (env fallback will still work)`)) return;

    setBusy(true);
    try {
      await settingsApi.remove(key);
      if (editingKey() === key) {
        setEditingKey(null);
        setDraftValue("");
      }
      refetch();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <header style={{ display: "flex", "justify-content": "space-between" }}>
        <h1>Settings</h1>
        <button class="btn" onClick={() => refetch()} disabled={busy()}>
          Refresh
        </button>
      </header>

      <Show when={!settings.loading} fallback={<p>Loading settings...</p>}>
        <For each={settings() ?? []}>
          {(s) => (
            <div class="card">
              <div
                style={{
                  display: "flex",
                  "justify-content": "space-between",
                  "align-items": "center",
                  gap: "1rem",
                }}
              >
                <div>
                  <div style={{ display: "flex", gap: "0.75rem", "align-items": "center" }}>
                    <h3 style={{ margin: 0 }}>{s.label}</h3>
                    <span class={`badge ${badgeClass(s)}`}>{badgeLabel(s)}</span>
                  </div>
                  <div style={{ color: "var(--text-muted)", "margin-top": "0.25rem" }}>
                    <code>{s.key}</code>
                  </div>

                  <Show when={s.maskedValue}>
                    {(mv) => (
                      <div style={{ "margin-top": "0.5rem" }}>
                        <strong>Value:</strong> <code>{mv()}</code>
                      </div>
                    )}
                  </Show>

                  <Show when={s.updatedAtMs !== null}>
                    <div style={{ "margin-top": "0.25rem", color: "var(--text-muted)" }}>
                      Updated: {new Date(s.updatedAtMs as number).toLocaleString()}
                    </div>
                  </Show>
                </div>

                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <button class="btn" onClick={() => startEdit(s.key)} disabled={busy()}>
                    Edit
                  </button>
                  <button class="btn" onClick={() => remove(s.key)} disabled={busy()}>
                    Delete
                  </button>
                </div>
              </div>

              <Show when={editingKey() === s.key}>
                <div style={{ "margin-top": "1rem" }}>
                  <div class="form-group">
                    <label>New value</label>
                    <input
                      class="form-control"
                      type={s.sensitive ? "password" : "text"}
                      value={draftValue()}
                      onInput={(e) => setDraftValue(e.currentTarget.value)}
                      placeholder={s.sensitive ? "••••••••" : "value"}
                      autocomplete="off"
                    />
                    <div style={{ color: "var(--text-muted)", "margin-top": "0.25rem" }}>
                      Saved values are encrypted at rest (AES-256-GCM).
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: "0.75rem" }}>
                    <button
                      class="btn btn-primary"
                      onClick={() => save(s.key)}
                      disabled={busy() || draftValue().trim().length === 0}
                    >
                      Save
                    </button>
                    <button class="btn" onClick={() => setEditingKey(null)} disabled={busy()}>
                      Cancel
                    </button>
                  </div>
                </div>
              </Show>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}
