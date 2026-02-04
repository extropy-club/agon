import { Show, createResource } from "solid-js";
import { apiFetch } from "../api";

type AdminMeta =
  | { configured: false; missing: readonly string[] }
  | {
      configured: true;
      cloudflare: {
        accountId: string;
        workerService: string;
        queueName: string;
        d1Name: string;
        links: {
          queueMetrics: string;
          workerLogs: string;
          d1Console: string;
        };
      };
    };

export default function Metrics() {
  const [meta] = createResource(async () => (await apiFetch("/meta")) as AdminMeta);

  return (
    <div>
      <h1>Metrics & Observability</h1>
      <p style={{ "margin-bottom": "2rem", color: "var(--text-muted)" }}>
        Shortcuts to the Cloudflare dashboards you actually use.
      </p>

      <Show when={meta.loading}>
        <div class="card">Loading…</div>
      </Show>

      <Show when={meta.error}>
        <div class="card" style={{ "border-color": "#fecaca", "background-color": "#fef2f2" }}>
          Failed to load admin metadata: {String(meta.error)}
        </div>
      </Show>

      <Show when={meta() && !meta.loading && !meta.error}>
        {(() => {
          const m = meta();
          if (!m) return null;

          if (!m.configured) {
            return (
              <div class="card">
                <h3>Cloudflare links not configured</h3>
                <p style={{ color: "var(--text-muted)" }}>
                  Set <code>CF_ACCOUNT_ID</code> in the worker environment.
                </p>
                <pre
                  style={{
                    "margin-top": "1rem",
                    padding: "1rem",
                    "background-color": "#111827",
                    color: "#e5e7eb",
                    "border-radius": "0.5rem",
                    overflow: "auto",
                  }}
                >{`# .dev.vars\nCF_ACCOUNT_ID=...\nCF_WORKER_SERVICE=agon\nCF_QUEUE_NAME=arena-turns\nCF_D1_NAME=agon-db`}</pre>
              </div>
            );
          }

          const links = [
            {
              title: "Queue metrics",
              description: "Backlog size, throughput, and consumer errors.",
              url: m.cloudflare.links.queueMetrics,
            },
            {
              title: "Worker logs",
              description: "Structured logs with requestId + queue correlation.",
              url: m.cloudflare.links.workerLogs,
            },
            {
              title: "D1 console",
              description: "Query rooms, agents, and messages.",
              url: m.cloudflare.links.d1Console,
            },
          ] as const;

          return (
            <>
              <div
                style={{
                  display: "grid",
                  "grid-template-columns": "repeat(auto-fit, minmax(300px, 1fr))",
                  gap: "1.5rem",
                }}
              >
                {links.map((link) => (
                  <div class="card">
                    <h3>{link.title}</h3>
                    <p style={{ "margin-bottom": "1.5rem" }}>{link.description}</p>
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="btn btn-primary"
                      style={{ "text-decoration": "none" }}
                    >
                      Open in Cloudflare
                    </a>
                  </div>
                ))}
              </div>

              <div
                class="card"
                style={{
                  "margin-top": "2rem",
                  "background-color": "#fffbeb",
                  "border-color": "#fef3c7",
                }}
              >
                <h4 style={{ color: "#92400e", "margin-top": 0 }}>What to look for</h4>
                <ul style={{ color: "#92400e", "font-size": "0.9375rem" }}>
                  <li>
                    <strong>Queue backlog growing?</strong> Check worker logs for failures and queue
                    consumer errors.
                  </li>
                  <li>
                    <strong>Turn loop stuck?</strong> Compare D1 room state:
                    <code>currentTurnNumber</code> vs <code>lastEnqueuedTurnNumber</code>.
                  </li>
                  <li>
                    <strong>Discord issues?</strong> Filter logs by requestId / queueMessageId and
                    look for discord.sync / discord.webhook spans.
                  </li>
                </ul>
              </div>
            </>
          );
        })()}
      </Show>
    </div>
  );
}
