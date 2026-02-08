import type { Agent } from "../api";

export default function AgentOverview(props: { agent: Agent }) {
  const a = () => props.agent;

  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "1.5rem" }}>
      <section class="card">
        <h3>Details</h3>
        <p>
          <strong>ID:</strong> {a().id}
        </p>
        <p>
          <strong>Name:</strong> {a().name}
        </p>
        <p>
          <strong>Provider:</strong> {a().llmProvider}
        </p>
        <p>
          <strong>Model:</strong> {a().llmModel}
        </p>
      </section>

      <section class="card">
        <h3>Generation Params</h3>
        <p>
          <strong>Temperature:</strong> {a().temperature ?? "(default)"}
        </p>
        <p>
          <strong>Max Tokens:</strong> {a().maxTokens ?? "(default)"}
        </p>
        <p>
          <strong>Thinking Level:</strong> {a().thinkingLevel ?? "(default)"}
        </p>
        <p>
          <strong>Thinking Budget Tokens:</strong> {a().thinkingBudgetTokens ?? "(default)"}
        </p>
      </section>

      <section class="card">
        <h3>System Prompt</h3>
        <pre
          style={{
            margin: 0,
            "white-space": "pre-wrap",
            "word-break": "break-word",
            "font-family":
              "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
            "font-size": "0.9rem",
            color: "var(--text)",
          }}
        >
          {a().systemPrompt}
        </pre>
      </section>
    </div>
  );
}
