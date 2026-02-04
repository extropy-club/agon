import { createResource, For, Show } from "solid-js";
import { discordApi, type DiscordGuild } from "../api";

const iconUrl = (g: DiscordGuild) =>
  g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=128` : null;

const placeholderColor = (guildId: string) => {
  // deterministic color from id
  let hash = 0;
  for (let i = 0; i < guildId.length; i++) hash = (hash * 31 + guildId.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 60% 45%)`;
};

export default function Guilds() {
  const [guilds, { refetch }] = createResource(discordApi.guilds);

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
        <h1>Discord Servers</h1>
        <button class="btn" onClick={() => refetch()}>
          Refresh
        </button>
      </header>

      <Show when={!guilds.loading} fallback={<p>Loading guilds...</p>}>
        <Show when={guilds.error}>
          <div class="card">
            <h3 style={{ marginTop: 0 }}>Failed to load guilds</h3>
            <pre style={{ "white-space": "pre-wrap" }}>{String(guilds.error)}</pre>
          </div>
        </Show>

        <div class="guilds-grid">
          <For each={guilds() ?? []}>
            {(guild) => (
              <div class="guild-card">
                <Show
                  when={iconUrl(guild)}
                  fallback={
                    <div
                      class="guild-icon guild-icon--placeholder"
                      style={{ "background-color": placeholderColor(guild.id) }}
                      aria-label={guild.name}
                    >
                      {(guild.name?.[0] ?? "?").toUpperCase()}
                    </div>
                  }
                >
                  {(src) => <img src={src()} alt={guild.name} class="guild-icon" loading="lazy" />}
                </Show>

                <span class="guild-name">{guild.name}</span>
                <Show when={guild.owner}>
                  <span class="badge badge-info" style={{ "margin-top": "0.5rem" }}>
                    Owner
                  </span>
                </Show>
              </div>
            )}
          </For>
        </div>

        <Show when={(guilds() ?? []).length === 0 && !guilds.error}>
          <p style={{ color: "var(--text-muted)" }}>No guilds found.</p>
        </Show>
      </Show>
    </div>
  );
}
