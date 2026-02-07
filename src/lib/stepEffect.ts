import { Cause, Exit, Option, type Effect } from "effect";
import { type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Runtime } from "../runtime.js";

export type StepConfig = WorkflowStepConfig;

const errorTag = (e: unknown): string => {
  if (typeof e === "object" && e !== null && "_tag" in e) {
    const t = (e as { readonly _tag?: unknown })._tag;
    if (typeof t === "string") return t;
  }
  return "Unknown";
};

const formatError = (e: unknown): string => {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (typeof e === "string") return e;
  if (typeof e === "object" && e !== null) {
    const tag = errorTag(e);
    const msg = (e as { readonly message?: unknown }).message;
    if (typeof msg === "string" && msg.length > 0) return `${tag}: ${msg}`;
    try {
      return `${tag}: ${JSON.stringify(e)}`;
    } catch {
      return tag;
    }
  }
  return String(e);
};

const defaultIsRetryable = (e: unknown): boolean => {
  const tag = errorTag(e);
  return tag === "LlmCallFailed" || tag === "DiscordRateLimited" || tag === "DiscordApiError";
};

/**
 * Run an Effect inside a Cloudflare Workflows step, mapping typed failures to
 * retryable vs non-retryable workflow errors.
 */
export const stepEffect = async <A, E>(
  runtime: Runtime,
  step: WorkflowStep,
  name: string,
  config: StepConfig,
  effect: Effect.Effect<A, E, unknown>,
  isRetryable: (e: unknown) => boolean = defaultIsRetryable,
): Promise<A> =>
  step.do(name, config, async (): Promise<Rpc.Serializable<A>> => {
    const exit = await runtime.runPromiseExit(effect as unknown as Effect.Effect<A, E, never>);

    if (Exit.isSuccess(exit)) {
      return exit.value as Rpc.Serializable<A>;
    }

    const failure = Cause.failureOption(exit.cause);
    if (Option.isSome(failure)) {
      const e = failure.value as unknown;
      const message = formatError(e);

      if (isRetryable(e)) {
        // Throwing a normal Error triggers workflow step retries.
        throw new Error(message);
      }

      // Typed failures that are non-retryable.
      throw new NonRetryableError(message);
    }

    // Defects / interruptions should not be retried (they indicate bugs or cancellation).
    const defect = Cause.dieOption(exit.cause);
    if (Option.isSome(defect)) {
      throw new NonRetryableError(`Defect: ${formatError(defect.value)}`);
    }

    const interrupted = Cause.interruptOption(exit.cause);
    if (Option.isSome(interrupted)) {
      throw new NonRetryableError("Interrupted");
    }

    throw new NonRetryableError(`Unhandled Cause: ${String(exit.cause)}`);
  }) as unknown as Promise<A>;
