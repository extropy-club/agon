import type * as Prompt from "@effect/ai/Prompt";

export type TextPartLike = { readonly type: "text"; readonly text: string };

type Encoder = {
  readonly encode: (text: string) => { readonly length: number } | ReadonlyArray<unknown>;
};

const isEncoder = (u: unknown): u is Encoder => {
  if (typeof u !== "object" || u === null) return false;
  const candidate = u as { readonly encode?: unknown };
  return typeof candidate.encode === "function";
};

/**
 * Best-effort token counting.
 *
 * - If a tiktoken/js-tiktoken encoder is available on `globalThis`, use it.
 * - Otherwise, fall back to a conservative heuristic.
 */
let globalEncoder: Encoder | null | undefined = undefined;

const resolveGlobalEncoder = (): Encoder | null => {
  if (globalEncoder !== undefined) return globalEncoder ?? null;

  const g = globalThis as unknown as Record<string, unknown>;

  const candidates: ReadonlyArray<unknown> = [
    // common ad-hoc patterns
    g["__agonTiktokenEncoder"],
    g["tiktokenEncoder"],
    g["__tiktokenEncoder"],
    // module-like globals (if user wires it up)
    g["tiktoken"],
    g["jsTiktoken"],
    // last resort: check top-level namespace
    g,
  ];

  for (const c of candidates) {
    if (!c) continue;

    // already an encoder
    if (isEncoder(c)) {
      globalEncoder = c;
      return globalEncoder;
    }

    if (typeof c !== "object" || c === null) continue;
    const m = c as {
      readonly getEncoding?: unknown;
      readonly get_encoding?: unknown;
    };

    // js-tiktoken style: getEncoding("cl100k_base")
    if (typeof m.getEncoding === "function") {
      try {
        const enc = (m.getEncoding as (name: string) => unknown)("cl100k_base");
        if (isEncoder(enc)) {
          globalEncoder = enc;
          return globalEncoder;
        }
      } catch {
        // ignore
      }
    }

    // @dqbd/tiktoken style: get_encoding("cl100k_base")
    if (typeof m.get_encoding === "function") {
      try {
        const enc = (m.get_encoding as (name: string) => unknown)("cl100k_base");
        if (isEncoder(enc)) {
          globalEncoder = enc;
          return globalEncoder;
        }
      } catch {
        // ignore
      }
    }
  }

  globalEncoder = null;
  return null;
};

const safeJson = (u: unknown): string => {
  try {
    return JSON.stringify(u);
  } catch {
    return "";
  }
};

type PartLike = {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly fileName?: unknown;
  readonly name?: unknown;
  readonly params?: unknown;
  readonly result?: unknown;
};

const partToText = (part: unknown): string => {
  if (typeof part !== "object" || part === null) return "";
  const p = part as PartLike;

  switch (p.type) {
    case "text":
    case "reasoning":
      return typeof p.text === "string" ? p.text : "";
    case "file":
      return typeof p.fileName === "string" && p.fileName.length > 0
        ? `[file:${p.fileName}]`
        : "[file]";
    case "tool-call":
      return `${typeof p.name === "string" ? p.name : "tool"} ${safeJson(p.params)}`;
    case "tool-result":
      return `${typeof p.name === "string" ? p.name : "tool"} ${safeJson(p.result)}`;
    default:
      return safeJson(part);
  }
};

/**
 * Estimate token count for a string.
 */
export const countTokens = (text: string): number => {
  if (text.length === 0) return 0;

  const encoder = resolveGlobalEncoder();
  if (encoder) {
    try {
      const encoded = encoder.encode(text);
      const len = (encoded as { readonly length?: unknown }).length;
      if (typeof len === "number") return len;
    } catch {
      // ignore and fall back
    }
  }

  // Heuristic fallback (conservative):
  // - ~3 chars/token avoids undercounting dense/CJK text.
  // - words * 1.5 covers short-token / punctuation-heavy text.
  const byChars = Math.ceil(text.length / 3);
  const words = text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
  const byWords = Math.ceil(words * 1.5);

  return Math.max(1, byChars, byWords);
};

export const truncateAudienceParts = <P extends TextPartLike>(
  parts: ReadonlyArray<P>,
  tokenLimit: number,
): { parts: Array<P>; truncated: boolean } => {
  if (tokenLimit <= 0) {
    return { parts: [], truncated: parts.length > 0 };
  }

  const tokensPerPart = parts.map((p) => countTokens(p.text));
  let total = tokensPerPart.reduce((a, b) => a + b, 0);

  if (total <= tokenLimit) {
    return { parts: [...parts], truncated: false };
  }

  let start = 0;
  while (start < parts.length && total > tokenLimit) {
    total -= tokensPerPart[start] ?? 0;
    start += 1;
  }

  return {
    parts: parts.slice(start),
    truncated: start > 0,
  };
};

const countTokensForMessage = (message: Prompt.MessageEncoded): number => {
  const { content } = message;
  if (typeof content === "string") return countTokens(content);

  // All encoded message variants use arrays for structured content.
  if (Array.isArray(content)) {
    let sum = 0;
    for (const part of content) {
      sum += countTokens(partToText(part));
    }
    return sum;
  }

  return 0;
};

/**
 * Sum tokens across all messages and return `true` if the room should stop.
 */
export const checkRoomTokenLimit = (
  messages: ReadonlyArray<Prompt.MessageEncoded>,
  roomTokenLimit: number,
): boolean => {
  if (roomTokenLimit <= 0) return true;

  let total = 0;
  for (const m of messages) {
    total += countTokensForMessage(m);
    if (total >= roomTokenLimit) return true;
  }

  return false;
};
