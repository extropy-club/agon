import { createVirtualizer } from "@tanstack/solid-virtual";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
} from "solid-js";
import { agentsApi, type GetMemoriesParams, type MemoryItem } from "../api";
import MemoryCard from "./MemoryCard";

export interface AgentMemoriesProps {
  agentId: string;
}

type SourceFilter = "all" | "auto" | "agent";

const LIMIT = 40;

function VirtualMemoryList(props: {
  readonly items: readonly MemoryItem[];
  readonly canLoadMore: boolean;
  readonly loading: boolean;
  readonly onLoadMore: () => void;
}) {
  // eslint-disable-next-line no-unassigned-vars -- assigned via JSX ref
  let scrollRef!: HTMLDivElement;

  const virtualizer = createVirtualizer({
    get count() {
      return props.items.length;
    },
    getScrollElement: () => scrollRef,
    estimateSize: () => 140,
    overscan: 6,
  });

  const maybeAutoLoadMore = () => {
    if (!props.canLoadMore || props.loading) return;
    if (!scrollRef) return;

    // when the user scrolls near the end, prefetch the next page
    const thresholdPx = 300;
    if (scrollRef.scrollTop + scrollRef.clientHeight >= scrollRef.scrollHeight - thresholdPx) {
      props.onLoadMore();
    }
  };

  return (
    <div
      ref={scrollRef}
      onScroll={maybeAutoLoadMore}
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
            const memory = () => props.items[vItem.index];
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
                  padding: "0.5rem 0",
                }}
              >
                <Show when={memory()}>
                  {(m) => (
                    <MemoryCard
                      memory={m()}
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
  );
}

export default function AgentMemories(props: AgentMemoriesProps) {
  const [queryInput, setQueryInput] = createSignal("");
  const [debouncedQuery, setDebouncedQuery] = createSignal("");
  const [sourceFilter, setSourceFilter] = createSignal<SourceFilter>("all");

  const sourceParam = createMemo<GetMemoriesParams["source"]>(() => {
    const s = sourceFilter();
    if (s === "all") return undefined;
    return s;
  });

  // Debounce search input (FTS5 query is sanitized server-side to the same format used in debates)
  createEffect(() => {
    const q = queryInput();
    const t = setTimeout(() => setDebouncedQuery(q.trim()), 400);
    onCleanup(() => clearTimeout(t));
  });

  const [offset, setOffset] = createSignal(0);
  const [items, setItems] = createSignal<readonly MemoryItem[]>([]);
  const [hasMore, setHasMore] = createSignal(false);
  const [totalCount, setTotalCount] = createSignal<number | null>(null);

  // Reset pagination when filters change
  createEffect(() => {
    // Reset when agent/filter/search changes
    const _key = `${props.agentId}|${debouncedQuery()}|${sourceParam() ?? ""}`;
    void _key;

    setOffset(0);
    setItems([]);
    setHasMore(false);
    setTotalCount(null);
  });

  const requestKey = createMemo(() => {
    return {
      agentId: props.agentId,
      q: debouncedQuery().length > 0 ? debouncedQuery() : undefined,
      source: sourceParam(),
      offset: offset(),
      limit: LIMIT,
    } as const;
  });

  const [page] = createResource(requestKey, (key) =>
    agentsApi.getMemories(key.agentId, {
      q: key.q,
      source: key.source,
      offset: key.offset,
      limit: key.limit,
    }),
  );

  createEffect(() => {
    const p = page();
    if (!p) return;

    setHasMore(p.hasMore);
    setTotalCount(p.totalCount);

    if (offset() === 0) {
      setItems(p.items);
    } else {
      setItems((prev) => [...prev, ...p.items]);
    }
  });

  const loadMore = () => {
    if (page.loading) return;
    if (!hasMore()) return;
    setOffset((o) => o + LIMIT);
  };

  return (
    <section class="card">
      <div
        style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "space-between",
          gap: "1rem",
          "margin-bottom": "1rem",
          "flex-wrap": "wrap",
        }}
      >
        <h3 style={{ margin: 0 }}>Memories</h3>

        <Show when={totalCount() != null}>
          <div style={{ color: "var(--text-muted)", "font-size": "0.875rem" }}>
            {totalCount()} result{totalCount() === 1 ? "" : "s"}
          </div>
        </Show>
      </div>

      <div
        style={{
          display: "flex",
          gap: "0.75rem",
          "align-items": "center",
          "margin-bottom": "1rem",
          "flex-wrap": "wrap",
        }}
      >
        <input
          class="form-control"
          style={{ flex: 1, "min-width": "240px" }}
          placeholder="Search memories..."
          value={queryInput()}
          onInput={(e) => setQueryInput((e.target as HTMLInputElement).value)}
        />

        <select
          class="form-control"
          style={{ width: "220px" }}
          value={sourceFilter()}
          onChange={(e) => setSourceFilter((e.target as HTMLSelectElement).value as SourceFilter)}
        >
          <option value="all">All</option>
          <option value="auto">Auto-extracted</option>
          <option value="agent">Agent-added</option>
        </select>
      </div>

      <Show
        when={page.error}
        fallback={
          <Show
            when={items().length > 0}
            fallback={
              <Show
                when={page.loading}
                fallback={
                  <p style={{ margin: 0, color: "var(--text-muted)" }}>No memories found.</p>
                }
              >
                <p style={{ margin: 0, color: "var(--text-muted)" }}>Loading memories...</p>
              </Show>
            }
          >
            <VirtualMemoryList
              items={items()}
              canLoadMore={hasMore()}
              loading={page.loading}
              onLoadMore={loadMore}
            />

            <Show when={hasMore()}>
              <div
                style={{
                  display: "flex",
                  "justify-content": "center",
                  "margin-top": "1rem",
                }}
              >
                <button class="btn" disabled={page.loading} onClick={loadMore}>
                  {page.loading ? "Loading..." : "Load more"}
                </button>
              </div>
            </Show>
          </Show>
        }
      >
        <div class="card" style={{ padding: "1rem" }}>
          <strong>Error:</strong> {String(page.error)}
        </div>
      </Show>
    </section>
  );
}
