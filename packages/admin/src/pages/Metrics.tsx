import { Show, createSignal } from "solid-js";

const load = (key: string, fallback: string) => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};

const save = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
};

export default function Metrics() {
  const [accountId, setAccountId] = createSignal(load("agon.cf.accountId", ""));
  const [queueName, setQueueName] = createSignal(load("agon.cf.queueName", "arena-turns"));
  const [workerService, setWorkerService] = createSignal(load("agon.cf.workerService", "agon"));
  const [d1Name, setD1Name] = createSignal(load("agon.cf.d1Name", "agon-db"));

  const links = () => {
    const acc = accountId().trim();
    if (!acc) return [] as const;

    return [
      {
        title: "Queue metrics",
        description: "Backlog size, throughput, and consumer errors for the debate queue.",
        url: `https://dash.cloudflare.com/${acc}/workers/queues/view/${encodeURIComponent(queueName().trim())}`,
      },
      {
        title: "Worker logs",
        description: "Structured logs (Effect JSON logger) with requestId + queue correlation.",
        url: `https://dash.cloudflare.com/${acc}/workers/services/view/${encodeURIComponent(workerService().trim())}/production/observability/logs`,
      },
      {
        title: "D1 console",
        description: "Inspect / query Agon state (rooms, agents, messages).",
        url: `https://dash.cloudflare.com/${acc}/workers/d1/view/${encodeURIComponent(d1Name().trim())}`,
      },
    ] as const;
  };

  const persist = () => {
    save("agon.cf.accountId", accountId());
    save("agon.cf.queueName", queueName());
    save("agon.cf.workerService", workerService());
    save("agon.cf.d1Name", d1Name());
  };

  return (
    <div>
      <h1>Metrics & Observability</h1>
      <p style={{ "margin-bottom": "2rem", color: "var(--text-muted)" }}>
        Agon uses Cloudflare’s native infrastructure for queues, logs, and D1. This page
        intentionally does not replicate Cloudflare dashboards — it just gives you the right links
        and what to look for.
      </p>

      <div class="card" style={{ "margin-bottom": "2rem" }}>
        <h3>Cloudflare links config</h3>
        <div class="form-group">
          <label>Account ID</label>
          <input
            class="form-control"
            value={accountId()}
            onInput={(e) => setAccountId(e.currentTarget.value)}
          />
        </div>
        <div class="form-group">
          <label>Worker service</label>
          <input
            class="form-control"
            value={workerService()}
            onInput={(e) => setWorkerService(e.currentTarget.value)}
          />
        </div>
        <div class="form-group">
          <label>Queue name</label>
          <input
            class="form-control"
            value={queueName()}
            onInput={(e) => setQueueName(e.currentTarget.value)}
          />
        </div>
        <div class="form-group">
          <label>D1 database name</label>
          <input
            class="form-control"
            value={d1Name()}
            onInput={(e) => setD1Name(e.currentTarget.value)}
          />
        </div>

        <button class="btn btn-primary" onClick={persist}>
          Save
        </button>

        <Show when={!accountId().trim()}>
          <p style={{ "margin-top": "1rem", color: "var(--text-muted)" }}>
            Enter your Cloudflare account id to enable the links below.
          </p>
        </Show>
      </div>

      <div
        style={{
          display: "grid",
          "grid-template-columns": "repeat(auto-fit, minmax(300px, 1fr))",
          gap: "1.5rem",
        }}
      >
        {links().map((link) => (
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
        style={{ "margin-top": "2rem", "background-color": "#fffbeb", "border-color": "#fef3c7" }}
      >
        <h4 style={{ color: "#92400e", "margin-top": 0 }}>What to look for</h4>
        <ul style={{ color: "#92400e", "font-size": "0.9375rem" }}>
          <li>
            <strong>Queue backlog growing?</strong> Check worker logs for rate limits / failures,
            and queue consumer errors.
          </li>
          <li>
            <strong>Turn loop stuck?</strong> Look at room state in D1: rooms.currentTurnNumber vs
            rooms.lastEnqueuedTurnNumber.
          </li>
          <li>
            <strong>Discord issues?</strong> Filter logs by requestId / queueMessageId and look for
            discord.sync / discord.webhook spans.
          </li>
        </ul>
      </div>
    </div>
  );
}
