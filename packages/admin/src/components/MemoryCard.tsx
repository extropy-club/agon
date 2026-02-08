import { A } from "@solidjs/router";
import { Show, createSignal } from "solid-js";
import type { MemoryItem } from "../api";

export type MemoryCardProps = {
  readonly memory: MemoryItem;
  /** Call when height changes so a parent virtualizer can re-measure. */
  readonly onResize?: () => void;
};

const sourceLabel = (createdBy: MemoryItem["createdBy"]): string => {
  if (createdBy === "auto") return "Auto-extracted";
  if (createdBy === "agent") return "Agent-added";
  return String(createdBy);
};

export default function MemoryCard(props: MemoryCardProps) {
  const [expanded, setExpanded] = createSignal(false);

  const toggle = () => {
    setExpanded(!expanded());
    requestAnimationFrame(() => props.onResize?.());
  };

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        "border-radius": "0.5rem",
        padding: "1rem",
        "background-color": "var(--card-bg)",
        "box-shadow": "0 1px 2px 0 rgb(0 0 0 / 0.05)",
      }}
    >
      <div
        style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "space-between",
          gap: "0.75rem",
          "margin-bottom": "0.5rem",
          "flex-wrap": "wrap",
        }}
      >
        <div style={{ display: "flex", "align-items": "center", gap: "0.5rem" }}>
          <A href={`/rooms/${props.memory.roomId}`}>
            {props.memory.roomTitle || `Room #${props.memory.roomId}`}
          </A>
          <span style={{ color: "var(--text-muted)", "font-size": "0.875rem" }}>
            {new Date(props.memory.createdAtMs).toLocaleString()}
          </span>
        </div>

        <span class="badge badge-info">{sourceLabel(props.memory.createdBy)}</span>
      </div>

      <div
        onClick={toggle}
        style={{
          cursor: "pointer",
          "white-space": "pre-wrap",
          "word-break": "break-word",
          ...(expanded()
            ? {}
            : {
                display: "-webkit-box",
                "-webkit-line-clamp": 4,
                "-webkit-box-orient": "vertical",
                overflow: "hidden",
              }),
        }}
      >
        {props.memory.content}
      </div>

      <Show when={!expanded()}>
        <div style={{ "margin-top": "0.5rem", color: "var(--text-muted)", "font-size": "0.8rem" }}>
          Click to expand
        </div>
      </Show>
    </div>
  );
}
